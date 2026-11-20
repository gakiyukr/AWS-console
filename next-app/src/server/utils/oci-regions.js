// OCI 區域訂閱與 OCID 地區解析。
// - ListRegionSubscriptions（tenancy 級）回傳 tenancy 已訂閱的區域清單，
//   含 home region 標記；升級（PAYG）帳號可透過它發現多個可用區域。
// - 執行個體 OCID 第 4 段在新舊區域分別為 identifier（eu-frankfurt-1）或
//   region key（FRA），故解析時需訂閱清單的 key↔identifier 對映；
//   對映查不到時回 null，呼叫端回退帳號預設 region。
import { ociRequestJson } from "./oci-request.js";
import { listCachedOciRegions } from "./db.js";

/**
 * 排序已訂閱區域：主區域（home region）置頂，其餘依 identifier 字母排序。
 * @template {{ region: string, isHomeRegion?: boolean }} T
 * @param {T[]} regions
 * @returns {T[]}
 */
export function sortOciRegions(regions) {
  return [...(regions || [])].sort(
    (a, b) => Number(Boolean(b.isHomeRegion)) - Number(Boolean(a.isHomeRegion)) || a.region.localeCompare(b.region),
  );
}

/**
 * 篩出已就緒（READY）的訂閱區域；若清單內無任何 READY 項目，則回退全部。
 * @template {{ status?: string }} T
 * @param {T[]} regions
 * @returns {T[]}
 */
export function readyOciRegions(regions) {
  const list = regions || [];
  const ready = list.filter(item => item?.status === "READY");
  return ready.length > 0 ? ready : list;
}

/**
 * 查詢 tenancy 已訂閱的區域清單（ListRegionSubscriptions，IAM identity 端點）。
 * status 常見值：READY（訂閱生效）；其他值（如 PENDING_UPGRADE）原樣保留供 UI 標示。
 * @param {{ account: { tenancyOcid?: string, [key: string]: unknown }, privateKeyPem: string }} ctx
 * @returns {Promise<Array<{ region: string, regionKey: string, isHomeRegion: boolean, status: string }>>}
 */
export async function listRegionSubscriptions(ctx) {
  const tenancyOcid = ctx?.account?.tenancyOcid;
  if (!tenancyOcid) {
    throw new Error("OCI 帳號缺少 tenancyOcid，無法查詢訂閱區域。");
  }
  const payload = await ociRequestJson({
    account: ctx.account,
    privateKeyPem: ctx.privateKeyPem,
    service: "identity",
    method: "GET",
    path: `/20160918/tenancies/${encodeURIComponent(tenancyOcid)}/regionSubscriptions`,
  });
  const rows = Array.isArray(payload) ? payload : [];
  return sortOciRegions(
    rows
      .filter(row => row?.regionName)
      .map(row => ({
        region: String(row.regionName),
        regionKey: String(row.regionKey || ""),
        isHomeRegion: row.isHomeRegion === true,
        status: String(row.status || "READY"),
      })),
  );
}

/**
 * 由訂閱清單組出 OCID 段 → region identifier 對映（regionKey 大寫、identifier 直接保留）。
 * @param {Array<{ region: string, regionKey: string }>} subscriptions
 * @returns {Map<string, string>}
 */
export function buildRegionKeyMap(subscriptions) {
  const map = new Map();
  for (const sub of subscriptions || []) {
    if (sub.region) map.set(sub.region.toLowerCase(), sub.region);
    if (sub.regionKey) map.set(String(sub.regionKey).toLowerCase(), sub.region);
  }
  return map;
}

/**
 * 從執行個體 OCID 反推 region identifier。
 * 格式 ocid1.<type>.<realm>.[<region-or-key>].<unique-id>：全域資源（tenancy）
 * 無 region 段、雙點分隔；執行個體有第 4 段，內容為 identifier 或 key。
 * @param {string} ocid
 * @param {Map<string, string>} [keyMap] buildRegionKeyMap 的對映；缺省僅接受 identifier 形式
 * @returns {string | null} 無法判定時回 null（呼叫端回退帳號預設 region）
 */
export function regionFromInstanceOcid(ocid, keyMap) {
  const parts = String(ocid || "").split(".");
  // 例：ocid1.instance.oc1.eu-frankfurt-1.<id>（5 段）；無 region 段為 4 段
  if (parts.length < 5 || parts[0] !== "ocid1" || !parts[2].startsWith("oc")) {
    return null;
  }
  const segment = parts[3].toLowerCase();
  if (!segment) return null;
  if (keyMap?.has(segment)) return keyMap.get(segment);
  // identifier 形式（xx-地名-數字）無需對映即可辨識
  return /^[a-z]{2}(?:-[a-z]+)*-\d+$/.test(segment) ? segment : null;
}

/**
 * 組出單次執行個體操作的請求 context：若呼叫端已明確指定 region，直接沿用；
 * 否則依快取訂閱清單從 OCID 反推 region，與帳號預設不同時覆蓋 account.region
 * （簽章 keyId 不含 region，endpoint 即切換）。快取讀取或解析失敗一律回退帳號預設區域。
 * @param {unknown} env
 * @param {{ account: Record<string, unknown>, ociAccount: { region: string, compartmentOcid: string, [key: string]: unknown }, privateKeyPem: string }} resolved
 *   resolveOciAccount 的結果
 * @param {string} instanceOcid
 * @param {string} [explicitRegion]
 * @returns {Promise<{ account: { region: string, compartmentOcid: string, [key: string]: unknown }, privateKeyPem: string, region: string }>}
 */
export async function resolveInstanceContext(env, resolved, instanceOcid, explicitRegion = "") {
  if (explicitRegion && String(explicitRegion).trim()) {
    return { account: resolved.ociAccount, privateKeyPem: resolved.privateKeyPem, region: resolved.ociAccount.region };
  }
  let region = null;
  try {
    const cached = await listCachedOciRegions(env?.DB, Number(resolved.account.id));
    region = regionFromInstanceOcid(instanceOcid, buildRegionKeyMap(cached));
  } catch {
    region = null;
  }
  const account = region && region !== resolved.ociAccount.region
    ? { ...resolved.ociAccount, region }
    : resolved.ociAccount;
  return { account, privateKeyPem: resolved.privateKeyPem, region: account.region };
}
