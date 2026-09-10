// 認證工具：session／OIDC state 的 HMAC 簽章與驗證、cookie 建構與解析。
// 簽章值為 payload.signature 形式，SESSION_SECRET 為 HMAC-SHA256 金鑰；
// 輪換 secret 即撤銷所有已發 session。全函式為純模組，依賴僅 Web
// Crypto，node --test 可直接驗證。
import { getHeaderValue } from "./http.js";

export const SESSION_COOKIE = "ec2_session";
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toBase64Url(text) {
  return bytesToBase64(new TextEncoder().encode(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4 || 4)) % 4;
  return new TextDecoder().decode(base64ToBytes(padded + "=".repeat(padLength)));
}

async function signText(text, secret) {
  const data = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    data,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  return bytesToBase64(new Uint8Array(signature))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** 常數時間比較：長度不同直接回 false，其餘逐位元 XOR 累積後一次判定。 */
export async function constantTimeCompare(a, b) {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/**
 * 對任意 payload 產生簽章值：base64url(payload + issuedAt) + "." + HMAC。
 * session 與 OIDC state cookie 共用此格式。
 */
export async function createSignedValue(payload, secret, now = Date.now()) {
  const encoded = toBase64Url(JSON.stringify({ ...payload, issuedAt: now }));
  return `${encoded}.${await signText(encoded, secret)}`;
}

/** 驗簽並還原 payload 物件；簽章不符或格式無效回 null。 */
export async function parseSignedValue(value, secret) {
  if (!value || !value.includes(".") || !secret) {
    return null;
  }
  const [encoded, signature] = value.split(".", 2);
  if (!(await constantTimeCompare(signature, await signText(encoded, secret)))) {
    return null;
  }
  try {
    const parsed = JSON.parse(fromBase64Url(encoded));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 驗簽、還原 session payload 並檢查 24 小時時效。 */
export async function parseSessionValue(sessionValue, secret, now = Date.now()) {
  const payload = await parseSignedValue(sessionValue, secret);
  if (!payload) {
    return null;
  }
  const issuedAt = Number(payload.issuedAt);
  const ageMs = now - issuedAt;
  if (!Number.isFinite(issuedAt) || ageMs < 0 || ageMs > SESSION_MAX_AGE_MS) {
    return null;
  }
  return payload;
}

/** 自 Cookie 標頭解析指定名稱的值（decodeURIComponent 還原簽章內的特殊字元）。 */
export function getCookieFromRequest(request, name) {
  const cookieHeader = getHeaderValue(request?.headers, "cookie");
  const cookies = cookieHeader.split(/;\s*/).filter(Boolean);
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export function getSessionFromRequest(request) {
  return getCookieFromRequest(request, SESSION_COOKIE);
}

export function buildSessionCookie(sessionValue) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionValue)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

export function buildClearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
}
