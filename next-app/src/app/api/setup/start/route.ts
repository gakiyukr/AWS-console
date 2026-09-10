// POST /api/setup/start：OOBE「開始 SSO 驗證」。以表單設定產生
// state/nonce/PKCE 與 pending 設定識別碼寫入簽章 state cookie，回傳 IdP 授權
// URL 供前端導向；Client Secret 只以加密密文暫存於 D1。
import { OidcError } from "@/server/lib/oidc-error.js";
import { OidcConfigurationError } from "@/server/lib/oidc-configuration-error.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  buildCallbackRedirectUri,
  getOidcConfigurationStatus,
  probeOidcSetup,
  startLogin,
} from "@/server/utils/oidc.js";
import { getEnv } from "@/server/env";

export async function POST(request: Request): Promise<Response> {
  const env = await getEnv();
  const oidcStatus = await getOidcConfigurationStatus(env);
  if (oidcStatus.state === "error") {
    return jsonResponse({
      error: "認證服務目前無法使用，請先修復部署設定。",
      reason: oidcStatus.reason,
    }, { status: 503 });
  }
  if (oidcStatus.state === "configured") {
    return errorResponse(409, "SSO 已完成設定；如需重新設定，請先清除 D1 內的 sso_config。");
  }
  if (!env?.SESSION_SECRET) {
    return errorResponse(503, "伺服器尚未設定 SESSION_SECRET。");
  }

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  // 先探測 metadata，讓表單錯誤以具體訊息回顯，而非泛用的 configuration
  const probe = await probeOidcSetup(body);
  if (!probe.ok) {
    return errorResponse(400, probe.error);
  }

  try {
    const redirectUri = buildCallbackRedirectUri(new URL(request.url).origin);
    const { redirectUrl, stateCookie } = await startLogin(env, redirectUri, body);
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", stateCookie);
    return new Response(JSON.stringify({ redirectUrl }), { status: 200, headers });
  } catch (error) {
    if (error instanceof OidcConfigurationError) {
      return jsonResponse({
        error: "服務目前無法儲存待驗證的 SSO 設定，請稍後再試。",
        reason: error.reason,
      }, { status: 503 });
    }
    if (error instanceof OidcError && error.statusCode === 400) {
      return errorResponse(400, "設定內容無效，請檢查後再試。");
    }
    return errorResponse(502, "無法啟動 SSO 驗證，請稍後再試。");
  }
}
