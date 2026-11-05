// API 出口代理（HTTP / HTTPS / SOCKS5）核心模組：
// 支援資料庫存取、加密儲存、連線測試，以及底層代理 fetch 分發。
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { decryptProxyPassword, encryptProxyPassword } from "./credential-crypto.js";

/**
 * @typedef {Object} ProxyConfig
 * @property {boolean} enabled
 * @property {"http" | "https" | "socks5"} protocol
 * @property {string} host
 * @property {number} port
 * @property {string} [username]
 * @property {string} [password]
 * @property {string} [passwordHint]
 */

// 輕量記憶體快取：5 秒 TTL，避免高頻請求重複查詢 D1
let cachedProxy = null;
let cacheExpiresAt = 0;

export function invalidateProxyCache() {
  cachedProxy = null;
  cacheExpiresAt = 0;
}

/**
 * 讀取資料庫中的代理設定並解密密碼。未設定時回傳預設停用物件。
 * @param {D1Database} db
 * @param {string} encryptionKey
 * @returns {Promise<ProxyConfig>}
 */
export async function getProxySettings(db, encryptionKey) {
  if (!db) {
    return {
      enabled: false,
      protocol: "http",
      host: "",
      port: 8080,
      username: "",
      password: "",
      passwordHint: "",
    };
  }

  const row = await db
    .prepare(
      "SELECT enabled, protocol, host, port, username, password_ciphertext, password_iv, password_hint FROM proxy_settings WHERE id = 1",
    )
    .first();

  if (!row) {
    return {
      enabled: false,
      protocol: "http",
      host: "",
      port: 8080,
      username: "",
      password: "",
      passwordHint: "",
    };
  }

  let password = "";
  if (row.password_ciphertext && row.password_iv && encryptionKey) {
    try {
      password = await decryptProxyPassword(
        {
          clientSecretCiphertext: row.password_ciphertext,
          clientSecretIv: row.password_iv,
        },
        encryptionKey,
      );
    } catch (e) {
      console.error("代理密碼解密失敗:", e);
    }
  }

  return {
    enabled: Boolean(row.enabled),
    protocol: row.protocol || "http",
    host: row.host || "",
    port: Number(row.port) || 8080,
    username: row.username || "",
    password,
    passwordHint: row.password_hint || "",
  };
}

/**
 * 儲存代理設定至資料庫（密碼加密存儲）。
 * @param {D1Database} db
 * @param {string} encryptionKey
 * @param {ProxyConfig} config
 */
export async function saveProxySettings(db, encryptionKey, config) {
  let ciphertext = null;
  let iv = null;
  let hint = null;

  if (config.password && config.password.trim()) {
    const enc = await encryptProxyPassword(config.password.trim(), encryptionKey);
    ciphertext = enc.clientSecretCiphertext;
    iv = enc.clientSecretIv;
    hint = config.password.slice(-3);
  } else if (!config.password && config.password !== "") {
    // 未帶密碼表示保留舊密碼
    const existing = await db
      .prepare("SELECT password_ciphertext, password_iv, password_hint FROM proxy_settings WHERE id = 1")
      .first();
    if (existing) {
      ciphertext = existing.password_ciphertext;
      iv = existing.password_iv;
      hint = existing.password_hint;
    }
  }

  await db
    .prepare(
      `INSERT INTO proxy_settings (id, enabled, protocol, host, port, username, password_ciphertext, password_iv, password_hint, updated_at)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         enabled = ?1, protocol = ?2, host = ?3, port = ?4, username = ?5,
         password_ciphertext = ?6, password_iv = ?7, password_hint = ?8,
         updated_at = datetime('now')`,
    )
    .bind(
      config.enabled ? 1 : 0,
      config.protocol || "http",
      config.host.trim(),
      Number(config.port) || 8080,
      config.username ? config.username.trim() : null,
      ciphertext,
      iv,
      hint,
    )
    .run();

  invalidateProxyCache();
}

/**
 * 取得當前已啟用的代理設定（含記憶體短快取）。
 * @param {object} env Worker 環境
 * @returns {Promise<ProxyConfig | null>}
 */
export async function resolveProxyConfig(env) {
  if (!env?.DB) return null;
  const now = Date.now();
  if (cachedProxy && now < cacheExpiresAt) {
    return cachedProxy;
  }

  const settings = await getProxySettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY);
  if (settings && settings.enabled && settings.host && settings.port) {
    cachedProxy = settings;
  } else {
    cachedProxy = null;
  }
  cacheExpiresAt = now + 5000;
  return cachedProxy;
}

/**
 * 透過指定代理發起 HTTP 請求，回傳 Web 標準 Response。
 * @param {string | URL} urlInput
 * @param {RequestInit} [init]
 * @param {ProxyConfig} proxyConfig
 * @returns {Promise<Response>}
 */
export async function proxyFetch(urlInput, init = {}, proxyConfig) {
  const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;

  let agent;
  const auth = proxyConfig.username && proxyConfig.password
    ? `${encodeURIComponent(proxyConfig.username)}:${encodeURIComponent(proxyConfig.password)}@`
    : "";

  if (proxyConfig.protocol === "socks5") {
    agent = new SocksProxyAgent(`socks5://${auth}${proxyConfig.host}:${proxyConfig.port}`);
  } else {
    agent = new HttpsProxyAgent(`http://${auth}${proxyConfig.host}:${proxyConfig.port}`);
  }

  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers || {});
    const requestOptions = {
      method: init.method || "GET",
      headers: Object.fromEntries(headers.entries()),
      agent,
    };

    const req = client.request(url, requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const bodyBuffer = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) responseHeaders.append(k, item);
          } else if (v !== undefined) {
            responseHeaders.set(k, v);
          }
        }
        resolve(
          new Response(bodyBuffer, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "",
            headers: responseHeaders,
          }),
        );
      });
    });

    req.on("error", (err) => {
      reject(new Error(`代理請求失敗 (${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}): ${err.message}`));
    });

    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy();
        reject(new Error("操作已中止"));
        return;
      }
      init.signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("操作已中止"));
      });
    }

    if (init.body) {
      if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
        req.write(init.body);
      } else if (init.body instanceof Uint8Array) {
        req.write(Buffer.from(init.body));
      }
    }
    req.end();
  });
}

/**
 * 統一對外 API 呼叫：若環境已啟用代理，自動經由代理出口發送；否則使用原生 fetch。
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @param {object} [env]
 * @returns {Promise<Response>}
 */
export async function outboundFetch(url, init = {}, env = null) {
  const proxy = env ? await resolveProxyConfig(env) : null;
  if (!proxy) {
    return fetch(url, init);
  }
  return proxyFetch(url, init, proxy);
}

/**
 * 測試指定代理連線狀態（獲取出口 IP 與測量延遲）。
 * @param {ProxyConfig} config
 * @returns {Promise<{ ok: boolean, exitIp?: string, latencyMs?: number, error?: string }>}
 */
export async function testProxyConnection(config) {
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const response = await proxyFetch(
      "https://api.ipify.org?format=json",
      { signal: controller.signal },
      config,
    );
    clearTimeout(timer);

    if (!response.ok) {
      return { ok: false, error: `代理伺服器回傳 HTTP ${response.status}` };
    }

    const data = await response.json().catch(() => ({}));
    const latencyMs = Date.now() - startTime;
    return {
      ok: true,
      exitIp: data.ip || "已連通（未能識別 IP）",
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startTime,
    };
  }
}
