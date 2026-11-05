// 人機驗證服務端工具：支援多渠道備援（Cap、Cloudflare Turnstile、hCaptcha）。
// 訪客端可切換不同驗證器，若任一服務異常可無縫切換備援。
import { decryptCaptchaSecret, encryptCaptchaSecret } from "./credential-crypto.js";
import { getAppSetting } from "./db.js";
import { outboundFetch } from "./proxy.js";

/** app_settings 中分享頁人機驗證總開關的鍵名。 */
export const SHARE_CAPTCHA_ENABLED_KEY = "share_captcha_enabled";

/** 支援的人機驗證服務商定義。 */
export const CAPTCHA_PROVIDERS = [
  { id: "cap", name: "Cap", requiresEndpoint: true },
  { id: "turnstile", name: "Cloudflare Turnstile", requiresEndpoint: false },
  { id: "hcaptcha", name: "hCaptcha", requiresEndpoint: false },
];

/** 分享頁人機驗證總開關（app_settings；未設定視為關閉）。 */
export async function isShareCaptchaEnabled(db) {
  return (await getAppSetting(db, SHARE_CAPTCHA_ENABLED_KEY)) === "1";
}

/**
 * 取得單一人機驗證渠道設定。
 * @param {object} env
 * @param {"cap" | "turnstile" | "hcaptcha"} provider
 */
