// Cap（trycap.dev）人機驗證的伺服端工具：
// 支援 Cap Standalone 自建服務端（tiago2/cap）與託管服務。
//
// 驗證流程參照 trycap.dev 規範：
// 1. 前端組件：<cap-widget site-key="..." endpoint="..." data-cap-api-endpoint="..."></cap-widget>
// 2. 伺服端校驗：POST <endpoint>/<site-key>/siteverify（或 <endpoint>/siteverify）
//    Body: { secret: "<secret>", response: "<token>", token: "<token>" }
//    回傳: { success: true }
//
// 設定來源：D1 的 captcha_settings（設定頁配置，密鑰加密儲存）優先；
// 未配置時退回環境變量 CAP_ENDPOINT、CAP_SITE_KEY、CAP_SECRET。
import { decryptCaptchaSecret, encryptCaptchaSecret } from "./credential-crypto.js";
import { getAppSetting } from "./db.js";

/** Challenge 與兌換憑證綁定的 scope（相容舊版本地端點）。 */
export const CAP_SCOPE = "share-rotate";

/** app_settings 中分享頁人機驗證開關的鍵名。 */
export const SHARE_CAPTCHA_ENABLED_KEY = "share_captcha_enabled";

/** Cap secret 最短長度（≥8 bytes）。 */
export const CAP_SECRET_MIN_BYTES = 8;

/** 分享頁人機驗證開關（app_settings；未設定視為關閉）。 */
export async function isShareCaptchaEnabled(db) {
  return (await getAppSetting(db, SHARE_CAPTCHA_ENABLED_KEY)) === "1";
}

/**
 * 取得完整 Cap 設定（實例端點、Site Key、驗證私鑰）：
 * D1（設定頁配置）優先，退回環境變量。
 * @returns {Promise<{
 *   configured: boolean,
 *   source: "db" | "env" | null,
 *   endpoint: string,
 *   siteKey: string,
 *   secret: string,
 *   secretHint: string | null
 * }>}
 */
export async function getCapSettings(env) {
  let endpoint = "";
  let siteKey = "";
  let secret = "";
  let secretHint = null;
  let source = null;

  if (env?.DB) {
    const row = await env.DB
      .prepare("SELECT endpoint, site_key AS siteKey, secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, secret_hint AS secretHint FROM captcha_settings WHERE id = 1")
      .first();
    if (row) {
      endpoint = typeof row.endpoint === "string" ? row.endpoint.trim() : "";
      siteKey = typeof row.siteKey === "string" ? row.siteKey.trim() : "";
      if (row.secretCiphertext && env?.CREDENTIAL_ENCRYPTION_KEY) {
        try {
          secret = await decryptCaptchaSecret(row, env.CREDENTIAL_ENCRYPTION_KEY);
          secretHint = row.secretHint || (secret ? secret.slice(-4) : null);
          source = "db";
        } catch {
          // 解密失敗由上層處理
        }
      }
    }
  }

  // 環境變量 fallback
  if (!endpoint && env?.CAP_ENDPOINT) {
    endpoint = String(env.CAP_ENDPOINT).trim();
  }
  if (!siteKey && env?.CAP_SITE_KEY) {
    siteKey = String(env.CAP_SITE_KEY).trim();
  }
  if (!secret && env?.CAP_SECRET) {
    secret = String(env.CAP_SECRET).trim();
    secretHint = secret ? secret.slice(-4) : null;
    source = "env";
  }

  const configured = Boolean(endpoint && siteKey && secret);

  return {
    configured,
    source,
    endpoint,
    siteKey,
    secret,
    secretHint: secretHint ? `····${secretHint}` : null,
  };
}

/**
 * 取得 Cap 簽章密鑰（相容舊呼叫）。
 * @returns {Promise<{ secret: string, source: "db" | "env" } | null>}
 */
export async function getCapSecret(env) {
  const settings = await getCapSettings(env);
  if (settings.secret) {
    return { secret: settings.secret, source: settings.source || "db" };
  }
  return null;
}

/** 人機驗證是否已完整配置（Endpoint、Site Key 與 Secret 均齊全）。 */
export async function isCapConfigured(env) {
  const settings = await getCapSettings(env);
  return settings.configured;
}

/** 相容舊別名。 */
export async function isCapSecretConfigured(env) {
  return await isCapConfigured(env);
}

