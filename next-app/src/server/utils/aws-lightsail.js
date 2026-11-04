// AWS Lightsail JSON API 呼叫工具：與 EC2 Query API（aws-query.js）不同，
// Lightsail 使用 AWS JSON 1.1 協議，請求與回應均為 JSON 格式。
// 簽章採用 SigV4，但 HTTP 方法固定為 POST，操作由 X-Amz-Target 標頭指定。
import { AwsRequestError } from "../lib/aws-request-error.js";
import { textToBase64 } from "./bytes.js";

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(keyBytes, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  return new Uint8Array(signature);
}

async function deriveSigningKey(secretAccessKey, shortDate, region) {
  let key = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  key = await hmacSha256(key, shortDate);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, "lightsail");
  key = await hmacSha256(key, "aws4_request");
  return key;
}

function isoNowParts(now = new Date()) {
  const iso = now.toISOString();
  const longDate = iso.replace(/[:\-]|\.\d{3}/g, "");
  const shortDate = longDate.slice(0, 8);
  return { longDate, shortDate };
}

// Lightsail API 逾時上限：涵蓋正常延遲並及早失敗
const LIGHTSAIL_QUERY_TIMEOUT_MS = 30_000;

function buildLightsailEndpoint(region) {
  return `https://lightsail.${region}.amazonaws.com/`;
}

export { AwsRequestError };

/**
 * 呼叫 AWS Lightsail JSON API。
 * @param {string} region AWS Region 代碼
 * @param {object} env Worker 環境（含 AWS 憑證）
 * @param {string} operation Lightsail 操作名稱（例如 GetRegions、CreateInstances）
 * @param {object} params 請求參數（會轉為 JSON）
 * @returns {Promise<object>} JSON 回應物件
 */
export async function lightsailQuery(region, env, operation, params = {}) {
  // 憑證名稱必須與 resolveAwsAccount 產生的 awsEnv 一致（AWS_* 前綴）；
  // 舊版讀 ACCESS_KEY 等裸名稱，導致每次呼叫都在簽章前誤判憑證不完整。
  const ACCESS_KEY = env.AWS_ACCESS_KEY_ID;
  const SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
  const SESSION_TOKEN = env.AWS_SESSION_TOKEN;
  if (!ACCESS_KEY || !SECRET_ACCESS_KEY) {
    throw new AwsRequestError("AWS 憑證不完整。", 500);
  }

  const endpoint = buildLightsailEndpoint(region);
  const host = new URL(endpoint).host;
  const now = new Date();
  const { longDate, shortDate } = isoNowParts(now);

  const body = JSON.stringify(params);
  const bodyHash = await sha256Hex(body);

  // Lightsail 使用 AWS JSON 1.1 協議
  const target = `Lightsail_20161128.${operation}`;
  const headers = {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": target,
    "X-Amz-Date": longDate,
    Host: host,
  };

  if (SESSION_TOKEN) {
    headers["X-Amz-Security-Token"] = SESSION_TOKEN;
  }

  // 簽章步驟 1：Canonical Request
  const canonicalHeaders = Object.entries(headers)
    .map(([key, value]) => `${key.toLowerCase()}:${value.trim()}`)
    .sort()
    .join("\n");
  const signedHeaders = Object.keys(headers)
    .map((key) => key.toLowerCase())
    .sort()
    .join(";");

  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    "",
    signedHeaders,
    bodyHash,
  ].join("\n");

  // 簽章步驟 2：String to Sign
  const credentialScope = `${shortDate}/${region}/lightsail/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    longDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // 簽章步驟 3：Signing Key
  const signingKey = await deriveSigningKey(SECRET_ACCESS_KEY, shortDate, region);
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));

  // 簽章步驟 4：Authorization Header
  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // 發出請求
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LIGHTSAIL_QUERY_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = "Lightsail API 請求失敗。";
      let errorCode = "";

      try {
        const errorData = JSON.parse(responseText);
        errorMessage = errorData.message || errorData.__type || errorMessage;
        errorCode = errorData.__type || "";
      } catch {
        // 無法解析 JSON 時保留預設錯誤訊息
      }

      throw new AwsRequestError(
        `Lightsail ${operation} 失敗：${errorMessage}`,
        response.status >= 500 ? 502 : 400,
        { code: errorCode, httpStatus: response.status },
      );
    }

    return JSON.parse(responseText);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AwsRequestError(
        `Lightsail ${operation} 請求逾時（超過 ${LIGHTSAIL_QUERY_TIMEOUT_MS / 1000} 秒）。`,
        504,
      );
    }
    if (error instanceof AwsRequestError) {
      throw error;
    }
    throw new AwsRequestError(`Lightsail ${operation} 請求失敗：${error.message}`, 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Base64 編碼 user data（與 EC2 相同格式）。
 */
export function encodeLightsailUserData(text) {
  return textToBase64(text);
}
