// Lightsail 電源操作與即時狀態：對應 EC2 的 power.js 職責。
// Lightsail 走 JSON 1.1（lightsailQuery），狀態由 GetInstances 一次取得，
// 不像 EC2 需要逐區批次 DescribeInstances；因此 Lightsail 機器不會拖累
// 同地區的 EC2 查詢，反之亦然。
import { lightsailQuery } from "./aws-lightsail.js";

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
