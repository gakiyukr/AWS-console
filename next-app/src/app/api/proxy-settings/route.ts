// /api/proxy-settings：API 出口代理（HTTP / SOCKS5）設定的讀取與儲存。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getProxySettings, saveProxySettings } from "@/server/utils/proxy.js";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;

  const env = await getEnv();
  const settings = await getProxySettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY);

  return jsonResponse({
    enabled: settings.enabled,
    protocol: settings.protocol,
    host: settings.host,
    port: settings.port,
    username: settings.username,
    hasPassword: Boolean(settings.passwordHint || settings.password),
    passwordHint: settings.passwordHint ? `····${settings.passwordHint}` : null,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;

  const env = await getEnv();
  const body = await readJsonBody(request);

  const enabled = Boolean(body?.enabled);
  const protocol = body?.protocol === "socks5" ? "socks5" : body?.protocol === "https" ? "https" : "http";
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  const port = Number(body?.port) || 8080;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : undefined;

  if (enabled && !host) {
    return errorResponse(400, "啟用代理時，主機位址（Host）為必填。");
  }
  if (port < 1 || port > 65535) {
    return errorResponse(400, "埠號必須介於 1 到 65535 之間。");
  }

  await saveProxySettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, {
    enabled,
    protocol,
    host,
    port,
    username,
    password,
  });

  return jsonResponse({
    ok: true,
    message: enabled ? "出口代理已啟用並儲存。" : "出口代理設定已更新（已停用）。",
  });
}
