// OCI API 請求簽章層（本專案核心）。
// 規格：docs.oracle.com「Signing Requests」——RSA-SHA256 的 HTTP 簽章
// （draft-cavage-http-signatures-08 變體，version="1"）。
// - 簽章字串：各 header 小寫名稱 + trim 過的值，每列一個；GET/DELETE 簽
//   (request-target)、host、date；POST/PUT 另簽 x-content-sha256、
//   content-type、content-length（空 body 一律送 `{}`，content-length: 2）。
// - keyId：<tenancy OCID>/<user OCID>/<fingerprint>。
// - 全程僅用 WebCrypto（RSASSA-PKCS1-v1_5 + SHA-256），Cloudflare Workers 相容。
import { base64ToBytes, bytesToBase64 } from "./bytes.js";
import { OciApiError, ociErrorFromResponse } from "./oci-error.js";

export function ociEndpoint(region) {
  return `https://iaas.${region}.oraclecloud.com`;
}

// ─── PEM 解析 ───────────────────────────────────────────────

/**
 * PEM 私鑰 → PKCS#8 DER 位元組。
 * OCI 主控台產生的 API Key 為 PKCS#8（BEGIN PRIVATE KEY）；OpenSSL 產生的
 * 舊型 PKCS#1（BEGIN RSA PRIVATE KEY）會在此包裝成 PKCS#8，避免使用者
 * 貼錯格式時只能得到晦澀的 importKey 錯誤。
 * @returns {Uint8Array}
 */
export function pemToPkcs8Der(pem) {
  const normalized = String(pem || "").trim();
  if (/ENCRYPTED PRIVATE KEY/.test(normalized)) {
    throw new Error("不支援含密碼保護的 PEM 私鑰，請先以 openssl 移除 passphrase");
  }

  const isPkcs8 = /-----BEGIN PRIVATE KEY-----/.test(normalized);
  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(normalized);
  if (!isPkcs8 && !isPkcs1) {
    throw new Error("PEM 私鑰格式無效（需為 BEGIN PRIVATE KEY 或 BEGIN RSA PRIVATE KEY）");
  }

  const body = normalized
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) {
    throw new Error("PEM 私鑰格式無效");
  }
  const der = base64ToBytes(body, "PEM 私鑰內容不是有效的 Base64");

  return isPkcs8 ? der : wrapPkcs1InPkcs8(der);
}

