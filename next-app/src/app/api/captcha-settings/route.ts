// /api/captcha-settings：人機驗證（Cap）的後臺設定。
// GET    → { configured, source, secretHint, enabled }
// PUT    { secret } → 驗證長度後加密儲存（D1 優先於環境變量 CAP_SECRET）
// DELETE → 移除密鑰並自動停用人機驗證（避免無密鑰卻啟用的矛盾狀態）
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  CAP_SECRET_MIN_BYTES,
  clearCaptchaSecret,
  getCapSecret,
  saveCaptchaSecret,
  SHARE_CAPTCHA_ENABLED_KEY,
} from "@/server/utils/cap.js";
import { appendOperationLog, getAppSetting, setAppSetting } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const cap = await getCapSecret(env);
  return jsonResponse({
    configured: cap !== null,
    source: cap?.source || null,
    secretHint: cap ? `····${cap.secret.slice(-4)}` : null,
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
  const secret = typeof body?.secret === "string" ? body.secret.trim() : "";
  if (new TextEncoder().encode(secret).byteLength < CAP_SECRET_MIN_BYTES) {
    return errorResponse(400, `密鑰長度須至少 ${CAP_SECRET_MIN_BYTES} 位元組（建議以 node 產生 32 bytes 隨機值）。`);
  }

  await saveCaptchaSecret(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, secret);
  try {
    await appendOperationLog(env.DB, {
      action: "captcha_setting_update",
      status: "success",
      detail: { captcha_secret: "updated" },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }
  return jsonResponse({
    ok: true,
    secretHint: `····${secret.slice(-4)}`,
    message: "人機驗證密鑰已儲存（D1 配置優先於環境變量）。",
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const deleted = await clearCaptchaSecret(env.DB);
  // 無 D1 密鑰後只剩環境變量 fallback；為避免「啟用中但兩者皆無」的狀態，
  // 同步停用開關（環境變量仍可用時使用者可隨時再啟用）。
  await setAppSetting(env.DB, SHARE_CAPTCHA_ENABLED_KEY, "0");
  try {
    await appendOperationLog(env.DB, {
      action: "captcha_setting_update",
      status: "success",
      detail: { captcha_secret: "removed", captcha_enabled: false },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }
  return jsonResponse({ ok: true, deleted });
}