export async function getCaptchaProvider(env, provider) {
  let endpoint = "";
  let siteKey = "";
  let secret = "";
  let secretHint = null;
  let source = null;
  let enabled = false;

  if (env?.DB) {
    const row = await env.DB
      .prepare(`SELECT provider, enabled, endpoint, site_key AS siteKey,
                       secret_ciphertext AS secretCiphertext, secret_iv AS secretIv,
                       secret_hint AS secretHint
                FROM captcha_providers WHERE provider = ?1`)
      .bind(provider)
      .first();

    if (row) {
      enabled = Boolean(row.enabled);
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
  if (provider === "cap") {
    if (!endpoint && env?.CAP_ENDPOINT) endpoint = String(env.CAP_ENDPOINT).trim();
    if (!siteKey && env?.CAP_SITE_KEY) siteKey = String(env.CAP_SITE_KEY).trim();
    if (!secret && env?.CAP_SECRET) {
      secret = String(env.CAP_SECRET).trim();
      secretHint = secret ? secret.slice(-4) : null;
      source = "env";
      enabled = true;
    }
  } else if (provider === "turnstile") {
    if (!siteKey && env?.TURNSTILE_SITE_KEY) siteKey = String(env.TURNSTILE_SITE_KEY).trim();
    if (!secret && env?.TURNSTILE_SECRET) {
      secret = String(env.TURNSTILE_SECRET).trim();
      secretHint = secret ? secret.slice(-4) : null;
      source = "env";
      enabled = true;
    }
  } else if (provider === "hcaptcha") {
    if (!siteKey && env?.HCAPTCHA_SITE_KEY) siteKey = String(env.HCAPTCHA_SITE_KEY).trim();
    if (!secret && env?.HCAPTCHA_SECRET) {
      secret = String(env.HCAPTCHA_SECRET).trim();
      secretHint = secret ? secret.slice(-4) : null;
      source = "env";
      enabled = true;
    }
  }

  const def = CAPTCHA_PROVIDERS.find(p => p.id === provider);
  const configured = def?.requiresEndpoint
    ? Boolean(endpoint && siteKey && secret)
    : Boolean(siteKey && secret);

  return {
    provider,
    name: def?.name || provider,
    enabled,
    configured,
    source,
    endpoint,
    siteKey,
    secret,
    secretHint: secretHint ? `····${secretHint}` : null,
  };
}

/** 取得所有已註冊的渠道設定狀態清單。 */
export async function getAllCaptchaProviders(env) {
  return await Promise.all(
    CAPTCHA_PROVIDERS.map(item => getCaptchaProvider(env, item.id))
  );
}

/** 取得所有已啟用且配置完成的渠道清單（供分享頁訪客使用）。 */
export async function getActiveCaptchaProviders(env) {
  const all = await getAllCaptchaProviders(env);
  return all.filter(item => item.configured && item.enabled);
}

/** 是否至少有一個人機驗證渠道已配置並啟用。 */
export async function isCapConfigured(env) {
  const active = await getActiveCaptchaProviders(env);
  return active.length > 0;
}

/** 相容舊別名。 */
export async function isCapSecretConfigured(env) {
  return await isCapConfigured(env);
}

/**
 * 儲存渠道設定。若 secret 為空且已有現有密鑰，則保留現有密鑰。
 */
export async function saveCaptchaProvider(db, encryptionKey, { provider, enabled, endpoint, siteKey, secret }) {
  const normalizedEndpoint = (endpoint || "").trim().replace(/\/+$/, "");
  const normalizedSiteKey = (siteKey || "").trim();

  const existing = await db
    .prepare("SELECT secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, secret_hint AS secretHint FROM captcha_providers WHERE provider = ?1")
    .bind(provider)
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
    throw new Error(`缺少 ${provider} 驗證密鑰 (Secret Key)`);
  }

  await db
    .prepare(`INSERT INTO captcha_providers (provider, enabled, endpoint, site_key, secret_ciphertext, secret_iv, secret_hint, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
      ON CONFLICT(provider) DO UPDATE SET
        enabled = ?2,
        endpoint = ?3,
        site_key = ?4,
        secret_ciphertext = ?5,
        secret_iv = ?6,
        secret_hint = ?7,
        updated_at = datetime('now')`)
    .bind(provider, enabled ? 1 : 0, normalizedEndpoint, normalizedSiteKey, ciphertext, iv, hint)
    .run();

  // 若為 cap，同步寫入 captcha_settings 表以相容舊 SQL
  if (provider === "cap") {
    try {
      await db
        .prepare(`INSERT INTO captcha_settings (id, endpoint, site_key, secret_ciphertext, secret_iv, secret_hint, updated_at)
          VALUES (1, ?1, ?2, ?3, ?4, ?5, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            endpoint = ?1, site_key = ?2, secret_ciphertext = ?3, secret_iv = ?4, secret_hint = ?5, updated_at = datetime('now')`)
        .bind(normalizedEndpoint, normalizedSiteKey, ciphertext, iv, hint)
        .run();
    } catch {
      // 舊表同步失敗不影響主邏輯
    }
  }
}

/** 清除特定渠道設定。 */
export async function clearCaptchaProvider(db, provider) {
  const result = await db.prepare("DELETE FROM captcha_providers WHERE provider = ?1").bind(provider).run();
  if (provider === "cap") {
    try {
      await db.prepare("DELETE FROM captcha_settings WHERE id = 1").run();
    } catch {
      // 略過
    }
  }
  return (result.meta.changes ?? 0) > 0;
}

// ─── 伺服端 Token 驗證 ─────────────────────────────────────

/**
 * 驗證 Cap (trycap.dev) token。
 */
export async function verifyCapToken(env, token) {
  const config = await getCaptchaProvider(env, "cap");
  if (!config.configured) {
    return { success: false, error: "Cap 人機驗證尚未完整配置" };
  }

  const baseUrl = config.endpoint.replace(/\/+$/, "");
  const primaryUrl = `${baseUrl}/${encodeURIComponent(config.siteKey)}/siteverify`;
  const payload = {
    secret: config.secret,
    response: token.trim(),
    token: token.trim(),
  };

  try {
    let res = await outboundFetch(primaryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
    }, env);

    if (res.status === 404) {
      res = await outboundFetch(`${baseUrl}/siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ ...payload, sitekey: config.siteKey }),
      }, env);
    }

    if (!res.ok) {
      return { success: false, error: `Cap 伺服器驗證失敗 (HTTP ${res.status})` };
    }

    const data = await res.json();
    if (data?.success === true) {
      return { success: true };
    }
    const errorCodes = Array.isArray(data?.["error-codes"]) ? data["error-codes"].join(", ") : "";
    return { success: false, error: errorCodes ? `Cap 驗證未通過 (${errorCodes})` : "Cap 驗證未通過或已失效" };
  } catch (error) {
    return { success: false, error: `無法連線至 Cap 驗證伺服器：${error?.message || error}` };
  }
}

/**
 * 驗證 Cloudflare Turnstile token。
 * 遵循官方 siteverify 規範：POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 */
export async function verifyTurnstileToken(env, token) {
  const config = await getCaptchaProvider(env, "turnstile");
  if (!config.configured) {
    return { success: false, error: "Cloudflare Turnstile 人機驗證尚未配置" };
  }

  try {
    const formData = new URLSearchParams({
      secret: config.secret,
      response: token.trim(),
    });

    const res = await outboundFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    }, env);

    if (!res.ok) {
      return { success: false, error: `Cloudflare Turnstile 驗證失敗 (HTTP ${res.status})` };
    }

    const data = await res.json();
    if (data?.success === true) {
      return { success: true };
    }
    const errorCodes = Array.isArray(data?.["error-codes"]) ? data["error-codes"].join(", ") : "";
    return { success: false, error: errorCodes ? `Turnstile 驗證未通過 (${errorCodes})` : "Turnstile 驗證未通過或已過期" };
  } catch (error) {
    return { success: false, error: `無法連線至 Cloudflare 驗證伺服器：${error?.message || error}` };
  }
}

/**
 * 驗證 hCaptcha token。
 * 遵循官方 siteverify 規範：POST https://api.hcaptcha.com/siteverify
 */
export async function verifyHcaptchaToken(env, token) {
  const config = await getCaptchaProvider(env, "hcaptcha");
  if (!config.configured) {
    return { success: false, error: "hCaptcha 人機驗證尚未配置" };
  }

  try {
    const formData = new URLSearchParams({
      secret: config.secret,
      response: token.trim(),
      sitekey: config.siteKey,
    });

    const res = await outboundFetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    }, env);

    if (!res.ok) {
      return { success: false, error: `hCaptcha 驗證失敗 (HTTP ${res.status})` };
    }

    const data = await res.json();
    if (data?.success === true) {
      return { success: true };
    }
    const errorCodes = Array.isArray(data?.["error-codes"]) ? data["error-codes"].join(", ") : "";
    return { success: false, error: errorCodes ? `hCaptcha 驗證未通過 (${errorCodes})` : "hCaptcha 驗證未通過或已過期" };
  } catch (error) {
    return { success: false, error: `無法連線至 hCaptcha 驗證伺服器：${error?.message || error}` };
  }
}

/**
 * 依據指定的 provider 進行伺服端驗證。
 * @param {object} env
 * @param {string} [provider="cap"]
 * @param {string} token
 */
export async function verifyCaptchaToken(env, provider, token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { success: false, error: "未提供驗證憑證 (token)" };
  }
  const cleanProvider = (provider || "cap").toLowerCase();
  switch (cleanProvider) {
    case "cap":
      return await verifyCapToken(env, token);
    case "turnstile":
    case "cloudflare":
      return await verifyTurnstileToken(env, token);
    case "hcaptcha":
      return await verifyHcaptchaToken(env, token);
    default:
      return { success: false, error: `未支援的人機驗證渠道：${provider}` };
  }
}

// ─── 舊版本相容別名 ───────────────────────────────────────
/** Challenge 與兌換憑證綁定的 scope（相容舊版本地端點）。 */
export const CAP_SCOPE = "share-rotate";

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

export async function getCapSettings(env) {
  return await getCaptchaProvider(env, "cap");
}
export async function getCapSecret(env) {
  const s = await getCapSettings(env);
  return s.secret ? { secret: s.secret, source: s.source } : null;
}
export async function saveCaptchaSettings(db, encryptionKey, { endpoint, siteKey, secret }) {
  return await saveCaptchaProvider(db, encryptionKey, {
    provider: "cap",
    enabled: true,
    endpoint,
    siteKey,
    secret,
  });
}
export async function saveCaptchaSecret(db, encryptionKey, secret) {
  return await saveCaptchaSettings(db, encryptionKey, { endpoint: "", siteKey: "", secret });
}
export async function clearCaptchaSettings(db) {
  return await clearCaptchaProvider(db, "cap");
}
export async function clearCaptchaSecret(db) {
  return await clearCaptchaSettings(db);
}
