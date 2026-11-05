// POST /api/share/cap/challenge：公開端點，Cap widget 取得 PoW challenge。
// capjs-core 為 stateless（challenge 是簽章 JWT），此端點只需 CAP_SECRET；
// 重放防護與憑證保存分別在 redeem 與 rotate 端點落 D1。
// 人機驗證未啟用時回 404（不對外暴露此能力），啟用但缺 secret 回 503。
import { generateChallenge } from "capjs-core";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import {
  CAP_SCOPE,
  getCapSecret,
  isShareCaptchaEnabled,
} from "@/server/utils/cap.js";
import { deleteExpiredCapRows } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";

export async function POST(): Promise<Response> {
  const env = await getEnv();
  if (!await isShareCaptchaEnabled(env.DB)) {
    return errorResponse(404, "人機驗證未啟用。");
  }
  const cap = await getCapSecret(env);
  if (!cap) {
    return errorResponse(503, "伺服器尚未設定人機驗證密鑰。");
  }

  // 過期的重放記錄與憑證在此順手清理；失敗不影響發放。
  try {
    await deleteExpiredCapRows(env.DB);
  } catch {
    // 清理失敗不影響 challenge 發放
  }

  const challenge = await generateChallenge(cap.secret, { scope: CAP_SCOPE });
  return jsonResponse(challenge);
}
