// /api/oci-accounts：GET 回傳 OCI 帳號清單（密文與私鑰欄位不出伺服器）；
// POST 建立新帳號（PEM 私鑰加密寫入 D1）。
import { encryptOciCredentials } from "@/server/utils/credential-crypto.js";
import { createOciAccount, listOciAccounts } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
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
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) {
    return errorResponse(400, "帳號名稱必須為 1 至 80 個字元");
  }
  for (const [field, type, label] of [
    ["tenancyOcid", "tenancyOcid", "Tenancy OCID"],
    ["userOcid", "userOcid", "User OCID"],
    ["compartmentOcid", "compartmentOcid", "Compartment OCID"],
    ["region", "region", "Region"],
    ["fingerprint", "fingerprint", "Fingerprint"],
  ] as const) {
    const validation = validateInput(body[field], type, label);
    if (!validation.valid) {
      return errorResponse(400, validation.error);
    }
  }
  if (typeof body.privateKeyPem !== "string" || !body.privateKeyPem.trim()) {
    return errorResponse(400, "PEM 私鑰為必填");
  }
  if (body.privateKeyPem.length > 16 * 1024) {
    return errorResponse(400, "PEM 私鑰內容過大");
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
    const encrypted = await encryptOciCredentials({
      privateKeyPem: body.privateKeyPem,
    }, env.CREDENTIAL_ENCRYPTION_KEY);
    const account = await createOciAccount(env.DB, {
      name,
      tenancyOcid: String(body.tenancyOcid).trim(),
      userOcid: String(body.userOcid).trim(),
      fingerprint: String(body.fingerprint).trim(),
      region: String(body.region).trim(),
      compartmentOcid: String(body.compartmentOcid).trim(),
      ...encrypted,
      // UI 顯示「指紋尾碼」供辨識，不回傳完整憑證
      keyHint: String(body.fingerprint).trim().slice(-5),
      enabled: body.enabled !== false,
      isDefault: body.isDefault === true,
      proxyId,
    });
    if (!account) {
      return errorResponse(409, "OCI 帳號名稱已存在");
    }
    const safe = { ...account };
    delete safe.keyCiphertext;
    delete safe.keyIv;
    return jsonResponse({ account: safe }, { status: 201 });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "OCI 帳號建立失敗");
  }
}
