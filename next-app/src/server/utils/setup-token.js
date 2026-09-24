// OOBE 首次設定的環境權杖驗證。權杖只存在於請求標頭與 Worker
// environment，不寫入 D1、設定 Cookie 或 API 回應。
const MIN_SETUP_TOKEN_BYTES = 32;

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/**
 * 驗證首次設定權杖。
 * @param {Request} request
 * @param {CloudflareEnv} env
 * @returns {Promise<"unconfigured" | "invalid" | "valid">}
 */
export async function checkSetupToken(request, env) {
  const configuredToken = typeof env.SETUP_TOKEN === "string" ? env.SETUP_TOKEN : "";
  if (new TextEncoder().encode(configuredToken).byteLength < MIN_SETUP_TOKEN_BYTES) {
    return "unconfigured";
  }

  const providedToken = request.headers.get("x-setup-token") || "";
  if (!providedToken) return "invalid";

  const [expectedDigest, providedDigest] = await Promise.all([
    sha256(configuredToken),
    sha256(providedToken),
  ]);
  let mismatch = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    mismatch |= expectedDigest[index] ^ providedDigest[index];
  }
  return mismatch === 0 ? "valid" : "invalid";
}
