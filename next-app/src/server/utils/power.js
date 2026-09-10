// 電源管理業務邏輯：移植自 ec2-power-console，AWS 請求改經共用的
// ec2Query（SigV4 + 30 秒逾時）。純函式與 AWS 互動集中於此模組，
// 路由檔僅負責輸入驗證與 D1 存取，使本檔可在 node --test 直接驗證。
import { ec2Query } from "./aws-query.js";

// 地區查詢失敗或執行個體自回應中消失時，狀態欄位的降級顯示值；
// 前端直接呈現，用於提醒清單資料可能過期，而非反映真實電源狀態。
export const STATE_QUERY_FAILED = "查詢失敗";
export const STATE_NOT_FOUND = "未找到";

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
export function deriveIpFromPublicDns(publicDnsName) {
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
export function extractAwsNameTag(xml) {
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
export function parseDescribeInstancesXmlItems(xml) {
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
export function parseDescribeInstancesXml(xml) {
  const lookup = new Map();
  for (const item of parseDescribeInstancesXmlItems(xml)) {
    if (item.instanceId) {
      lookup.set(item.instanceId, item);
    }
  }
  return lookup;
}

/** 依地區分組並按地區名排序，供批次查詢使用；項目以複本回傳避免污染來源陣列。 */
export function buildRegionGroups(machines) {
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
 * 對單一機器送出電源操作。僅接受 start|stop，其餘動作一律拒絕，
 * 避免任意 Action 字串注入 AWS API。
 */
export async function performPowerAction(env, machine, action) {
  if (action !== "start" && action !== "stop") {
    throw new Error("Unsupported action");
  }
  await ec2Query(
    machine.region,
    env,
    action === "start" ? "StartInstances" : "StopInstances",
    { "InstanceId.1": machine.instanceId },
  );
  return { ok: true, action };
}
