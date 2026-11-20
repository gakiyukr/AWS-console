import { decryptOciCredentials } from "./credential-crypto.js";
import { getDefaultOciAccount, getOciAccountById } from "./db.js";
import { getProxyWithDecryptedPassword } from "./proxy.js";

class OciAccountConfigurationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "OciAccountConfigurationError";
    this.statusCode = statusCode;
  }
}

// region 覆蓋值格式：OCI region identifier（如 eu-frankfurt-1）。
// 合法性僅驗形狀；是否為該帳號已訂閱區域由呼叫端（快取清單）把關。
const OCI_REGION_SHAPE = /^[a-z][a-z0-9-]*\d$/i;

/**
 * 解析指定或預設帳號，並解密 PEM 私鑰供單次 OCI 呼叫使用。
 * options.region 可覆蓋帳號預設操作區域（endpoint 與下層函式全由 ociAccount.region
 * 推導，簽章 keyId 不含 region），用於單帳號多區域的列表與建機。
 * @param {unknown} env
 * @param {string | number | null | undefined} rawAccountId
 * @param {{ region?: string | null }} [options]
 * @returns {Promise<{
 *   account: Record<string, unknown>,
 *   ociAccount: { id: number, tenancyOcid: string, userOcid: string, fingerprint: string,
 *     region: string, compartmentOcid: string, displayName: string, proxy: unknown },
 *   privateKeyPem: string,
 * }>}
 */
export async function resolveOciAccount(env, rawAccountId, options = {}) {
  if (!env?.DB)
    throw new OciAccountConfigurationError("D1 資料庫尚未設定", 503);
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new OciAccountConfigurationError("伺服器尚未設定憑證加密主金鑰", 503);
  }

  let account;
  if (rawAccountId !== undefined && rawAccountId !== null && rawAccountId !== "") {
    const accountId = Number(rawAccountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OciAccountConfigurationError("OCI 帳號 ID 無效");
    }
    account = await getOciAccountById(env.DB, accountId);
  } else {
    account = await getDefaultOciAccount(env.DB);
  }

  if (!account)
    throw new OciAccountConfigurationError("尚未設定可用的 OCI 帳號", 409);
  if (!account.enabled)
    throw new OciAccountConfigurationError("指定的 OCI 帳號已停用", 409);
  // region 覆蓋值在組裝 ociAccount 前驗證；空白視為未提供。
  if (options.region !== undefined && options.region !== null && options.region !== "") {
    const requested = String(options.region).trim();
    if (!OCI_REGION_SHAPE.test(requested)) {
      throw new OciAccountConfigurationError("region 參數格式無效", 400);
    }
  }

  const credentials = await decryptOciCredentials(account, env.CREDENTIAL_ENCRYPTION_KEY);
  let proxy = null;
  if (account.proxyId && env.DB) {
    try {
      proxy = await getProxyWithDecryptedPassword(env.DB, account.proxyId, env.CREDENTIAL_ENCRYPTION_KEY);
    } catch (e) {
      console.error("載入 OCI 帳號代理失敗:", e);
    }
  }

  return {
    account,
    ociAccount: {
      tenancyOcid: account.tenancyOcid,
      userOcid: account.userOcid,
      fingerprint: account.fingerprint,
      // compartment 留空時回退 tenancy 根 compartment（OCI 的 root compartment
      // OCID 與 tenancy OCID 相同），相容只把資源全放根層級的帳號。
      compartmentOcid: account.compartmentOcid || account.tenancyOcid,
      displayName: account.name,
      id: account.id,
      // region 覆蓋：多區域列表／建機帶明確 region；未帶時用帳號預設。
      region: options.region
        ? String(options.region).trim()
        : account.region,
      proxy,
    },
    privateKeyPem: credentials.privateKeyPem,
  };
}

export function toOciAccountHttpError(error) {
  if (error instanceof OciAccountConfigurationError) {
    return { status: error.statusCode, body: { error: error.message } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : "OCI 帳號設定錯誤" } };
}
