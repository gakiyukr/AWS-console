// POST /api/share/cap/redeem：公開端點，widget 解完 PoW 後兌換一次性憑證。
// validateChallenge 驗證解答與重放（consumeNonce 落 D1）；成功後把
// tokenKey 存入 cap_tokens，供 rotate 端點原子單次消費。
// 失敗一律 200 + { success: false, reason }，由 widget 呈現錯誤。
import { validateChallenge } from "capjs-core";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  CAP_SCOPE,
  deriveCapTokenKey,
  isCapSecretConfigured,
  isShareCaptchaEnabled,
} from "@/server/utils/cap.js";
import { consumeCapNonce, storeCapToken } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";

export async function POST(request: Request): Promise<Response> {
  const env = await getEnv();
  if (!await isShareCaptchaEnabled(env.DB)) {
    return errorResponse(404, "人機驗證未啟用。");
  }
  const capSecret = env.CAP_SECRET;
  if (!isCapSecretConfigured(env) || !capSecret) {
    return errorResponse(503, "伺服器尚未設定人機驗證金鑰。");
  }

  const body = await readJsonBody(request);
  const result = await validateChallenge(capSecret, body, {
    scope: CAP_SCOPE,
    consumeNonce: (sigHex, ttlMs) => consumeCapNonce(env.DB, sigHex, ttlMs),
  });

  if (result.success) {
    // format-1 SHA-256 流程會回傳 tokenKey；缺漏時自行推導兜底
    const tokenKey = result.tokenKey || await deriveCapTokenKey(result.token);
    if (tokenKey) {
      await storeCapToken(env.DB, tokenKey, result.expires);
    }
  }
  return jsonResponse(result);
}
