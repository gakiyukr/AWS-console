// 二進位與 Base64 轉換：auth、aws-query、credential-crypto 三處原本各自
// 實作同一份 btoa/atob 迴圈。集中於此避免行為漂移，並統一 base64ToBytes
// 對尾端空白的容忍度（管線注入 secret 常附帶換行）。

/** Uint8Array → 標準 Base64 字串 */
export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Base64 字串 → Uint8Array。容忍前後空白；解碼失敗時拋出提供的訊息，
 * 讓呼叫端能給出符合語境的錯誤文字。
 */
export function base64ToBytes(value, invalidMessage = "Base64 格式無效") {
  try {
    const binary = atob(String(value || "").trim());
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error(invalidMessage);
  }
}

/** UTF-8 文字 → Base64 */
export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** UTF-8 文字 → Base64URL（無 padding，用於 cookie 與簽章值） */
export function toBase64Url(text) {
  return textToBase64(text)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Base64URL → UTF-8 文字 */
export function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4 || 4)) % 4;
  return new TextDecoder().decode(base64ToBytes(padded + "=".repeat(padLength)));
}
