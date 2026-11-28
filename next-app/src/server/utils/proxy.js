// API 出口代理核心模組：
// 支援代理池管理、密碼加密、連線測試，以及對特定帳號的代理請求分發。
// 在 Cloudflare Workers 環境下透過 cloudflare:sockets 進行 TCP/TLS 隧道建立；
// 在 Node.js 本地開發環境下透過 https-proxy-agent / socks-proxy-agent 轉送。
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { bytesToBase64 } from "./bytes.js";
import { decryptProxyPassword } from "./credential-crypto.js";
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

// Fetch 規格定義不可攜帶回應 body 的狀態碼（傳入非 null body 會拋 TypeError）
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

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

/** 判斷 HTTP 狀態碼是否屬於 Fetch 規格禁止攜帶 body 的狀態碼。 */
export function isNullBodyStatus(status) {
  return NULL_BODY_STATUSES.has(Number(status));
}

/** 去除 IPv6 主機外層方括號（供 connect()、SNI 與位址解析使用）。 */
function stripBrackets(host) {
  const text = String(host || "").trim();
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

/** 為未加方括號的 IPv6 位址補上方括號（供 URL、Host 與 CONNECT 標頭使用）。 */
function bracketHost(host) {
  const bare = stripBrackets(host);
  return bare.includes(":") ? `[${bare}]` : bare;
}

/** 組合 Node 代理套件用的代理 URL（自動為 IPv6 host 補上方括號並編碼帳密）。 */
export function buildProxyUrl(proxyConfig) {
  const protocol = String(proxyConfig?.protocol || "http").toLowerCase();
  const host = bracketHost(proxyConfig?.host || "");
  const port = Number(proxyConfig?.port);
  let authPart = "";
  if (proxyConfig?.username || proxyConfig?.password) {
    authPart = `${encodeURIComponent(proxyConfig.username || "")}:${encodeURIComponent(proxyConfig.password || "")}@`;
  }
  return `${protocol}://${authPart}${host}:${port}`;
}

/** 將 Fetch 請求 body 正規化為 Uint8Array（無 body 時回 null）。 */
export function normalizeRequestBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  throw new Error("出口代理不支援此類型的請求內容（Body）");
}

