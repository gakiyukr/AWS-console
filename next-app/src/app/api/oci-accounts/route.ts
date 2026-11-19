// /api/oci-accounts：GET 回傳 OCI 帳號清單（密文與私鑰欄位不出伺服器）；
// POST 建立新帳號（PEM 私鑰加密寫入 D1）。
import { encryptOciCredentials } from "@/server/utils/credential-crypto.js";
import { createOciAccount, listOciAccounts } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { normalizeOciAccountInput, validateOciPrivateKeyPem } from "@/server/utils/oci-account-normalize.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

function publicAccount(account: Record<string, unknown>) {
  const safe = { ...account };
  delete safe.keyCiphertext;
  delete safe.keyIv;
  return safe;
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const accounts = await listOciAccounts(env.DB);
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
  const normalized = normalizeOciAccountInput(body);
  if (!normalized.valid) {
    return errorResponse(400, normalized.error ?? "OCI 帳號資料無效");
  }
  const privateKey = await validateOciPrivateKeyPem(body.privateKeyPem);
  if (!privateKey.valid) {
    return errorResponse(400, privateKey.error ?? "PEM 私鑰格式無效");
  }
  if (body.enabled === false && body.isDefault === true) {
    return errorResponse(400, "預設 OCI 帳號必須保持啟用");
  }
  // 出口代理綁定（可選）：null/空字串＝不綁定
  let proxyId = null;
  if (body.proxyId !== undefined && body.proxyId !== null && body.proxyId !== "") {
    proxyId = Number(body.proxyId);
    if (!Number.isSafeInteger(proxyId) || proxyId <= 0) {
      return errorResponse(400, "代理 ID 無效");
    }
  }

  try {
    const { name, tenancyOcid, userOcid, fingerprint, region, compartmentOcid } = normalized.values;
    const encrypted = await encryptOciCredentials({ privateKeyPem: privateKey.value }, env.CREDENTIAL_ENCRYPTION_KEY);
    const account = await createOciAccount(env.DB, {
      name,
      tenancyOcid,
      userOcid,
      fingerprint,
      region,
      compartmentOcid,
      ...encrypted,
      // UI 顯示指紋尾碼；須從正規化後的完整指紋計算。
      keyHint: fingerprint.slice(-5),
      enabled: body.enabled !== false,
      isDefault: body.isDefault === true,
      proxyId,
    });
    if (!account) {
      return errorResponse(409, "OCI 帳號名稱已存在");
    }
    return jsonResponse({ account: publicAccount(account) }, { status: 201 });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "OCI 帳號建立失敗");
  }
}
