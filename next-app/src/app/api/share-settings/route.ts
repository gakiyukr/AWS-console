// GET /api/share-settings：分享頁後台設定（人機驗證開關與 secret 設置狀態）。
// PATCH /api/share-settings：更新設定。啟用人機驗證要求 Worker 已設定
// CAP_SECRET（至少 16 位元組），否則 400，避免開關打開後訪客端直接壞死。
import { appendOperationLog, getAppSetting, setAppSetting } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  isCapSecretConfigured,
  SHARE_CAPTCHA_ENABLED_KEY,
} from "@/server/utils/cap.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  return jsonResponse({
    captchaEnabled: (await getAppSetting(env.DB, SHARE_CAPTCHA_ENABLED_KEY)) === "1",
    captchaConfigured: isCapSecretConfigured(env),
  });
}

export async function PATCH(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || typeof body.captchaEnabled !== "boolean") {
    return errorResponse(400, "請求內容無效。");
  }
  if (body.captchaEnabled && !isCapSecretConfigured(env)) {
    return errorResponse(400, "尚未設定 CAP_SECRET（至少 16 位元組），無法啟用人機驗證。");
  }

  await setAppSetting(env.DB, SHARE_CAPTCHA_ENABLED_KEY, body.captchaEnabled ? "1" : "0");

  try {
    await appendOperationLog(env.DB, {
      action: "share_setting_update",
      status: "success",
      detail: { share_captcha_enabled: body.captchaEnabled },
    });
  } catch {
    // 日誌寫入失敗不影響設定結果
  }

  return jsonResponse({
    ok: true,
    captchaEnabled: body.captchaEnabled,
    captchaConfigured: isCapSecretConfigured(env),
  });
}
