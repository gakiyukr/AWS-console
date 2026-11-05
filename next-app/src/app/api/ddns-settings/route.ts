// /api/ddns-settings：DDNS（Cloudflare）設定的讀取／儲存／移除。
// Token 以 AES-256-GCM 加密存 D1，永不回傳明文；儲存前先驗證
// Token 確實能存取指定 zone（需 Zone.DNS Edit 權限）。
import {
  clearDdnsSettings,
  getDdnsSettings,
  saveDdnsSettings,
  verifyCloudflareToken,
} from "@/server/utils/ddns.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }
  const settings = await getDdnsSettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY);
  return jsonResponse({
    configured: Boolean(settings),
    zoneName: settings?.zoneName || null,
    tokenHint: settings ? `····${settings.tokenHint}` : null,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }

  const body = await readJsonBody(request);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const zoneName = typeof body?.zoneName === "string" ? body.zoneName.trim().toLowerCase() : "";
  if (!token || !zoneName) {
    return errorResponse(400, "請填寫 API Token 與 Zone 名稱。");
  }

  let zoneId;
  try {
    zoneId = await verifyCloudflareToken(token, zoneName);
  } catch {
    return errorResponse(502, "無法連線至 Cloudflare API，請稍後再試。");
  }
  if (!zoneId) {
    return errorResponse(400, "驗證失敗：Token 無效、缺少 Zone.DNS Edit 權限，或此帳號下沒有該 Zone。");
  }

  await saveDdnsSettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, { token, zoneId, zoneName });
  return jsonResponse({
    ok: true,
    zoneName,
    message: `DDNS 已設定（Zone：${zoneName}）。`,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const deleted = await clearDdnsSettings(env.DB);
  return jsonResponse({ ok: true, deleted });
}
