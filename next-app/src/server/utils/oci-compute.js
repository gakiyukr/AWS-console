// OCI Compute（執行個體）呼叫：列表、單台查詢與電源操作。
// 所有請求經 oci-request.js 簽章；account 為 oci-account.js 的 ociAccount
// 形態（tenancyOcid/userOcid/fingerprint/region），privateKeyPem 為解密後明文。
import { ociRequestJson, ociSignedFetch } from "./oci-request.js";

/**
 * 列出 compartment 內的執行個體。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{ page?: string | null, compartmentOcid?: string }} [options]
 *   page 為 OCI 回應標頭 opc-next-page 的續頁權杖；compartmentOcid 預設帳號設定。
 * @returns {Promise<{ items: Array<any>, nextPage: string | null }>}
 */
export async function listInstances(ctx, options = {}) {
  const compartmentOcid = options.compartmentOcid || ctx.account.compartmentOcid;
  const query = { compartmentId: compartmentOcid };
  if (options.page) {
    query.page = options.page;
  }
  const response = await ociSignedFetch({
    account: ctx.account,
    privateKeyPem: ctx.privateKeyPem,
    method: "GET",
    path: "/20160918/instances",
    query,
  });
  const items = await response.json();
  return {
    items: Array.isArray(items) ? items : [],
    // opc-next-page：還有下一頁時的續頁權杖（oded pagination）
    nextPage: response.headers.get("opc-next-page"),
  };
}

/** 取得單一執行個體；不存在時 OCI 回 404 → OciApiError。 */
export async function getInstance(ctx, instanceId) {
  return ociRequestJson({
    account: ctx.account,
    privateKeyPem: ctx.privateKeyPem,
    method: "GET",
    path: `/20160918/instances/${encodeURIComponent(instanceId)}`,
  });
}

/**
 * 電源／生命週期動作。action 為 OCI InstanceAction 名稱：
 * START、STOP（強制）、SOFTSTOP（優雅）、SOFTRESET（優雅重啟）、RESET（強制重啟）。
 * 回應為過渡態的執行個體物件（lifecycleState: STARTING/STOPPING…）。
 */
export async function instanceAction(ctx, instanceId, action) {
  return ociRequestJson({
    account: ctx.account,
    privateKeyPem: ctx.privateKeyPem,
    method: "POST",
    path: `/20160918/instances/${encodeURIComponent(instanceId)}`,
    body: { action },
  });
}

/**
 * 終止（刪除）執行個體：DELETE /20160918/instances/{instanceId}。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {string} instanceId
 * @param {{ preserveBootVolume?: boolean }} [options]
 */
export async function terminateInstance(ctx, instanceId, options = {}) {
  const query = {};
  if (options.preserveBootVolume) {
    query.preserveBootVolume = "true";
  }
  return ociSignedFetch({
    account: ctx.account,
    privateKeyPem: ctx.privateKeyPem,
    method: "DELETE",
    path: `/20160918/instances/${encodeURIComponent(instanceId)}`,
    query,
  });
}

