import { decryptOciCredentials } from "./credential-crypto.js";
import { getDefaultOciAccount, getOciAccountById } from "./db.js";

class OciAccountConfigurationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "OciAccountConfigurationError";
    this.statusCode = statusCode;
  }
}

/**
 * 解析指定或預設帳號，並解密 PEM 私鑰供單次 OCI 呼叫使用。
 * 回傳的 ociAccount 為簽章所需的唯讀欄位組合。
 */
export async function resolveOciAccount(env, rawAccountId) {
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

  const credentials = await decryptOciCredentials(account, env.CREDENTIAL_ENCRYPTION_KEY);
  return {
    account,
    ociAccount: {
      tenancyOcid: account.tenancyOcid,
      userOcid: account.userOcid,
      fingerprint: account.fingerprint,
      region: account.region,
      compartmentOcid: account.compartmentOcid,
      displayName: account.name,
      id: account.id,
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
