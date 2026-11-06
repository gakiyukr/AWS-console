// API 出口代理核心模組：
// 支援代理池管理、密碼加密、連線測試，以及對特定帳號的代理請求分發。
// 在 Cloudflare Workers 環境下透過 cloudflare:sockets 進行 TCP/TLS 隧道建立；
// 在 Node.js 本地開發環境下透過 https-proxy-agent / socks-proxy-agent 轉送。
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { decryptProxyPassword } from "./credential-crypto.js";

// cloudflare:sockets 透過 webpackIgnore 動態 import，避免 new Function 觸發 V8 EvalError。
import { getProxyById } from "./db.js";

/**
 * @typedef {Object} ProxyConfig
 * @property {number} id
 * @property {string} name
 * @property {"http" | "https" | "socks5"} protocol
 * @property {string} host
 * @property {number} port
 * @property {string} [username]
 * @property {string} [password]
 * @property {string} [passwordHint]
 */

// 輕量記憶體快取：依 proxyId 快取 10 秒，避免批次查詢時重複讀取與解密
/** @type {Map<number, { proxy: ProxyConfig, expiresAt: number }>} */
const proxyCache = new Map();

/**
 * 使代理快取失效（更新／刪除後呼叫）；不帶 id 時全部清除。
 * @param {number | null} [proxyId]
 */
export function invalidateProxyCache(proxyId = null) {
  if (proxyId != null) {
    proxyCache.delete(Number(proxyId));
  } else {
    proxyCache.clear();
  }
}

/**
 * 依 proxyId 讀取代理設定並解密密碼（含 10 秒記憶體快取）。
 * @param {D1Database} db
 * @param {number} proxyId
 * @param {string} encryptionKey
 * @returns {Promise<ProxyConfig | null>}
 */
export async function getProxyWithDecryptedPassword(db, proxyId, encryptionKey) {
  const idNum = Number(proxyId);
  if (!idNum || !db) return null;

  const now = Date.now();
  const cached = proxyCache.get(idNum);
  if (cached && now < cached.expiresAt) {
    return cached.proxy;
  }

  const row = await getProxyById(db, idNum);
  if (!row) return null;

  let password = "";
  if (row.passwordCiphertext && row.passwordIv && encryptionKey) {
    try {
      password = await decryptProxyPassword(
        {
          clientSecretCiphertext: row.passwordCiphertext,
          clientSecretIv: row.passwordIv,
        },
        encryptionKey,
      );
    } catch (e) {
      console.error(`代理 #${idNum} 密碼解密失敗:`, e);
    }
  }

  const proxy = {
    id: row.id,
    name: row.name,
    protocol: row.protocol || "http",
    host: row.host,
    port: Number(row.port),
    username: row.username || "",
    password,
    passwordHint: row.passwordHint || "",
  };

  proxyCache.set(idNum, { proxy, expiresAt: now + 10000 });
  return proxy;
}

/**
 * Cloudflare Workers 專用的 Socket 代理 fetch 實作。
 */
