// Lightsail 電源操作與即時狀態：對應 EC2 的 power.js 職責。
// Lightsail 走 JSON 1.1（lightsailQuery），狀態由 GetInstances 一次取得，
// 不像 EC2 需要逐區批次 DescribeInstances；因此 Lightsail 機器不會拖累
// 同地區的 EC2 查詢，反之亦然。
import { AwsRequestError, lightsailQuery } from "./aws-lightsail.js";

const STATE_QUERY_FAILED = "查詢失敗";
const STATE_NOT_FOUND = "未找到";

/** Lightsail 的 state.name（running/stopped/pending/stopping）直接沿用。 */
const POWER_API_ACTIONS = {
  start: "StartInstance",
  stop: "StopInstance",
  reboot: "RebootInstance",
  terminate: "DeleteInstance",
};

/**
 * 對單一 Lightsail 執行個體送出電源操作。
 * 僅接受 start|stop|reboot|terminate；terminate 對應 DeleteInstance（不可逆）。
 * @param {object} env 已注入 AWS 憑證的執行環境
 * @param {{ region: string, instanceId: string }} machine
 * @param {"start" | "stop" | "reboot" | "terminate"} action
 */
export async function performLightsailPowerAction(env, machine, action) {
  const operation = POWER_API_ACTIONS[action];
  if (!operation) {
    throw new Error("Unsupported action");
  }
  await lightsailQuery(machine.region, env, operation, {
    instanceName: machine.instanceId,
  });
  return { ok: true, action };
}

/** 取出 GetInstances 回應中的執行個體陣列。 */
function readInstances(response) {
  return Array.isArray(response?.instances) ? response.instances : [];
}

/**
 * 列出指定地區的 Lightsail 執行個體，供「新增機器」挑選。
 * @returns {Promise<Array<{instanceId:string, name:string, state:string, publicIpAddress:string, ipv6Address:string}>>}
 */
export async function listLightsailInstances(env, region) {
  const instances = readInstances(
    await lightsailQuery(region, env, "GetInstances", {}),
  );
  return instances
    .map(instance => ({
      instanceId: String(instance.name || ""),
      name: String(instance.name || ""),
      state: String(instance.state?.name || ""),
      publicIpAddress: String(instance.publicIpAddress || ""),
      ipv6Address: Array.isArray(instance.ipv6Addresses) ? (instance.ipv6Addresses[0] || "") : "",
    }))
    .filter(instance => instance.instanceId)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 合併 Lightsail 機器清單與 GetInstances 的即時狀態。
 * 回傳列順序與傳入清單一致；整區查詢失敗時該區標示「查詢失敗」，
 * 回應中缺席的執行個體標示「未找到」。欄位形狀與 EC2 的
 * mergeMachineStates 對齊（state / publicIpAddress / ipv6Address），
 * 讓前端表格可共用。
 * @param {object} env 已注入 AWS 憑證的執行環境
 * @param {Array<{id:number, region:string, instanceId:string, name:string}>} machines
 */
export async function mergeLightsailStates(env, machines) {
  const byRegion = new Map();
  for (const machine of machines) {
    const items = byRegion.get(machine.region) || [];
    items.push(machine);
    byRegion.set(machine.region, items);
  }

  const failedRegions = new Set();
  const liveByKey = new Map();
  await Promise.all([...byRegion.keys()].map(async region => {
    try {
      const instances = readInstances(
        await lightsailQuery(region, env, "GetInstances", {}),
      );
      for (const instance of instances) {
        liveByKey.set(`${region}\u0000${instance.name}`, {
          state: String(instance.state?.name || ""),
          publicIpAddress: String(instance.publicIpAddress || ""),
          ipv6Address: Array.isArray(instance.ipv6Addresses) ? (instance.ipv6Addresses[0] || "") : "",
        });
      }
    } catch {
      failedRegions.add(region);
    }
  }));

  return machines.map((machine) => {
    if (failedRegions.has(machine.region)) {
      return {
        ...machine,
        state: STATE_QUERY_FAILED,
        publicDnsName: STATE_QUERY_FAILED,
        publicIpAddress: STATE_QUERY_FAILED,
        ipv6Address: STATE_QUERY_FAILED,
      };
    }
    const live = liveByKey.get(`${machine.region}\u0000${machine.instanceId}`);
    if (!live) {
      return {
        ...machine,
        state: STATE_NOT_FOUND,
        publicDnsName: STATE_NOT_FOUND,
        publicIpAddress: STATE_NOT_FOUND,
        ipv6Address: STATE_NOT_FOUND,
      };
    }
    return {
      ...machine,
      name: machine.name || machine.instanceId,
      state: live.state,
      // Lightsail 沒有 EC2 風格的公用 DNS 名稱，留空避免前端誤用
      publicDnsName: "",
      publicIpAddress: live.publicIpAddress,
      ipv6Address: live.ipv6Address,
    };
  });
}

// ─── 換 IP（v4）與 IPv6 輪換 ────────────────────────────────

function quotaDelay(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

/** 輪詢執行個體狀態（stop/start 後等待）。 */
async function pollInstanceState(env, region, instanceName, targetStates, maxAttempts = 40) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await quotaDelay(3_000);
    const response = await lightsailQuery(region, env, "GetInstance", { instanceName });
    const state = String(response?.instance?.state?.name || "");
    if (targetStates.includes(state)) {
      return state;
    }
    if (state === "terminated") {
      throw new AwsRequestError("執行個體已終止。", 409);
    }
  }
  throw new AwsRequestError(`等待執行個體狀態逾時（已嘗試 ${maxAttempts} 次）。`, 504);
}