/** DER 長度編碼：<128 直接編碼，>=128 用 0x8N 長度前綴。 */
function derLength(length) {
  if (length < 128) {
    return [length];
  }
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** 將 PKCS#1 RSAPrivateKey 包進 PKCS#8 PrivateKeyInfo 外殼。 */
function wrapPkcs1InPkcs8(pkcs1Der) {
  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING <pkcs1> }
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetString = [0x04, ...derLength(pkcs1Der.length), ...pkcs1Der];
  const inner = [...version, ...algorithm, ...octetString];
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

/** 匯入 PEM 私鑰為可簽章的 CryptoKey（RSA-SHA256）。 */
export async function importSigningKey(pem) {
  const der = pemToPkcs8Der(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ─── 簽章字串 ───────────────────────────────────────────────

/**
 * 組出簽章字串與宣告用的 header 名單。
 * 每列 `name: value`；名稱小寫、值 trim，列間以 \n 連接、尾端無換行。
 * @param {{
 *   method: string,
 *   pathWithQuery: string,
 *   host: string,
 *   date: string,
 *   bodyText?: string | null,
 * }} parts
 * @returns {Promise<{
 *   signingString: string,
 *   headerNames: string[],
 *   headerValues: Record<string, string>,
 *   bodyText: string | null,
 * }>}
 */
export async function buildSigningString({ method, pathWithQuery, host, date, bodyText = null }) {
  const isBodyMethod = method === "POST" || method === "PUT";
  const bodyBytes = isBodyMethod ? new TextEncoder().encode(bodyText ?? "") : null;
  const lines = [
    ["(request-target)", `${method.toLowerCase()} ${pathWithQuery}`],
    ["host", host],
    ["date", date],
  ];
  if (isBodyMethod) {
    const digest = await crypto.subtle.digest("SHA-256", bodyBytes);
    lines.push(
      ["x-content-sha256", bytesToBase64(new Uint8Array(digest))],
      ["content-type", "application/json"],
      ["content-length", String(bodyBytes.byteLength)],
    );
  }
  return {
    signingString: lines.map(([name, value]) => `${name}: ${value.trim()}`).join("\n"),
    headerNames: lines.map(([name]) => name),
    headerValues: Object.fromEntries(lines.filter(([name]) => name !== "(request-target)")),
    bodyText,
  };
}

/**
 * 組出 Authorization 標頭值。
 * @param {{ keyId: string, headerNames: string[], signatureBase64: string }} parts
 */
export function buildAuthorizationHeader({ keyId, headerNames, signatureBase64 }) {
  // headers= 內以空白分隔、順序與簽章字串一致
  return `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames.join(" ")}",signature="${signatureBase64}"`;
}

/** 簽署簽章字串，回傳 Base64 簽章值。 */
export async function signSigningString(signingKey, signingString) {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(signingString),
  );
  return bytesToBase64(new Uint8Array(signature));
}

// ─── 簽章請求 ───────────────────────────────────────────────

function toSearchParams(query) {
  return query instanceof URLSearchParams ? query : new URLSearchParams(query || {});
}

/**
 * 對 OCI IAAS 端點發出已簽章請求，非 2xx 時拋出 OciApiError。
 * @param {{
 *   account: { tenancyOcid: string, userOcid: string, fingerprint: string, region: string },
 *   privateKeyPem: string,
 *   method: string,
 *   path: string,
 *   query?: URLSearchParams | Record<string, string> | null,
 *   body?: unknown,
 * }} options
 * @returns {Promise<Response>}
 */
export async function ociSignedFetch(options) {
  const { account, privateKeyPem, method, path, query = null, body = undefined } = options;

  const url = new URL(path, ociEndpoint(account.region));
  for (const [key, value] of toSearchParams(query)) {
    url.searchParams.append(key, value);
  }
  const pathWithQuery = `${url.pathname}${url.search}`;

  const isBodyMethod = method === "POST" || method === "PUT";
  const bodyText = isBodyMethod ? JSON.stringify(body ?? {}) : null;
  const date = new Date().toUTCString();

  const signingKey = await importSigningKey(privateKeyPem);
  const { signingString, headerNames } = await buildSigningString({
    method,
    pathWithQuery,
    host: url.host,
    date,
    bodyText,
  });
  const signatureBase64 = await signSigningString(signingKey, signingString);
  const keyId = `${account.tenancyOcid}/${account.userOcid}/${account.fingerprint}`;

  // 簽章過的 header（x-content-sha256 / content-type / content-length）必須
  // 原樣放進實際請求；host 由 fetch 依 URL 帶入、(request-target) 不存在於標頭。
  const headers = {
    date,
    authorization: buildAuthorizationHeader({ keyId, headerNames, signatureBase64 }),
  };
  if (isBodyMethod) {
    headers["x-content-sha256"] = headerValuesOf(headerNames, signingString, "x-content-sha256");
    headers["content-type"] = "application/json";
    headers["content-length"] = String(new TextEncoder().encode(bodyText ?? "").byteLength);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: isBodyMethod ? bodyText : undefined,
    });
  } catch {
    throw new OciApiError(`無法連上 OCI API（${url.host}）`, 502);
  }
  if (!response.ok) {
    throw await ociErrorFromResponse(response);
  }
  return response;
}

/** 從簽章字串取出指定 header 的值（簽章過的值須與請求標頭一致）。 */
function headerValuesOf(headerNames, signingString, name) {
  if (!headerNames.includes(name)) {
    return "";
  }
  const prefix = `${name}: `;
  return signingString.split("\n").find(line => line.startsWith(prefix))?.slice(prefix.length) || "";
}

/** ociSignedFetch + JSON 解析；204（無內容）回 null。 */
export async function ociRequestJson(options) {
  const response = await ociSignedFetch(options);
  if (response.status === 204) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    throw new OciApiError(`OCI API 回應格式無效（HTTP ${response.status}）`, 502);
  }
}