async function cfSocketProxyFetch(urlInput, init = {}, proxyConfig) {
  // @ts-expect-error cloudflare:sockets 僅存在於 workerd 執行期
  const sockets = /** @type {{ connect?: Function }} */ (
    await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "cloudflare:sockets").catch(() => ({}))
  );
  if (!sockets?.connect) {
    throw new Error("cloudflare:sockets is not available in the current runtime environment");
  }
  const { connect } = sockets;
  const targetUrl = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
  const targetHost = targetUrl.hostname;
  const isHttps = targetUrl.protocol === "https:";
  const targetPort = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);
  const path = targetUrl.pathname + targetUrl.search;
  const method = init.method || "GET";

  const proxyPort = Number(proxyConfig.port);
  const proxyHost = proxyConfig.host;

  const socket = connect(
    { hostname: proxyHost, port: proxyPort },
    { secureTransport: isHttps ? "starttls" : "off" },
  );
  await socket.opened;

  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();

  if (proxyConfig.protocol === "socks5") {
    // SOCKS5 交握 (RFC 1928)
    const hasAuth = Boolean(proxyConfig.username && proxyConfig.password);
    const greeting = hasAuth
      ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
      : new Uint8Array([0x05, 0x01, 0x00]);
    await writer.write(greeting);

    const { value: gRes, done: gDone } = await reader.read();
    if (gDone || !gRes || gRes[0] !== 0x05) {
      throw new Error("SOCKS5 代理交握協議不相容");
    }

    if (gRes[1] === 0x02) {
      // 帳號密碼認證 (RFC 1929)
      const uBytes = new TextEncoder().encode(proxyConfig.username || "");
      const pBytes = new TextEncoder().encode(proxyConfig.password || "");
      const authReq = new Uint8Array(1 + 1 + uBytes.length + 1 + pBytes.length);
      authReq[0] = 0x01;
      authReq[1] = uBytes.length;
      authReq.set(uBytes, 2);
      authReq[2 + uBytes.length] = pBytes.length;
      authReq.set(pBytes, 3 + uBytes.length);
      await writer.write(authReq);

      const { value: aRes, done: aDone } = await reader.read();
      if (aDone || !aRes || aRes[1] !== 0x00) {
        throw new Error("SOCKS5 代理認證失敗：帳號或密碼錯誤");
      }
    } else if (gRes[1] !== 0x00) {
      throw new Error(`SOCKS5 代理認證方式不支援 (method: ${gRes[1]})`);
    }

    // 發送 CONNECT 請求
    const domainBytes = new TextEncoder().encode(targetHost);
    const req = new Uint8Array(4 + 1 + domainBytes.length + 2);
    req[0] = 0x05;
    req[1] = 0x01;
    req[2] = 0x00;
    req[3] = 0x03;
    req[4] = domainBytes.length;
    req.set(domainBytes, 5);
    new DataView(req.buffer).setUint16(req.length - 2, targetPort, false);
    await writer.write(req);

    const { value: cRes, done: cDone } = await reader.read();
    if (cDone || !cRes || cRes[1] !== 0x00) {
      throw new Error(`SOCKS5 代理連線目標主機失敗 (狀態碼: ${cRes ? cRes[1] : "EOF"})`);
    }
  } else {
    // HTTP CONNECT 隧道交握
    let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
    if (proxyConfig.username) {
      const auth = btoa(`${proxyConfig.username}:${proxyConfig.password || ""}`);
      connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
    }
    connectReq += "\r\n";
    await writer.write(new TextEncoder().encode(connectReq));

    let headerBuf = "";
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("HTTP 代理在交握建立前中斷連線");
      headerBuf += decoder.decode(value, { stream: true });
      if (headerBuf.includes("\r\n\r\n")) break;
    }
    const statusLine = headerBuf.split("\r\n")[0] || "";
    if (!statusLine.includes(" 200")) {
      throw new Error(`HTTP 代理拒絕 CONNECT 請求: ${statusLine}`);
    }
  }

  // 升級前釋放舊 Socket 的讀寫鎖定
  writer.releaseLock();
  reader.releaseLock();

  let activeSocket = socket;
  if (isHttps) {
    activeSocket = socket.startTls({ expectedServerHostname: targetHost });
    await activeSocket.opened;
  }

  writer = activeSocket.writable.getWriter();
  reader = activeSocket.readable.getReader();

  // 發送實際的 HTTP 請求
  const headers = new Headers(init.headers || {});
  if (!headers.has("Host")) headers.set("Host", targetHost);
  headers.set("Connection", "close");

  let rawReq = `${method} ${path} HTTP/1.1\r\n`;
  for (const [key, value] of headers.entries()) {
    rawReq += `${key}: ${value}\r\n`;
  }
  rawReq += "\r\n";

  await writer.write(new TextEncoder().encode(rawReq));
  if (init.body) {
    if (typeof init.body === "string") {
      await writer.write(new TextEncoder().encode(init.body));
    } else if (init.body instanceof Uint8Array) {
      await writer.write(init.body);
    }
  }

  // 接收完整 HTTP 回應
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  try {
    writer.releaseLock();
    reader.releaseLock();
    await activeSocket.close();
  } catch {}

  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.length;
  }

  let sepIdx = -1;
  for (let i = 0; i < combined.length - 3; i++) {
    if (combined[i] === 13 && combined[i + 1] === 10 && combined[i + 2] === 13 && combined[i + 3] === 10) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx === -1) {
    throw new Error("無法解析代理返回的 HTTP 回應標頭");
  }

  const rawHeaders = new TextDecoder().decode(combined.subarray(0, sepIdx));
  const bodyBytes = combined.subarray(sepIdx + 4);

  const headerLines = rawHeaders.split("\r\n");
  const firstLine = headerLines[0] || "";
  const statusMatch = firstLine.match(/HTTP\/\d\.\d\s+(\d+)/);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 200;

  const resHeaders = new Headers();
  for (let i = 1; i < headerLines.length; i++) {
    const line = headerLines[i];
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      resHeaders.append(key, val);
    }
  }

  return new Response(bodyBytes, {
    status: statusCode,
    headers: resHeaders,
  });
}

