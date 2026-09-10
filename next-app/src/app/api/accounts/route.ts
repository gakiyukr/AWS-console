// /api/accounts：GET 回傳 AWS 帳號清單（密文欄位不出伺服器）；
// POST 建立新帳號（Access Key 加密寫入 D1）。
import { encryptAwsCredentials } from "@/server/utils/credential-crypto.js";
import { createAwsAccount, listAwsAccounts } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

function publicAccount(account: Record<string, unknown>) {
  const safe = { ...account };
  delete safe.credentialCiphertext;
  delete safe.credentialIv;
  return safe;
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const accounts = await listAwsAccounts(env.DB);
  return jsonResponse({ accounts: accounts.map(publicAccount) });
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) {
    return errorResponse(400, "帳號名稱必須為 1 至 80 個字元");
  }
  if (body.enabled === false && body.isDefault === true) {
    return errorResponse(400, "預設 AWS 帳號必須保持啟用");
  }

  try {
    const encrypted = await encryptAwsCredentials({
      accessKeyId: body.accessKeyId,
      secretAccessKey: body.secretAccessKey,
      sessionToken: body.sessionToken,
    }, env.CREDENTIAL_ENCRYPTION_KEY);
    const account = await createAwsAccount(env.DB, {
      name,
      ...encrypted,
      enabled: body.enabled !== false,
      isDefault: body.isDefault === true,
    });
    if (!account) {
      return errorResponse(409, "AWS 帳號名稱已存在");
    }
    const safe = { ...account };
    delete safe.credentialCiphertext;
    delete safe.credentialIv;
    return jsonResponse({ account: safe }, { status: 201 });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "AWS 帳號建立失敗");
  }
}
