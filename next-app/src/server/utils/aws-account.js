import { decryptAwsCredentials } from "./credential-crypto.js";
import { getAwsAccountById, getDefaultAwsAccount } from "./db.js";

class AwsAccountConfigurationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AwsAccountConfigurationError";
    this.statusCode = statusCode;
  }
}

/** 解析指定或預設帳號，並建立只供單次 AWS 呼叫使用的執行環境。 */
export async function resolveAwsAccount(env, rawAccountId) {
  if (!env?.DB)
    throw new AwsAccountConfigurationError("D1 資料庫尚未設定", 503);
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new AwsAccountConfigurationError("伺服器尚未設定憑證加密主金鑰", 503);
  }

  let account;
  if (rawAccountId !== undefined && rawAccountId !== null && rawAccountId !== "") {
    const accountId = Number(rawAccountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new AwsAccountConfigurationError("AWS 帳號 ID 無效");
    }
    account = await getAwsAccountById(env.DB, accountId);
  } else {
    account = await getDefaultAwsAccount(env.DB);
  }

  if (!account)
    throw new AwsAccountConfigurationError("尚未設定可用的 AWS 帳號", 409);
  if (!account.enabled)
    throw new AwsAccountConfigurationError("指定的 AWS 帳號已停用", 409);

  const credentials = await decryptAwsCredentials(account, env.CREDENTIAL_ENCRYPTION_KEY);
  return {
    account,
    awsEnv: {
      ...env,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken || undefined,
    },
  };
}

export function toAwsAccountHttpError(error) {
  if (error instanceof AwsAccountConfigurationError) {
    return { status: error.statusCode, body: { error: error.message } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : "AWS 帳號設定錯誤" } };
}
