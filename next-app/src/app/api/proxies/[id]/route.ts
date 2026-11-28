// PUT /api/proxies/:id：更新代理（密碼留空即保留原值）。
// DELETE /api/proxies/:id：刪除代理；綁定此代理的帳號會因 FK
//   （ON DELETE SET NULL）自動回到直連。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { deleteProxy, getProxyById, updateProxy } from "@/server/utils/db.js";
import { encryptProxyPassword } from "@/server/utils/credential-crypto.js";
import { invalidateProxyCache } from "@/server/utils/proxy.js";

const PROTOCOLS = ["http", "https", "socks5"] as const;
type Protocol = (typeof PROTOCOLS)[number];

/** 驗證主機名稱或 IP（拒絕空白、控制字元與 URL 結構字元，防止代理 URL 注入）。 */
function isValidProxyHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s@/?#\\]/.test(host)) return false;
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

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse(400, "代理 ID 無效。");
  }
  const existing = await getProxyById(env.DB, id);
  if (!existing) {
    return errorResponse(404, "找不到指定的代理。");
  }

  const body = (await readJsonBody(request)) ?? {};
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) {
    return errorResponse(400, "代理名稱必須為 1 至 80 個字元。");
  }
  const protocol = typeof body?.protocol === "string" ? (body.protocol.trim().toLowerCase() as Protocol) : existing.protocol;
  if (!PROTOCOLS.includes(protocol)) {
    return errorResponse(400, "協定須為 http、https 或 socks5。");
  }
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  if (!isValidProxyHost(host)) {
    return errorResponse(400, "代理伺服器地址（Host）格式無效。");
  }
  const port = Number(body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return errorResponse(400, "代理端口必須介於 1 到 65535 之間。");
  }
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  // 密碼留空＝保留原值；有新值則重新加密
  let passwordCiphertext = existing.passwordCiphertext;
  let passwordIv = existing.passwordIv;
  let passwordHint = existing.passwordHint;
  if (password) {
    const encrypted = await encryptProxyPassword(password, env.CREDENTIAL_ENCRYPTION_KEY);
    passwordCiphertext = encrypted.clientSecretCiphertext;
    passwordIv = encrypted.clientSecretIv;
    passwordHint = password.slice(-4);
  }

  const updated = await updateProxy(env.DB, id, {
    name,
    protocol,
    host,
    port,
    username: username || null,
    passwordCiphertext,
    passwordIv,
    passwordHint,
  });
  invalidateProxyCache(id);
  if (!updated) {
    return errorResponse(404, "找不到指定的代理。");
  }
  return jsonResponse({ ok: true, proxy: publicProxy(updated) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse(400, "代理 ID 無效。");
  }
  const deleted = await deleteProxy(env.DB, id);
  invalidateProxyCache(id);
  return jsonResponse({ ok: true, deleted });
}