/**
 * Node.js 本地環境下的代理 fetch 實作。
 */
async function nodeProxyFetch(urlInput, init = {}, proxyConfig) {
  const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
  const isHttps = url.protocol === "https:";

  let authPart = "";
  if (proxyConfig.username) {
    authPart = `${encodeURIComponent(proxyConfig.username)}:${encodeURIComponent(proxyConfig.password || "")}@`;
  }
  const proxyUrl = `${proxyConfig.protocol}://${authPart}${proxyConfig.host}:${proxyConfig.port}`;

  let agent = null;
  if (proxyConfig.protocol === "socks5") {
    agent = new SocksProxyAgent(proxyUrl);
  } else {
    agent = new HttpsProxyAgent(proxyUrl);
  }

  const client = isHttps ? https : http;
  const headers = {};
  if (init.headers) {
    const rawHeaders = new Headers(init.headers);
    rawHeaders.forEach((val, key) => {
      headers[key] = val;
    });
  }

  const options = {
    method: init.method || "GET",
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers,
    agent,
    signal: init.signal,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const bodyBuffer = Buffer.concat(chunks);
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) resHeaders.append(k, item);
          } else if (v !== undefined) {
            resHeaders.set(k, v);
          }
        }
        resolve(
          new Response(bodyBuffer, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "",
            headers: resHeaders,
          }),
        );
      });
    });

    req.on("error", (err) => reject(err));
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
 * 透過指定代理發起 HTTP 請求，回傳 Web 標準 Response。
 * @param {string | URL} urlInput
 * @param {RequestInit} [init]
 * @param {ProxyConfig} proxyConfig
 * @returns {Promise<Response>}
 */
export async function fetchViaProxy(urlInput, init = {}, proxyConfig) {
  if (!proxyConfig || !proxyConfig.host || !proxyConfig.port) {
    return fetch(urlInput, init);
  }

  let cfAvailable = false;
  try {
    // @ts-expect-error cloudflare:sockets 僅存在於 workerd 執行期
    const cf = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "cloudflare:sockets");
    cfAvailable = Boolean(cf?.connect);
  } catch {}

  if (cfAvailable) {
    return cfSocketProxyFetch(urlInput, init, proxyConfig);
  }
  return nodeProxyFetch(urlInput, init, proxyConfig);
}

/**
 * 測試指定代理連線狀態（測量延遲並取得出口 IP）。
 * @param {ProxyConfig} proxyConfig
 * @returns {Promise<{ ok: boolean, latencyMs?: number, exitIp?: string, error?: string }>}
 */
export async function testProxyConnection(proxyConfig) {
  const start = Date.now();
  try {
    const testUrl = "https://api.ipify.org?format=json";
    const res = await fetchViaProxy(
      testUrl,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      },
      proxyConfig,
    );

    if (!res.ok) {
      return { ok: false, error: `代理伺服器回應 HTTP ${res.status}` };
    }

    const data = await res.json();
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      latencyMs,
      exitIp: data.ip || "已連通",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "連線測試超時或失敗",
    };
  }
}
