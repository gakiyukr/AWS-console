// 電源管理業務邏輯：移植自 ec2-power-console，AWS 請求改經共用的
// ec2Query（SigV4 + 30 秒逾時）。純函式與 AWS 互動集中於此模組，
// 路由檔僅負責輸入驗證與 D1 存取。
import { ec2Query } from "./aws-query.js";
import { parseInstanceDescription } from "./ec2-xml.js";

// 地區查詢失敗或執行個體自回應中消失時，狀態欄位的降級顯示值；
// 前端直接呈現，用於提醒清單資料可能過期，而非反映真實電源狀態。
const STATE_QUERY_FAILED = "查詢失敗";
const STATE_NOT_FOUND = "未找到";

function findTagValue(xml, tagName) {
  return xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`))?.[1] || "";
}

function findAllTagValues(xml, tagName) {
  return [...xml.matchAll(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, "g"))].map(
    (match) => match[1],
  );
}

/**
 * 自 EC2 公網 DNS 主機名稱推導公網 IP。
 * Wavelength 執行個體使用 carrier IP，DescribeInstances 回應不含
 * ipAddress 欄位，只能由 DNS 反推；非 compute 網域或任一段大於
 * 255 時視為無法推導，回空字串。
 */
function deriveIpFromPublicDns(publicDnsName) {
  const match = String(publicDnsName || "").match(
    /^ec2-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.[a-z0-9-]+\.compute(?:-1)?\.amazonaws\.com(?:\.cn)?$/i,
  );
  if (!match) {
    return "";
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return "";
  }
  return octets.join(".");
}

/**
 * 自 XML 片段取出 AWS Name 標籤值。
 * 先比對標準 key/value 結構，失敗時退回片段中第一個 value 標籤
 * （相容部分回應省略 key 的形態）。
 */
function extractAwsNameTag(xml) {
  const named = xml.match(/<item>\s*<key>Name<\/key>\s*<value>([^<]*)<\/value>\s*<\/item>/);
  if (named) {
    return named[1];
  }
  return findAllTagValues(xml, "value")[0] || "";
}

/**
 * 解析 DescribeInstances 回應中的執行個體項目。
 * 以 instanceId 出現位置切段、各段獨立取值，避免跨執行個體欄位混淆；
 * 同時偵測「有 DNS 但無 ipAddress 且可推導 IP」的 Wavelength 形態。
 */
function parseDescribeInstancesXmlItems(xml) {
  const instanceMatches = [...xml.matchAll(/<instanceId>([^<]*)<\/instanceId>/g)];
  return instanceMatches.map((match, index) => {
    const nextMatch = instanceMatches[index + 1];
    const segment = xml.slice(match.index, nextMatch?.index ?? xml.length);
    const publicDnsName = findTagValue(segment, "dnsName");
    const awsPublicIpAddress = findTagValue(segment, "ipAddress");
    const derivedPublicIpAddress = deriveIpFromPublicDns(publicDnsName);
    // Wavelength Zone 的 ZoneId 固定含 -wl 段，即使尚未取得公網 DNS
    // 也能由此判定；與 DNS 形態判斷互補，兩者任一成立即視為 Wavelength。
    const zoneId = findTagValue(segment, "zoneId");
    const isWlInstance = Boolean(
      (publicDnsName && !awsPublicIpAddress && derivedPublicIpAddress)
      || zoneId.includes("-wl"),
    );
    return {
      instanceId: match[1],
      state: findTagValue(segment, "name"),
      publicDnsName,
      publicIpAddress: awsPublicIpAddress || derivedPublicIpAddress,
      isWlInstance,
      awsNameTag: extractAwsNameTag(segment),
    };
  });
}

/** 將 DescribeInstances 回應轉為 instanceId → 項目的查找表（忽略空 ID）。 */
function parseDescribeInstancesXml(xml) {
  const lookup = new Map();
  for (const item of parseDescribeInstancesXmlItems(xml)) {
    if (item.instanceId) {
      lookup.set(item.instanceId, item);
    }
  }
  return lookup;
}

/** 依地區分組並按地區名排序，供批次查詢使用；項目以複本回傳避免污染來源陣列。 */
function buildRegionGroups(machines) {
  const grouped = new Map();
  for (const machine of machines) {
    const items = grouped.get(machine.region) || [];
    items.push({ ...machine });
    grouped.set(machine.region, items);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([region, items]) => ({ region, items }));
}

// 單次 DescribeInstances 最多接受 100 個 InstanceId 參數；
// 本主控台為個人規模清單，不做分批，單一地區超出上限時整體回報查詢失敗。

/**
 * 對單一地區發出一筆批次 DescribeInstances。
 * 地區層級的憑證或網路問題不應拖垮其他地區的顯示，
 * 因此任何錯誤都降級為 { ok: false }，由呼叫端統一標示降級狀態。
 */
async function describeRegionBatch(env, region, items) {
  const params = Object.fromEntries(
    items.map((item, index) => [`InstanceId.${index + 1}`, item.instanceId]),
  );
  try {
    const xml = await ec2Query(region, env, "DescribeInstances", params);
    return { ok: true, lookup: parseDescribeInstancesXml(xml) };
  } catch {
    return { ok: false, lookup: null };
  }
}

/**
 * 合併 D1 機器清單與各地區批次 DescribeInstances 的即時狀態。
 * 回傳列順序與傳入清單一致；地區查詢失敗時該地區全部標示
 * 「查詢失敗」，成功回應中缺席的執行個體標示「未找到」。
 * 名稱優先序沿用原版：清單名稱 → AWS Name 標籤 → 執行個體 ID。
 */
export async function mergeMachineStates(env, machines) {
  const groups = buildRegionGroups(machines);
  const batches = await Promise.all(
    groups.map(({ region, items }) => describeRegionBatch(env, region, items)),
  );

  const failedRegions = new Set();
  const liveByKey = new Map();
  batches.forEach((batch, index) => {
    const { region } = groups[index];
    if (!batch.ok) {
      failedRegions.add(region);
      return;
    }
    for (const [instanceId, item] of batch.lookup) {
      // 金鑰含地區前綴：不同地區理論上不會重複 ID，但明確區隔以防混淆
      liveByKey.set(`${region}\u0000${instanceId}`, item);
    }
  });

  return machines.map((machine) => {
    if (failedRegions.has(machine.region)) {
      return {
        ...machine,
        state: STATE_QUERY_FAILED,
        publicDnsName: STATE_QUERY_FAILED,
        publicIpAddress: STATE_QUERY_FAILED,
      };
    }
    const live = liveByKey.get(`${machine.region}\u0000${machine.instanceId}`);
    if (!live) {
      return {
        ...machine,
        state: STATE_NOT_FOUND,
        publicDnsName: STATE_NOT_FOUND,
        publicIpAddress: STATE_NOT_FOUND,
      };
    }
    return {
      ...machine,
      name: machine.name || live.awsNameTag || machine.instanceId,
      state: live.state,
      publicDnsName: live.publicDnsName,
      publicIpAddress: live.publicIpAddress,
      isWavelength: Boolean(machine.isWavelength || live.isWlInstance),
    };
  });
}

/**
 * 列出單一地區的全部執行個體，供「新增機器」挑選既有機器使用。
 * DescribeInstances 預設即排除 terminated，此處再過濾 shutting-down，
 * 讓挑選器不出現即將消失的執行個體；AWS 錯誤直接拋出，由路由層轉換。
 */
export async function listRegionInstances(env, region) {
  const xml = await ec2Query(region, env, "DescribeInstances", {});
  return parseDescribeInstancesXmlItems(xml)
    .filter(item => item.instanceId && item.state !== "shutting-down" && item.state !== "terminated")
    .map(item => ({
      instanceId: item.instanceId,
      name: item.awsNameTag,
      state: item.state,
      isWavelength: item.isWlInstance,
    }))
    .sort((left, right) => (left.name || left.instanceId).localeCompare(right.name || right.instanceId));
}

/**
 * 對單一機器送出電源操作。僅接受 start|stop|reboot|terminate，其餘動作
 * 一律拒絕，避免任意 Action 字串注入 AWS API。terminate 為不可逆操作，
 * 呼叫端須自行確保已取得使用者確認，並在成功後清理 D1 清單記錄。
 */
const POWER_API_ACTIONS = {
  start: "StartInstances",
  stop: "StopInstances",
  reboot: "RebootInstances",
  terminate: "TerminateInstances",
};

export async function performPowerAction(env, machine, action) {
  const apiAction = POWER_API_ACTIONS[action];
  if (!apiAction) {
    throw new Error("Unsupported action");
  }
  await ec2Query(
    machine.region,
    env,
    apiAction,
    { "InstanceId.1": machine.instanceId },
  );
  return { ok: true, action };
}

// ─── 更換公網 IP（stop → 輪詢 stopped → start） ─────────────

// 輪詢等待執行個體進入 stopped：StopInstances 通常 20–60 秒，
// 以 3 秒間隔最多 30 次（90 秒）覆蓋常見情境，避免過早 StartInstances 失敗。
const STOP_POLL_INTERVAL_MS = 3_000;
const STOP_POLL_MAX_ATTEMPTS = 30;

// 啟動後輪詢新公網 IP 的上限。單次 Worker 呼叫的子請求總數
// （1 預檢 + 1 stop + 30 stop 輪詢 + 1 start + 15 IP 輪詢 = 48）須低於
// Cloudflare 免費方案的 50 上限；取不到時由呼叫端提示稍後自行重新整理。
const NEW_IP_POLL_INTERVAL_MS = 3_000;
const NEW_IP_POLL_MAX_ATTEMPTS = 15;

function delay(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

async function describeInstance(region, env, instanceId) {
  const xml = await ec2Query(region, env, "DescribeInstances", {
    "InstanceId.1": instanceId,
  });
  return parseInstanceDescription(xml);
}

async function waitForInstanceStopped(region, env, instanceId, onProgress) {
  for (let attempt = 1; attempt <= STOP_POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(STOP_POLL_INTERVAL_MS);
    const instance = await describeInstance(region, env, instanceId);
    if (instance.instanceId === instanceId && instance.state === "stopped") {
      return true;
    }
    onProgress("waiting_stopped", { attempt });
  }
  return false;
}

/** 啟動後輪詢新公網 IP；Wavelength 執行個體自公網 DNS 反推。 */
async function waitForNewPublicIp(machine, env, onProgress) {
  for (let attempt = 1; attempt <= NEW_IP_POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(NEW_IP_POLL_INTERVAL_MS);
    const instance = await describeInstance(machine.region, env, machine.instanceId);
    if (instance.instanceId !== machine.instanceId) {
      continue;
    }
    const ipAddress = instance.publicIpAddress || deriveIpFromPublicDns(instance.publicDnsName);
    if (ipAddress) {
      onProgress("completed", { ip: ipAddress });
      return ipAddress;
    }
    onProgress("waiting_ip", { attempt });
  }
  return null;
}

/**
 * 更換機器公網 IP：預檢 running → stop → 輪詢 stopped → start。
 * 由 reboot-ip 路由與公開分享頁共用；進度經 onProgress(stage, details)
 * 回報（stage 與前端標籤表對齊），不需要進度的呼叫端省略即可。
 *
 * 失敗時若尚未送出 start，先補償性 start 盡量讓機器恢復運行，再拋出
 * 帶 statusCode（預檢 409 時可直接映射 HTTP）與 precheck／stopRequested／
 * recoveryRequested 旗標的錯誤，供呼叫端以 rotateIpFailureMessage 組訊息。
 * @param {unknown} env 已注入 AWS 憑證的執行環境（awsEnv）
 * @param {{ region: string, instanceId: string }} machine
 * @param {{ onProgress?: (stage: string, details?: Record<string, unknown>) => void,
 *   waitForNewIp?: boolean }} [options] waitForNewIp：啟動後輪詢新公網 IP
 * @returns {Promise<{ newIpAddress: string | null }>}
 */
export async function rotatePublicIp(env, machine, { onProgress = () => {}, waitForNewIp = false } = {}) {
  let stopRequested = false;
  let recoveryRequested = false;
  try {
    onProgress("pre_check", {});
    const before = await describeInstance(machine.region, env, machine.instanceId);
    if (before.instanceId !== machine.instanceId || before.state !== "running") {
      const error = new Error("執行個體必須處於 running 狀態才能更換公網 IP。");
      error.statusCode = 409;
      error.precheck = true;
      throw error;
    }

    onProgress("stopping", {});
    await ec2Query(machine.region, env, "StopInstances", {
      "InstanceId.1": machine.instanceId,
    });
    stopRequested = true;

    const stopped = await waitForInstanceStopped(machine.region, env, machine.instanceId, onProgress);
    if (!stopped) {
      throw new Error("等待執行個體停止逾時");
    }

    onProgress("starting", {});
    await ec2Query(machine.region, env, "StartInstances", {
      "InstanceId.1": machine.instanceId,
    });
    recoveryRequested = true;
  } catch (error) {
    if (stopRequested && !recoveryRequested) {
      try {
        await ec2Query(machine.region, env, "StartInstances", {
          "InstanceId.1": machine.instanceId,
        });
        recoveryRequested = true;
      } catch {
        // 原操作失敗時，恢復啟動也可能因狀態尚未就緒而失敗。
      }
    }
    error.stopRequested = stopRequested;
    error.recoveryRequested = recoveryRequested;
    throw error;
  }

  onProgress("started", {});
  if (!waitForNewIp) {
    return { newIpAddress: null };
  }
  return { newIpAddress: await waitForNewPublicIp(machine, env, onProgress) };
}

/**
 * 依 rotatePublicIp 拋出的錯誤旗標組合使用者可讀的失敗訊息，
 * 讓多個呼叫端維持同一套文案。
 */
export function rotateIpFailureMessage(error) {
  const stopRequested = Boolean(error?.stopRequested);
  const recoveryRequested = Boolean(error?.recoveryRequested);
  return stopRequested
    ? recoveryRequested
      ? "更換公網 IP 未完成；已送出恢復啟動請求，請確認執行個體狀態。"
      : "更換公網 IP 未完成，且自動重新啟動未成功；請確認執行個體狀態後手動啟動。"
    : "執行個體操作失敗。";
}
