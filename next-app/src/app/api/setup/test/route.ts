// POST /api/setup/test：OOBE「測試連線」。正規化表單輸入並解析 IdP
// metadata（discovery 或明確端點），回傳可顯示的結果。僅在尚未設定
// 時可用；https 以外的 URL 會被 normalizeSetupInput 拒絕。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getOidcConfigurationStatus, probeOidcSetup } from "@/server/utils/oidc.js";
import { getEnv } from "@/server/env";

export async function POST(request: Request): Promise<Response> {
  const env = await getEnv();
  const oidcStatus = await getOidcConfigurationStatus(env);
  if (oidcStatus.state === "error" || !env?.SESSION_SECRET) {
    return jsonResponse({
      error: "認證服務目前無法使用，請先修復部署設定。",
      reason: oidcStatus.state === "error" ? oidcStatus.reason : "session_secret_missing",
    }, { status: 503 });
  }
  if (oidcStatus.state === "configured") {
    return errorResponse(409, "SSO 已完成設定；如需重新設定，請先清除 D1 內的 sso_config。");
  }

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const result = await probeOidcSetup(body);
  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error });
  }
  return jsonResponse({ ok: true, issuer: result.issuer, authorizationEndpoint: result.authorizationEndpoint });
}