/** 合併多段 Uint8Array。 */
function concatBytes(chunks) {
  const total = chunks.reduce((sum, item) => sum + item.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** 尋找 CRLF（\r\n）位置；找不到回 -1。 */
function indexOfCrlf(bytes, fromIndex = 0) {
  for (let i = fromIndex; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return i;
  }
  return -1;
}

/**
 * 解碼 HTTP/1.1 Transfer-Encoding: chunked 回應本體（RFC 9112 §7.1）。
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function decodeChunkedBody(bytes) {
  const parts = [];
  let cursor = 0;
  const decoder = new TextDecoder();

  while (cursor < bytes.length) {
    const lineEnd = indexOfCrlf(bytes, cursor);
    if (lineEnd === -1) {
      throw new Error("HTTP chunked 回應格式不完整（缺少區塊長度結尾）");
    }
    const sizeLine = decoder.decode(bytes.subarray(cursor, lineEnd));
    const sizeHex = sizeLine.split(";")[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeHex)) {
      throw new Error(`HTTP chunked 區塊長度無效：${sizeHex}`);
    }
    const chunkSize = parseInt(sizeHex, 16);
    cursor = lineEnd + 2;

    if (chunkSize === 0) {
      break;
    }
    if (cursor + chunkSize > bytes.length) {
      throw new Error("HTTP chunked 回應本體遭截斷");
    }
    parts.push(bytes.subarray(cursor, cursor + chunkSize));
    cursor += chunkSize;

    // 每個區塊結尾應為 \r\n
    if (cursor + 1 < bytes.length && bytes[cursor] === 0x0d && bytes[cursor + 1] === 0x0a) {
      cursor += 2;
    }
  }
  return concatBytes(parts);
}

/** 嘗試將 IPv4 字串轉為 4 位元組；非 IPv4 回 null。 */
function parseIpv4Bytes(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value < 0 || value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** 嘗試將 IPv6 字串轉為 16 位元組；非 IPv6 回 null。 */
function parseIpv6Bytes(host) {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0) return null;
  const groups = halves.length === 2
    ? [...head, ...Array(missing).fill("0"), ...tail]
    : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    view.setUint16(i * 2, parseInt(groups[i], 16), false);
  }
  return bytes;
}

/** 建立支援精確位元組與 CRLFCRLF 邊界讀取的串流緩衝讀取器，避免 TCP 分包／黏包破壞協定。 */
function createBufferedReader(reader) {
  let leftover = new Uint8Array(0);

  async function pullMore() {
    const { value, done } = await reader.read();
    if (done || !value) return false;
    leftover = leftover.byteLength > 0 ? concatBytes([leftover, value]) : value;
    return true;
  }

  return {
    async readExact(count, label) {
      while (leftover.byteLength < count) {
        const ok = await pullMore();
        if (!ok) {
          throw new Error(`代理連線於讀取${label}時提前關閉`);
        }
      }
      const chunk = leftover.subarray(0, count);
      leftover = leftover.subarray(count);
      return chunk;
    },
    async readUntilHeaderEnd(maxBytes = 65536) {
      while (true) {
        for (let i = 0; i <= leftover.byteLength - 4; i += 1) {
          if (
            leftover[i] === 0x0d
            && leftover[i + 1] === 0x0a
            && leftover[i + 2] === 0x0d
            && leftover[i + 3] === 0x0a
          ) {
            const headerBytes = leftover.subarray(0, i);
            leftover = leftover.subarray(i + 4);
            return headerBytes;
          }
        }
        if (leftover.byteLength > maxBytes) {
          throw new Error("代理交握回應標頭過長");
        }
        const ok = await pullMore();
        if (!ok) {
          throw new Error("HTTP 代理在交握建立前中斷連線");
        }
      }
    },
    drainLeftover() {
      const rest = leftover;
      leftover = new Uint8Array(0);
      return rest;
    },
  };
}

/** 載入 Cloudflare Workers 專屬的 cloudflare:sockets（非 workerd 環境回 null）。 */
async function loadCloudflareSockets() {
  try {
    // @ts-expect-error cloudflare:sockets 僅存在於 workerd 執行期
    const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "cloudflare:sockets").catch(() => ({}));
    return typeof mod?.connect === "function" ? mod : null;
  } catch {
    return null;
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

/** 組合 UTF-8 安全的 HTTP Basic Proxy-Authorization 標頭值。 */
function buildBasicProxyAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username || ""}:${password || ""}`);
  return `Basic ${bytesToBase64(bytes)}`;
}

/** 計算目標 URL 的 Host 標頭值（非標準埠必帶 :port，IPv6 帶方括號）。 */
function formatTargetHostHeader(targetUrl, isHttps, targetPort) {
  const host = bracketHost(targetUrl.hostname);
  const isDefaultPort = (isHttps && targetPort === 443) || (!isHttps && targetPort === 80);
  return isDefaultPort ? host : `${host}:${targetPort}`;
}

/**
 * Cloudflare Workers 專用的 Socket 代理 fetch 實作。
 */
async function cfSocketProxyFetch(urlInput, init = {}, proxyConfig) {
  if (init.signal?.aborted) {
    throw init.signal.reason || new DOMException("The operation was aborted.", "AbortError");
  }

  const sockets = await loadCloudflareSockets();
  if (!sockets?.connect) {
    throw new Error("cloudflare:sockets is not available in the current runtime environment");
  }
  const { connect } = sockets;

  const targetUrl = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
  const targetHostBare = stripBrackets(targetUrl.hostname);
  const targetHostBracketed = bracketHost(targetUrl.hostname);
  const isHttps = targetUrl.protocol === "https:";
  const targetPort = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);
  const relativePath = (targetUrl.pathname || "/") + targetUrl.search;
  const method = String(init.method || "GET").toUpperCase();

  const proxyProtocol = String(proxyConfig.protocol || "http").toLowerCase();
  const proxyPort = Number(proxyConfig.port);
  const proxyHostBare = stripBrackets(proxyConfig.host);

  if (proxyProtocol === "https" && isHttps) {
    throw new Error(
      "Cloudflare Workers 環境不支援經由 HTTPS 代理連線 HTTPS 目標（不支援雙層巢狀 TLS），請改用 HTTP 或 SOCKS5 代理。",
    );
  }

  const bodyBytes = normalizeRequestBody(init.body);
  const secureTransport = proxyProtocol === "https"
    ? "on"
    : (isHttps ? "starttls" : "off");

  const socket = connect(
    { hostname: proxyHostBare, port: proxyPort },
    { secureTransport },
  );

  let activeSocket = socket;
  let writer = null;
  let reader = null;
  let aborted = false;

  const abortError = () => init.signal?.reason || new DOMException("The operation was aborted.", "AbortError");
  const onAbort = () => {
    aborted = true;
    try {
      activeSocket?.close?.();
    } catch {}
    if (activeSocket !== socket) {
      try {
        socket?.close?.();
      } catch {}
    }
  };
  init.signal?.addEventListener("abort", onAbort, { once: true });

  const ensureNotAborted = () => {
    if (aborted || init.signal?.aborted) {
      throw abortError();
    }
  };

  try {
    await socket.opened;
    ensureNotAborted();

    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    const buffered = createBufferedReader(reader);
    const needsTunnel = proxyProtocol === "socks5" || isHttps;

    if (proxyProtocol === "socks5") {
      // SOCKS5 交握 (RFC 1928)
      const hasAuth = Boolean(proxyConfig.username || proxyConfig.password);
      const greeting = hasAuth
        ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
        : new Uint8Array([0x05, 0x01, 0x00]);
      await writer.write(greeting);

      const gRes = await buffered.readExact(2, "SOCKS5 交握回應");
      if (gRes[0] !== 0x05) {
        throw new Error("SOCKS5 代理交握協議不相容");
      }

      if (gRes[1] === 0x02) {
        // 帳號密碼認證 (RFC 1929)
        const uBytes = new TextEncoder().encode(proxyConfig.username || "");
        const pBytes = new TextEncoder().encode(proxyConfig.password || "");
        if (uBytes.length > 255 || pBytes.length > 255) {
          throw new Error("SOCKS5 代理帳號或密碼長度超過協定上限（255 位元組）");
        }
        const authReq = new Uint8Array(3 + uBytes.length + pBytes.length);
        authReq[0] = 0x01;
        authReq[1] = uBytes.length;
        authReq.set(uBytes, 2);
        authReq[2 + uBytes.length] = pBytes.length;
        authReq.set(pBytes, 3 + uBytes.length);
        await writer.write(authReq);

        const aRes = await buffered.readExact(2, "SOCKS5 認證回應");
        if (aRes[0] !== 0x01 || aRes[1] !== 0x00) {
          throw new Error("SOCKS5 代理認證失敗：帳號或密碼錯誤");
        }
      } else if (gRes[1] !== 0x00) {
        throw new Error(`SOCKS5 代理認證方式不支援 (method: ${gRes[1]})`);
      }

      // 依目標位址型態組裝 SOCKS5 CONNECT 請求（IPv4 / IPv6 / 網域名稱）
      const ipv4Bytes = parseIpv4Bytes(targetHostBare);
      const ipv6Bytes = ipv4Bytes ? null : parseIpv6Bytes(targetHostBare);
      let req;
      if (ipv4Bytes) {
        req = new Uint8Array(4 + 4 + 2);
        req[3] = 0x01;
        req.set(ipv4Bytes, 4);
      } else if (ipv6Bytes) {
        req = new Uint8Array(4 + 16 + 2);
        req[3] = 0x04;
        req.set(ipv6Bytes, 4);
      } else {
        const domainBytes = new TextEncoder().encode(targetHostBare);
        if (domainBytes.length > 255) {
          throw new Error("SOCKS5 目標主機名稱長度超過協定上限（255 位元組）");
        }
        req = new Uint8Array(4 + 1 + domainBytes.length + 2);
        req[3] = 0x03;
        req[4] = domainBytes.length;
        req.set(domainBytes, 5);
      }
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      new DataView(req.buffer).setUint16(req.length - 2, targetPort, false);
      await writer.write(req);

      // 嚴格依 ATYP 讀完完整 CONNECT 回應（含 BND.ADDR 與 BND.PORT），避免殘留位元組污染 TLS
      const cHead = await buffered.readExact(4, "SOCKS5 CONNECT 回應標頭");
      if (cHead[0] !== 0x05 || cHead[1] !== 0x00) {
        throw new Error(`SOCKS5 代理連線目標主機失敗 (狀態碼: ${cHead[1]})`);
      }
      const atyp = cHead[3];
      if (atyp === 0x01) {
        await buffered.readExact(6, "SOCKS5 IPv4 綁定位址");
      } else if (atyp === 0x04) {
        await buffered.readExact(18, "SOCKS5 IPv6 綁定位址");
      } else if (atyp === 0x03) {
        const lenBuf = await buffered.readExact(1, "SOCKS5 網域長度");
        await buffered.readExact(lenBuf[0] + 2, "SOCKS5 網域綁定位址");
      } else {
        throw new Error(`SOCKS5 代理回傳不支援的位址類型 (ATYP: ${atyp})`);
      }
    } else if (isHttps) {
      // HTTP CONNECT 隧道交握（目標為 HTTPS）
      const authority = `${targetHostBracketed}:${targetPort}`;
      let connectReq = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
      if (proxyConfig.username || proxyConfig.password) {
        connectReq += `Proxy-Authorization: ${buildBasicProxyAuth(proxyConfig.username, proxyConfig.password)}\r\n`;
      }
      connectReq += "\r\n";
      await writer.write(new TextEncoder().encode(connectReq));

      const headerBytes = await buffered.readUntilHeaderEnd();
      const statusLine = new TextDecoder().decode(headerBytes).split("\r\n")[0] || "";
      if (!/^HTTP\/\d\.\d\s+200(?:\s|$)/.test(statusLine)) {
        throw new Error(`HTTP 代理拒絕 CONNECT 請求: ${statusLine}`);
      }
    }

    ensureNotAborted();

    let initialResponseLeftover = buffered.drainLeftover();

    if (isHttps) {
      // 升級為目標 TLS 前先釋放舊 Socket 的讀寫鎖定
      writer.releaseLock();
      reader.releaseLock();
      writer = null;
      reader = null;

      activeSocket = socket.startTls({ expectedServerHostname: targetHostBare });
      await activeSocket.opened;
      ensureNotAborted();

      writer = activeSocket.writable.getWriter();
      reader = activeSocket.readable.getReader();
      initialResponseLeftover = new Uint8Array(0);
    }

    // 組裝並發送實際 HTTP/1.1 請求
    const headers = new Headers(init.headers || {});
    if (!headers.has("Host")) {
      headers.set("Host", formatTargetHostHeader(targetUrl, isHttps, targetPort));
    }
    if (bodyBytes !== null) {
      if (!headers.has("Content-Length")) {
        headers.set("Content-Length", String(bodyBytes.byteLength));
      }
    } else if ((method === "POST" || method === "PUT" || method === "PATCH") && !headers.has("Content-Length")) {
      headers.set("Content-Length", "0");
    }
    if (!needsTunnel && (proxyConfig.username || proxyConfig.password)) {
      headers.set("Proxy-Authorization", buildBasicProxyAuth(proxyConfig.username, proxyConfig.password));
    }
    headers.set("Connection", "close");

    // 透過 HTTP/HTTPS 代理直接請求明文 HTTP 目標時使用絕對 URI；隧道內使用相對路徑
    const requestTarget = needsTunnel ? relativePath : targetUrl.toString();
    let rawReq = `${method} ${requestTarget} HTTP/1.1\r\n`;
    for (const [key, value] of headers.entries()) {
      rawReq += `${key}: ${value}\r\n`;
    }
    rawReq += "\r\n";

    await writer.write(new TextEncoder().encode(rawReq));
    if (bodyBytes && bodyBytes.byteLength > 0) {
      await writer.write(bodyBytes);
    }

    // 接收完整 HTTP 回應
    const chunks = initialResponseLeftover.byteLength > 0 ? [initialResponseLeftover] : [];
    while (true) {
      const { value, done } = await reader.read();
      ensureNotAborted();
      if (done) break;
      if (value && value.byteLength > 0) chunks.push(value);
    }

    const combined = concatBytes(chunks);
    let sepIdx = -1;
    for (let i = 0; i <= combined.length - 4; i += 1) {
      if (
        combined[i] === 0x0d
        && combined[i + 1] === 0x0a
        && combined[i + 2] === 0x0d
        && combined[i + 3] === 0x0a
      ) {
        sepIdx = i;
        break;
      }
    }
    if (sepIdx === -1) {
      throw new Error("無法解析代理返回的 HTTP 回應標頭");
    }

    const rawHeaders = new TextDecoder().decode(combined.subarray(0, sepIdx));
    let responseBodyBytes = combined.subarray(sepIdx + 4);

    const headerLines = rawHeaders.split("\r\n");
    const firstLine = headerLines[0] || "";
    const statusMatch = firstLine.match(/^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/);
    if (!statusMatch) {
      throw new Error(`無法解析代理返回的 HTTP 狀態列：${firstLine}`);
    }
    const statusCode = Number(statusMatch[1]);
    const statusText = statusMatch[2] || "";

    const resHeaders = new Headers();
    for (let i = 1; i < headerLines.length; i += 1) {
      const line = headerLines[i];
      const colon = line.indexOf(":");
      if (colon > 0) {
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        resHeaders.append(key, val);
      }
    }

    if (isNullBodyStatus(statusCode) || method === "HEAD") {
      return new Response(null, {
        status: statusCode,
        statusText,
        headers: resHeaders,
      });
    }

    const transferEncoding = (resHeaders.get("transfer-encoding") || "").toLowerCase();
    if (transferEncoding.includes("chunked")) {
      responseBodyBytes = decodeChunkedBody(responseBodyBytes);
      resHeaders.delete("transfer-encoding");
      resHeaders.delete("content-length");
    }

    return new Response(responseBodyBytes, {
      status: statusCode,
      statusText,
      headers: resHeaders,
    });
  } catch (error) {
    if (aborted || init.signal?.aborted) {
      throw abortError();
    }
    throw error;
  } finally {
    init.signal?.removeEventListener("abort", onAbort);
    try { writer?.releaseLock(); } catch {}
    try { reader?.releaseLock(); } catch {}
    try { await activeSocket?.close?.(); } catch {}
    if (activeSocket !== socket) {
      try { await socket?.close?.(); } catch {}
    }
  }
}

/**
 * Node.js 本地環境下的代理 fetch 實作。
 */
async function nodeProxyFetch(urlInput, init = {}, proxyConfig) {
  const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
  const isHttps = url.protocol === "https:";
  const method = String(init.method || "GET").toUpperCase();
  const bodyBytes = normalizeRequestBody(init.body);
  const proxyUrl = buildProxyUrl(proxyConfig);

  const agent = String(proxyConfig.protocol || "http").toLowerCase() === "socks5"
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);

  const client = isHttps ? https : http;
  const headers = {};
  if (init.headers) {
    const rawHeaders = new Headers(init.headers);
    rawHeaders.forEach((val, key) => {
      headers[key] = val;
    });
  }
  if (bodyBytes !== null && !Object.keys(headers).some(key => key.toLowerCase() === "content-length")) {
    headers["content-length"] = String(bodyBytes.byteLength);
  }

  const options = {
    method,
    hostname: stripBrackets(url.hostname),
    port: url.port || (isHttps ? 443 : 80),
    path: (url.pathname || "/") + url.search,
    headers,
    agent,
    signal: init.signal,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const statusCode = res.statusCode || 200;
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) resHeaders.append(k, item);
          } else if (v !== undefined) {
            resHeaders.set(k, v);
          }
        }
        const responseBody = isNullBodyStatus(statusCode) || method === "HEAD"
          ? null
          : Buffer.concat(chunks);
        resolve(
          new Response(responseBody, {
            status: statusCode,
            statusText: res.statusMessage || "",
            headers: resHeaders,
          }),
        );
      });
    });

    req.on("error", (err) => reject(err));
    if (bodyBytes && bodyBytes.byteLength > 0) {
      req.write(Buffer.from(bodyBytes));
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

  const cf = await loadCloudflareSockets();
  if (cf) {
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
