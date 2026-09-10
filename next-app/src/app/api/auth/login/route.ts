// GET /api/auth/login：SSO 登入入口。已登入直接回主控台；否則產生
// state/nonce/PKCE verifier（簽章後存入短效 HttpOnly cookie），
// 302 導向 IdP 授權端點。設定缺失時導回 /login 並帶錯誤代碼。
import { OidcError } from "@/server/lib/oidc-error.js";
import { OidcConfigurationError } from "@/server/lib/oidc-configuration-error.js";
import { getSessionFromRequest, parseSessionValue } from "@/server/utils/auth.js";
import {
  buildCallbackRedirectUri,
  getOidcConfigurationStatus,
  startLogin,
} from "@/server/utils/oidc.js";
import { getEnv } from "@/server/env";
import { redirectResponse } from "@/server/responses";

export async function GET(request: Request): Promise<Response> {
  const env = await getEnv();
  const secret = env?.SESSION_SECRET;

  const session = secret ? getSessionFromRequest(request) : null;
  const payload = session ? await parseSessionValue(session, secret) : null;
  if (payload?.email) {
    return redirectResponse("/");
  }

  try {
    const redirectUri = buildCallbackRedirectUri(new URL(request.url).origin);
    const { redirectUrl, stateCookie } = await startLogin(env, redirectUri);
    return redirectResponse(redirectUrl, [stateCookie]);
  } catch (error) {
    if (error instanceof OidcConfigurationError) {
      return redirectResponse(`/503?reason=${encodeURIComponent(error.reason)}`);
    }
    const oidcStatus = await getOidcConfigurationStatus(env);
    if (oidcStatus.state === "error" || !secret) {
      const reason = oidcStatus.state === "error" ? oidcStatus.reason : "session_secret_missing";
      return redirectResponse(`/503?reason=${encodeURIComponent(reason)}`);
    }
    if (oidcStatus.state === "unconfigured") {
      return redirectResponse("/setup");
    }
    const code = error instanceof OidcError ? error.code : "configuration";
    return redirectResponse(`/login?error=${encodeURIComponent(code)}`);
  }
}
