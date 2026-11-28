// /api/proxies：出口代理池管理。
// GET  → 列出全部代理（密碼不出伺服器，僅 hint）
// POST → 新增代理（密碼以 AES-256-GCM 加密存 D1）
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { createProxy, listProxies } from "@/server/utils/db.js";
import { encryptProxyPassword } from "@/server/utils/credential-crypto.js";
import { invalidateProxyCache } from "@/server/utils/proxy.js";

const PROTOCOLS = ["http", "https", "socks5"] as const;
type Protocol = (typeof PROTOCOLS)[number];

/** 驗證主機名稱或 IP（拒絕空白、控制字元與 URL 結構字元，防止代理 URL 注入）。 */
function isValidProxyHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s@/?#\\]/.test(host)) return false;
  // 拒絕控制字元
  for (let i = 0; i < host.length; i += 1) {
    const code = host.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** 剝除密文與 IV，僅回傳前端顯示所需的公開代理欄位。 */
function publicProxy(proxy: Record<string, unknown>) {
  return {
    id: proxy.id,
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: typeof proxy.username === "string" ? proxy.username : "",
    passwordHint: proxy.passwordHint ? `····${proxy.passwordHint}` : null,
  };
}

/** 驗證並正規化代理表單；回傳欄位或錯誤訊息。 */
function parseProxyBody(body: Record<string, unknown>): { fields?: { name: string; protocol: Protocol; host: string; port: number; username: string; password: string }; error?: string } {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) {
    return { error: "代理名稱必須為 1 至 80 個字元。" };
  }
  const protocol = typeof body?.protocol === "string" ? (body.protocol.trim().toLowerCase() as Protocol) : "http";
  if (!PROTOCOLS.includes(protocol)) {
    return { error: "協定須為 http、https 或 socks5。" };
  }
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  if (!isValidProxyHost(host)) {
    return { error: "代理伺服器地址（Host）格式無效。" };
  }
  const port = Number(body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "代理端口必須介於 1 到 65535 之間。" };
  }
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  return { fields: { name, protocol, host, port, username, password } };
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const proxies = await listProxies(env.DB);
  return jsonResponse({
    proxies: proxies.map(proxy => publicProxy(proxy)),
  });
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }

  const body = (await readJsonBody(request)) ?? {};
  const parsed = parseProxyBody(body);
  if (parsed.error || !parsed.fields) {
    return errorResponse(400, parsed.error || "請求內容無效。");
  }
  const { name, protocol, host, port, username, password } = parsed.fields;

  const encrypted = password
    ? await encryptProxyPassword(password, env.CREDENTIAL_ENCRYPTION_KEY)
    : null;

  const created = await createProxy(env.DB, {
    name,
    protocol,
    host,
    port,
    username: username || null,
    passwordCiphertext: encrypted?.clientSecretCiphertext ?? null,
    passwordIv: encrypted?.clientSecretIv ?? null,
    passwordHint: password ? password.slice(-4) : null,
  });
  invalidateProxyCache();

  return jsonResponse({ ok: true, proxy: publicProxy(created) }, { status: 201 });
}