/**
 * 更換 Lightsail 執行個體的公網 IPv4，並可選同時輪換 IPv6。
 * 行為依 AWS 文件：
 * - 動態公網 IP：stop → start 即換新（停止時釋放、啟動時重配）。
 * - Static IP（部署時以 `<name>-static-ip` 綁定）：stop/start 不換，
 *   須 Detach → Release → Allocate → Attach 重配一個新靜態 IP。
 * - IPv6 無法單獨輪換：以 SetIpAddressType ipv4 → dualstack 切換換發
 *   （v4 位址保留，v6 換新）。
 * @param {object} env 已注入 AWS 憑證的執行環境
 * @param {{ region: string, instanceId: string }} machine
 * @param {{ includeIpv6?: boolean, onProgress?: Function }} [options]
 * @returns {Promise<{ previousIp: string, newIp: string, method: "static-reassign"|"stop-start",
 *   ipv6Rotated: boolean, ipv6Note?: string }>}
 */
export async function rotateLightsailPublicIp(env, machine, { includeIpv6 = false, onProgress } = {}) {
  const { region, instanceId: instanceName } = machine;

  // 判斷是否綁定 Static IP（部署時命名為 <name>-static-ip；亦可能被使用者改名，
  // 故先以 GetStaticIp 探測部署慣用名，找不到則視為使用動態 IP）
  let staticIpName = "";
  let hasStatic = false;
  let previousIp = "";
  try {
    const probe = await lightsailQuery(region, env, "GetStaticIp", { staticIpName: `${instanceName}-static-ip` });
    const staticIp = probe?.staticIp;
    if (staticIp?.attachedTo === instanceName) {
      hasStatic = true;
      staticIpName = String(staticIp.name || "");
      previousIp = String(staticIp.ipAddress || "");
    }
  } catch {
    // NotFound（無此名稱的靜態 IP）→ 使用動態 IP
  }
  if (!previousIp) {
    const response = await lightsailQuery(region, env, "GetInstance", { instanceName });
    previousIp = String(response?.instance?.publicIpAddress || "");
  }

  let newIp = "";
  let method;
  if (hasStatic) {
    // 靜態 IP 重配：Detach → Release → Allocate（同名）→ Attach
    onProgress?.({ stage: "delete", message: "卸離並釋放現有靜態 IP…" });
    await lightsailQuery(region, env, "DetachStaticIp", { staticIpName });
    await lightsailQuery(region, env, "ReleaseStaticIp", { staticIpName });
    onProgress?.({ stage: "create", message: "配置新的靜態 IP…" });
    await lightsailQuery(region, env, "AllocateStaticIp", { staticIpName });
    await lightsailQuery(region, env, "AttachStaticIp", { staticIpName, instanceName });
    // 等待附加生效
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await quotaDelay(2_000);
      const probe = await lightsailQuery(region, env, "GetStaticIp", { staticIpName });
      const ip = String(probe?.staticIp?.ipAddress || "");
      if (ip && ip !== previousIp) {
        newIp = ip;
        break;
      }
    }
    method = "static-reassign";
    if (!newIp) {
      const probe = await lightsailQuery(region, env, "GetStaticIp", { staticIpName });
      newIp = String(probe?.staticIp?.ipAddress || "");
    }
  } else {
    // 動態 IP：stop → 等 stopped → start → 等 running（公網 IP 釋放後重配）
    onProgress?.({ stage: "delete", message: "停止執行個體（釋放動態公網 IP）…" });
    await lightsailQuery(region, env, "StopInstance", { instanceName });
    await pollInstanceState(env, region, instanceName, ["stopped"]);
    onProgress?.({ stage: "create", message: "啟動執行個體（配置新公網 IP）…" });
    await lightsailQuery(region, env, "StartInstance", { instanceName });
    await pollInstanceState(env, region, instanceName, ["running"]);
    const response = await lightsailQuery(region, env, "GetInstance", { instanceName });
    newIp = String(response?.instance?.publicIpAddress || "");
    method = "stop-start";
  }

  // IPv6 輪換：ipAddressType ipv4 → dualstack（v4 保留、v6 換新）
  let ipv6Rotated = false;
  let ipv6Note;
  if (includeIpv6) {
    onProgress?.({ stage: "ipv6", message: "以 ipAddressType 切換輪換 IPv6 位址…" });
    await lightsailQuery(region, env, "SetIpAddressType", {
      resourceType: "Instance",
      resourceName: instanceName,
      ipAddressType: "ipv4",
    });
    await lightsailQuery(region, env, "SetIpAddressType", {
      resourceType: "Instance",
      resourceName: instanceName,
      ipAddressType: "dualstack",
    });
    ipv6Rotated = true;
    ipv6Note = "IPv6 已透過 ipAddressType 切換輪換（Lightsail 無法單獨指定位址）。";
  }

  if (!newIp) {
    throw new AwsRequestError("更換 IP 後未取得新的公網 IP，請稍後重新整理確認。", 502);
  }
  return { previousIp, newIp, method, ipv6Rotated, ipv6Note };
}