/**
 * 儲存設定頁配置的 Cap 設定（實例端點、Site Key、驗證私鑰）。
 * 若 secret 為空且已有現有密鑰，則保留現有密鑰。
 */
export async function saveCaptchaSettings(db, encryptionKey, { endpoint, siteKey, secret }) {
  const normalizedEndpoint = (endpoint || "").trim().replace(/\/+$/, "");
  const normalizedSiteKey = (siteKey || "").trim();

  const existing = await db
    .prepare("SELECT secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, secret_hint AS secretHint FROM captcha_settings WHERE id = 1")
    .first();

  let ciphertext = existing?.secretCiphertext;
  let iv = existing?.secretIv;
  let hint = existing?.secretHint;

  if (secret && typeof secret === "string" && secret.trim()) {
    const trimmedSecret = secret.trim();
    const encrypted = await encryptCaptchaSecret(trimmedSecret, encryptionKey);
    ciphertext = encrypted.clientSecretCiphertext;
    iv = encrypted.clientSecretIv;
    hint = trimmedSecret.slice(-4);
  }

  if (!ciphertext || !iv) {
    throw new Error("缺少人機驗證密鑰 (Secret Key)");
  }

  await db
    .prepare(`INSERT INTO captcha_settings (id, endpoint, site_key, secret_ciphertext, secret_iv, secret_hint, updated_at)
      VALUES (1, ?1, ?2, ?3, ?4, ?5, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        endpoint = ?1,
        site_key = ?2,
        secret_ciphertext = ?3,
        secret_iv = ?4,
        secret_hint = ?5,
        updated_at = datetime('now')`)
    .bind(normalizedEndpoint, normalizedSiteKey, ciphertext, iv, hint)
    .run();
}

/** 相容舊別名：儲存設定頁配置的密鑰。 */
export async function saveCaptchaSecret(db, encryptionKey, secret) {
  return saveCaptchaSettings(db, encryptionKey, { endpoint: "", siteKey: "", secret });
}

/** 清除設定頁配置的人機驗證設定。 */
export async function clearCaptchaSettings(db) {
  const result = await db.prepare("DELETE FROM captcha_settings WHERE id = 1").run();
  return (result.meta.changes ?? 0) > 0;
}

/** 相容舊別名。 */
export async function clearCaptchaSecret(db) {
  return clearCaptchaSettings(db);
}

/**
 * 伺服端向 Cap 實例驗證訪客提交的 token。
 * 遵循 trycap.dev /siteverify 規範：
 * POST <endpoint>/<site-key>/siteverify
 * Body: { secret, response: token, token }
 * @param {object} env
 * @param {string} token
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function verifyCapToken(env, token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { success: false, error: "未提供驗證憑證 (token)" };
  }
  const config = await getCapSettings(env);
  if (!config.configured) {
    return { success: false, error: "人機驗證尚未完整配置（需包含實例網址、Site Key 與 Secret Key）" };
  }

  const baseUrl = config.endpoint.replace(/\/+$/, "");
  const primaryUrl = `${baseUrl}/${encodeURIComponent(config.siteKey)}/siteverify`;

  const payload = {
    secret: config.secret,
    response: token.trim(),
    token: token.trim(),
  };

  try {
    let res = await fetch(primaryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // 若 /<site-key>/siteverify 回傳 404，嘗試 Cap 根路徑 /siteverify
    if (res.status === 404) {
      res = await fetch(`${baseUrl}/siteverify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({ ...payload, sitekey: config.siteKey }),
      });
    }

    if (!res.ok) {
      return { success: false, error: `Cap 伺服器驗證失敗 (HTTP ${res.status})` };
    }

    const data = await res.json();
    if (data?.success === true) {
      return { success: true };
    }
    const errorCodes = Array.isArray(data?.["error-codes"]) ? data["error-codes"].join(", ") : "";
    return { success: false, error: errorCodes ? `人機驗證未通過 (${errorCodes})` : "人機驗證未通過或憑證已失效" };
  } catch (error) {
    return { success: false, error: `無法連線至 Cap 驗證伺服器：${error?.message || error}` };
  }
}

/** SHA-256 → 小寫 hex（WebCrypto，Workers 相容）。 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 由訪客提交的兌換憑證（`id:vertoken`）重新推導 tokenKey。
 * 保留供本地端點相容。
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
