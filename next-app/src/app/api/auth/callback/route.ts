// GET /api/auth/callback：IdP 授權碼回調。驗 state、交換授權碼並驗證
// ID token，email 在允許清單中即簽發 session 並導回主控台；任何失敗
// 導回 /login?error=<代碼>（統一不透露驗證細節）。
// OOBE 流程：state cookie 僅攜帶 D1 pending 設定識別碼；驗證通過且 email 與
// 綁定 email 一致，才將 pending 設定提升為正式設定並導向主控台；失敗導回 /setup
// （尚未設定 SSO 時的失敗一定屬於 OOBE 流程）。
import { OidcError } from "@/server/lib/oidc-error.js";
import { OidcConfigurationError } from "@/server/lib/oidc-configuration-error.js";
import { activatePendingSsoSetup } from "@/server/utils/db.js";
import {
  buildSessionCookie,
  createSignedValue,
  getCookieFromRequest,
} from "@/server/utils/auth.js";
import {
  buildCallbackRedirectUri,
  buildClearedStateCookie,
  clearSsoConfigCache,
  completeLogin,
  getOidcConfigurationStatus,
  STATE_COOKIE,
} from "@/server/utils/oidc.js";
import { getEnv } from "@/server/env";
import { redirectResponse } from "@/server/responses";

export async function GET(request: Request): Promise<Response> {
  const env = await getEnv();
  const secret = env?.SESSION_SECRET;
  const query = Object.fromEntries(new URL(request.url).searchParams);

  try {
    if (!secret) {
      throw new OidcError("configuration", 503);
    }
    const redirectUri = buildCallbackRedirectUri(new URL(request.url).origin);
    const stateValue = getCookieFromRequest(request, STATE_COOKIE);
    const { email, setup } = await completeLogin(env, redirectUri, query, stateValue);

    if (setup) {
      // OOBE 驗證成功後才啟用設定；pending 資料全程留在 D1。
      try {
        const activation = await activatePendingSsoSetup(
          env.DB,
          setup.id,
          env.CREDENTIAL_ENCRYPTION_KEY,
        );
        if (!activation.activated) {
          throw new OidcConfigurationError(
            activation.reason === "already_configured"
              ? "sso_config_already_exists"
              : "pending_sso_setup_missing",
          );
        }
        clearSsoConfigCache();
      } catch (error) {
        if (error instanceof OidcConfigurationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new OidcConfigurationError(
          message.includes("no such table") || message.includes("pending_sso_setup")
            ? "sso_schema_missing"
            : "sso_config_save_failed",
        );
      }
    }

    const sessionValue = await createSignedValue({ email }, secret);
    return redirectResponse("/", [
      buildSessionCookie(sessionValue),
      buildClearedStateCookie(),
    ]);
  } catch (error) {
    if (error instanceof OidcConfigurationError) {
      return redirectResponse(`/503?reason=${encodeURIComponent(error.reason)}`, [
        buildClearedStateCookie(),
      ]);
    }

    const oidcStatus = await getOidcConfigurationStatus(env);
    if (oidcStatus.state === "error" || !secret) {
      const reason = oidcStatus.state === "error" ? oidcStatus.reason : "session_secret_missing";
      return redirectResponse(`/503?reason=${encodeURIComponent(reason)}`, [
        buildClearedStateCookie(),
      ]);
    }

    const code = error instanceof OidcError ? error.code : "verification_failed";
    const target = oidcStatus.state === "unconfigured" ? "/setup" : "/login";
    return redirectResponse(`${target}?error=${encodeURIComponent(code)}`, [
      buildClearedStateCookie(),
    ]);
  }
}
