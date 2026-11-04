// Cap（trycap.dev）人機驗證的伺服端工具：capjs-core 的共用常數、
// 兌換憑證的鍵值推導與雜湊。capjs-core 為 stateless 設計（JWT 簽章、
// 純 WebCrypto），重放防護與憑證保存由本專案的 D1 負責（db.js）。
import { getAppSetting } from "./db.js";

/** Challenge 與兌換憑證綁定的 scope；驗證時必須一致，避免憑證跨用途重放。 */
export const CAP_SCOPE = "share-rotate";

/** app_settings 中分享頁人機驗證開關的鍵名。 */
export const SHARE_CAPTCHA_ENABLED_KEY = "share_captcha_enabled";

/** capjs-core 的 secret 最短長度（≥16 bytes），用於 JWT HMAC 簽章。 */
export const CAP_SECRET_MIN_BYTES = 16;

/** secret 是否可用：存在且長度足夠。 */
export function isCapSecretConfigured(env) {
  return Boolean(env?.CAP_SECRET)
    && new TextEncoder().encode(env.CAP_SECRET).byteLength >= CAP_SECRET_MIN_BYTES;
}

/** 分享頁人機驗證開關（app_settings；未設定視為關閉）。 */
export async function isShareCaptchaEnabled(db) {
  return (await getAppSetting(db, SHARE_CAPTCHA_ENABLED_KEY)) === "1";
}

/** SHA-256 → 小寫 hex（WebCrypto，Workers 相容）。 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 由訪客提交的兌換憑證（`id:vertoken`）重新推導 tokenKey
 * （`id:sha256(vertoken)`），與 capjs-core 回傳的 tokenKey 同構，
 * 供 D1 查驗單次使用。格式不符回 null。
 */
export async function deriveCapTokenKey(token) {
  if (typeof token !== "string") {
    return null;
  }
  const separator = token.indexOf(":");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  const id = token.slice(0, separator);
  const verToken = token.slice(separator + 1);
  return `${id}:${await sha256Hex(verToken)}`;
}
