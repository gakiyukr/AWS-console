// Cap（trycap.dev）人機驗證的伺服端工具：capjs-core 的共用常數、
// 兌換憑證的鍵值推導與雜湊。capjs-core 為 stateless 設計（JWT 簽章、
// 純 WebCrypto），重放防護與憑證保存由本專案的 D1 負責（db.js）。
//
// 簽章密鑰來源：D1 的 captcha_settings（設定頁配置，加密儲存）優先；
// 未配置時退回環境變量 CAP_SECRET（遷移期相容，設定頁儲存後即以 D1 為準）。
import { decryptCaptchaSecret, encryptCaptchaSecret } from "./credential-crypto.js";
import { getAppSetting } from "./db.js";

/** Challenge 與兌換憑證綁定的 scope；驗證時必須一致，避免憑證跨用途重放。 */
export const CAP_SCOPE = "share-rotate";

/** app_settings 中分享頁人機驗證開關的鍵名。 */
export const SHARE_CAPTCHA_ENABLED_KEY = "share_captcha_enabled";

/** capjs-core 的 secret 最短長度（≥16 bytes），用於 JWT HMAC 簽章。 */
export const CAP_SECRET_MIN_BYTES = 16;

/** 分享頁人機驗證開關（app_settings；未設定視為關閉）。 */
export async function isShareCaptchaEnabled(db) {
  return (await getAppSetting(db, SHARE_CAPTCHA_ENABLED_KEY)) === "1";
}

/**
 * 取得 Cap 簽章密鑰：D1（設定頁配置）優先，退回環境變量 CAP_SECRET。
 * @returns {Promise<{ secret: string, source: "db" | "env" } | null>}
 */
export async function getCapSecret(env) {
  if (env?.DB && env?.CREDENTIAL_ENCRYPTION_KEY) {
    const row = await env.DB
      .prepare("SELECT secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, secret_hint AS secretHint FROM captcha_settings WHERE id = 1")
      .first();
    if (row) {
      return {
        secret: await decryptCaptchaSecret(row, env.CREDENTIAL_ENCRYPTION_KEY),
        source: "db",
      };
    }
  }
  const envSecret = env?.CAP_SECRET;
  if (envSecret && new TextEncoder().encode(envSecret).byteLength >= CAP_SECRET_MIN_BYTES) {
    return { secret: envSecret, source: "env" };
  }
  return null;
}

/** 密鑰是否可用（D1 或環境變量）。 */
export async function isCapSecretConfigured(env) {
  return (await getCapSecret(env)) !== null;
}

/** 儲存設定頁配置的密鑰（加密；呼叫端須先驗證長度）。 */
export async function saveCaptchaSecret(db, encryptionKey, secret) {
  const encrypted = await encryptCaptchaSecret(secret, encryptionKey);
  await db
    .prepare(`INSERT INTO captcha_settings (id, secret_ciphertext, secret_iv, secret_hint)
      VALUES (1, ?1, ?2, ?3)
      ON CONFLICT(id) DO UPDATE SET
        secret_ciphertext = ?1, secret_iv = ?2, secret_hint = ?3, updated_at = datetime('now')`)
    .bind(encrypted.clientSecretCiphertext, encrypted.clientSecretIv, secret.slice(-4))
    .run();
}

/** 清除設定頁配置的密鑰（環境變量 fallback 仍可能可用）。 */
export async function clearCaptchaSecret(db) {
  const result = await db.prepare("DELETE FROM captcha_settings WHERE id = 1").run();
  return (result.meta.changes ?? 0) > 0;
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
