// /api/accounts：GET 回傳 AWS 帳號清單（密文欄位不出伺服器）；
// POST 建立新帳號（Access Key 加密寫入 D1）。建立成功後 best-effort
// 抓取兩平台的可用區域並寫入快取，讓開機器的區域下拉只顯示快取內容。
import { encryptAwsCredentials } from "@/server/utils/credential-crypto.js";
import { createAwsAccount, listAwsAccounts, replaceCachedRegions } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { listEc2Regions } from "@/server/utils/wavelength.js";
import { listLightsailRegions } from "@/server/utils/lightsail-deploy.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
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

    // 區域快取：建立成功後立即抓取兩平台清單。抓取失敗（憑證無效、網路）
    // 不影響帳號建立——快取為空時，區域下拉會在首次讀取時自動回填。
    let regionCacheWarning = null;
    try {
      const { awsEnv } = await resolveAwsAccount(env, account.id);
      await replaceCachedRegions(env.DB, account.id, "ec2", await listEc2Regions(awsEnv));
      await replaceCachedRegions(env.DB, account.id, "lightsail", await listLightsailRegions(awsEnv));
    } catch (error) {
      regionCacheWarning = `帳號已建立，但區域快取尚未建立（${error instanceof Error ? error.message : "未知錯誤"}）；開機器時會自動重試。`;
    }

    const safe = { ...account };
    delete safe.credentialCiphertext;
    delete safe.credentialIv;
    return jsonResponse({ account: safe, regionCacheWarning }, { status: 201 });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "AWS 帳號建立失敗");
  }
}
