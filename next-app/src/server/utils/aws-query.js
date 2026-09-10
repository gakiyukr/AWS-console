import { AwsRequestError } from "../lib/aws-request-error.js";

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

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

async function deriveSigningKey(secretAccessKey, shortDate, region, service) {
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${secretAccessKey}`),
    shortDate,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function isoNowParts(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    shortDate: iso.slice(0, 8),
  };
}

// 單次 AWS API 請求的逾時上限；涵蓋 EC2 查詢的正常延遲（P99 < 10 秒），
// 並在無回應時及早失敗，避免拖垮輪詢迴圈與 SSE 進度串流。
const AWS_QUERY_TIMEOUT_MS = 30_000;

function parseAwsError(xml) {
  const code = xml.match(/<Code>([^<]+)<\/Code>/)?.[1] || "";
  const message = xml.match(/<Message>([^<]+)<\/Message>/)?.[1] || "";
  return {
    code,
    message,
  };
}

export { AwsRequestError };

export function buildEc2Endpoint(region) {
  return `https://ec2.${region}.amazonaws.com/`;
}

export async function ec2Query(region, env, action, params = {}) {
  const service = "ec2";
  const method = "POST";
  const endpoint = buildEc2Endpoint(region);
  const { amzDate, shortDate } = isoNowParts();
  const bodyParams = new URLSearchParams({
    Action: action,
    Version: "2016-11-15",
  });

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      bodyParams.set(key, String(value));
    }
  }

  const body = bodyParams.toString();
  const bodyHash = await sha256Hex(body);
  const host = `ec2.${region}.amazonaws.com`;
  const sessionToken = env.AWS_SESSION_TOKEN || "";
  const canonicalHeaders =
    `content-type:application/x-www-form-urlencoded; charset=utf-8\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n${
      sessionToken ? `x-amz-security-token:${sessionToken}\n` : ""}`;
  const signedHeaders = sessionToken
    ? "content-type;host;x-amz-date;x-amz-security-token"
    : "content-type;host;x-amz-date";
  const canonicalRequest = [
    method,
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await deriveSigningKey(
    env.AWS_SECRET_ACCESS_KEY,
    shortDate,
    region,
    service,
  );
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fetchImpl = env.__testHooks?.fetch || fetch;
  // AWS API 偶發無回應時，fetch 可能無限期掛住並拖垮整個請求；
  // 以 30 秒逾時確保上層輪詢與 SSE 進度串流能持續推進。
  const headers = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    "x-amz-date": amzDate,
    authorization,
  };
  if (sessionToken)
    headers["x-amz-security-token"] = sessionToken;
  const response = await fetchImpl(endpoint, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(AWS_QUERY_TIMEOUT_MS),
  });
  const xml = await response.text();

  if (!response.ok || /<Errors>[\s\S]*<\/Errors>/.test(xml)) {
    const parsed = parseAwsError(xml);
    throw new AwsRequestError(
      parsed.message || `${action} failed with ${response.status}`,
      {
        code: parsed.code,
        statusCode: response.status,
      },
    );
  }

  return xml;
}

export function encodeUserData(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}
