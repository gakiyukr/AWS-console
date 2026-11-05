// /api/captcha-settings：多渠道人機驗證（Cap、Turnstile、hCaptcha）後臺設定。
// GET    → { enabled, providers: [...] }
// PUT    { provider, enabled, endpoint, siteKey, secret } → 儲存單一渠道設定
// DELETE ?provider=... → 移除該渠道設定
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  clearCaptchaProvider,
  getAllCaptchaProviders,
  getCaptchaProvider,
  saveCaptchaProvider,
  SHARE_CAPTCHA_ENABLED_KEY,
} from "@/server/utils/cap.js";
import { appendOperationLog, getAppSetting } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const providers = await getAllCaptchaProviders(env);
  const globalEnabled = (await getAppSetting(env.DB, SHARE_CAPTCHA_ENABLED_KEY)) === "1";

  // cap 渠道相容舊格式欄位
  const cap = providers.find(p => p.provider === "cap");

  return jsonResponse({
    enabled: globalEnabled,
    configured: providers.some(p => p.configured && p.enabled),
    source: cap?.source || null,
    endpoint: cap?.endpoint || "",
    siteKey: cap?.siteKey || "",
    secretHint: cap?.secretHint || null,
    providers,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }

  const body = await readJsonBody(request);
  const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "cap";
  if (!["cap", "turnstile", "hcaptcha"].includes(provider)) {
    return errorResponse(400, "不支援的人機驗證渠道。");
  }

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const siteKey = typeof body?.siteKey === "string" ? body.siteKey.trim() : "";
  const secret = typeof body?.secret === "string" ? body.secret.trim() : "";
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : true;

  if (provider === "cap") {
    if (!endpoint) {
      return errorResponse(400, "請輸入 Cap 實例地址（例如：https://cap.example.com）。");
    }
    try {
      const url = new URL(endpoint);
      if (!["http:", "https:"].includes(url.protocol)) {
        return errorResponse(400, "Cap 實例地址必須以 http:// 或 https:// 開頭。");
      }
    } catch {
      return errorResponse(400, "Cap 實例地址格式不正確，請輸入有效的 URL。");
    }
  }

  if (!siteKey) {
    return errorResponse(400, "請輸入站點公鑰（Site Key）。");
  }

  const existing = await getCaptchaProvider(env, provider as "cap" | "turnstile" | "hcaptcha");
  if (!secret && !existing.secret) {
    return errorResponse(400, "請輸入驗證私鑰（Secret Key）。");
  }

  try {
    await saveCaptchaProvider(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, {
      provider,
      enabled,
      endpoint,
      siteKey,
      secret,
    });
  } catch (error) {
    return errorResponse(500, error instanceof Error ? error.message : "儲存設定失敗");
  }

  try {
    await appendOperationLog(env.DB, {
      action: "captcha_setting_update",
      status: "success",
      detail: { provider, site_key: siteKey, enabled, secret_updated: Boolean(secret) },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }

  const updatedProviders = await getAllCaptchaProviders(env);
  return jsonResponse({
    ok: true,
    providers: updatedProviders,
    message: `${provider} 設定已儲存。`,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") || "cap";

  const deleted = await clearCaptchaProvider(env.DB, provider);
  try {
    await appendOperationLog(env.DB, {
      action: "captcha_setting_update",
      status: "success",
      detail: { provider, action: "removed" },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }
  return jsonResponse({ ok: true, deleted, providers: await getAllCaptchaProviders(env) });
}
