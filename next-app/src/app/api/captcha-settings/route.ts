// /api/captcha-settings：人機驗證（Cap trycap.dev）的後臺設定。
// GET    → { configured, source, endpoint, siteKey, secretHint, enabled }
// PUT    { endpoint, siteKey, secret } → 驗證後加密儲存於 D1
// DELETE → 移除設定並自動停用人機驗證
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  clearCaptchaSettings,
  getCapSettings,
  saveCaptchaSettings,
  SHARE_CAPTCHA_ENABLED_KEY,
} from "@/server/utils/cap.js";
import { appendOperationLog, getAppSetting, setAppSetting } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const cap = await getCapSettings(env);
  return jsonResponse({
    configured: cap.configured,
    source: cap.source,
    endpoint: cap.endpoint,
    siteKey: cap.siteKey,
    secretHint: cap.secretHint,
    enabled: (await getAppSetting(env.DB, SHARE_CAPTCHA_ENABLED_KEY)) === "1",
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
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const siteKey = typeof body?.siteKey === "string" ? body.siteKey.trim() : "";
  const secret = typeof body?.secret === "string" ? body.secret.trim() : "";

  if (!endpoint) {
    return errorResponse(400, "請輸入 Cap 實例地址（例如：https://cap.example.com）。");
  }
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol)) {
      return errorResponse(400, "Cap 實例地址必須以 http:// 或 https:// 開頭。");
    }
  } catch {
    return errorResponse(400, "Cap 實例地址格式不正確，請輸入有效的 URL。");
  }

  if (!siteKey) {
    return errorResponse(400, "請輸入 Cap 站點公鑰（Site Key）。");
  }

  const existing = await getCapSettings(env);
  if (!secret && !existing.secret) {
    return errorResponse(400, "請輸入 Cap 驗證私鑰（Secret Key）。");
  }

  try {
    await saveCaptchaSettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, {
      endpoint,
      siteKey,
      secret,
    });
  } catch (error) {
    return errorResponse(500, error instanceof Error ? error.message : "儲存人機驗證設定失敗");
  }

  try {
    await appendOperationLog(env.DB, {
      action: "captcha_setting_update",
      status: "success",
      detail: { endpoint, site_key: siteKey, secret_updated: Boolean(secret) },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }

  const updated = await getCapSettings(env);
  return jsonResponse({
    ok: true,
    configured: updated.configured,
    endpoint: updated.endpoint,
    siteKey: updated.siteKey,
    secretHint: updated.secretHint,
    message: "人機驗證（Cap）設定已儲存。",
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const deleted = await clearCaptchaSettings(env.DB);
  await setAppSetting(env.DB, SHARE_CAPTCHA_ENABLED_KEY, "0");
  try {
    await appendOperationLog(env.DB, {
      action: "captcha_setting_update",
      status: "success",
      detail: { captcha_settings: "removed", captcha_enabled: false },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }
  return jsonResponse({ ok: true, deleted });
}
