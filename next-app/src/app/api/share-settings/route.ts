// GET /api/share-settings：分享頁後台設定（人機驗證開關與配置狀態）。
// PATCH /api/share-settings：更新設定。啟用人機驗證要求 Cap 已完整配置
// （實例地址、Site Key 與 Secret Key 均有），否則回傳 400，避免啟用後訪客端無法驗證。
import { appendOperationLog, getAppSetting, setAppSetting } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  isCapConfigured,
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
    captchaConfigured: await isCapConfigured(env),
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
  if (body.captchaEnabled && !await isCapConfigured(env)) {
    return errorResponse(400, "尚未完整配置 Cap 人機驗證（須包含實例地址、Site Key 與 Secret Key），無法啟用。");
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
    captchaConfigured: await isCapConfigured(env),
  });
}
