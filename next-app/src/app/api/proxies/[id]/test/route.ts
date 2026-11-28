// POST /api/proxies/:id/test：以已儲存代理的密碼測試連線（可選以 body 覆寫 protocol/host/port/username）。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getProxyById } from "@/server/utils/db.js";
import { decryptProxyPassword } from "@/server/utils/credential-crypto.js";
import { testProxyConnection } from "@/server/utils/proxy.js";

const PROTOCOLS = ["http", "https", "socks5"] as const;
type Protocol = (typeof PROTOCOLS)[number];

function isValidProxyHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s@/?#\\]/.test(host)) return false;
  for (let i = 0; i < host.length; i += 1) {
    const code = host.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export async function POST(
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
  const row = await getProxyById(env.DB, id);
  if (!row) {
    return errorResponse(404, "找不到指定的代理。");
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await readJsonBody(request)) ?? {};
  } catch {
    body = {};
  }

  const protocol = typeof body.protocol === "string" && body.protocol.trim()
    ? (body.protocol.trim().toLowerCase() as Protocol)
    : (row.protocol as Protocol);
  if (!PROTOCOLS.includes(protocol)) {
    return errorResponse(400, "協定須為 http、https 或 socks5。");
  }
  const host = typeof body.host === "string" && body.host.trim()
    ? body.host.trim()
    : String(row.host || "");
  if (!isValidProxyHost(host)) {
    return errorResponse(400, "代理伺服器地址（Host）格式無效。");
  }
  const port = body.port !== undefined && body.port !== null && body.port !== ""
    ? Number(body.port)
    : Number(row.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return errorResponse(400, "代理端口必須介於 1 到 65535 之間。");
  }
  const username = typeof body.username === "string"
    ? body.username.trim()
    : (row.username || "");

  let password = "";
  if (typeof body.password === "string" && body.password.length > 0) {
    password = body.password;
  } else if (row.passwordCiphertext && row.passwordIv) {
    if (!env.CREDENTIAL_ENCRYPTION_KEY) {
      return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
    }
    try {
      password = await decryptProxyPassword(
        { clientSecretCiphertext: row.passwordCiphertext, clientSecretIv: row.passwordIv },
        env.CREDENTIAL_ENCRYPTION_KEY,
      );
    } catch (error) {
      return errorResponse(500, `代理密碼解密失敗：${error instanceof Error ? error.message : error}`);
    }
  }

  const result = await testProxyConnection({
    id: row.id,
    name: row.name,
    protocol,
    host,
    port,
    username,
    password,
  });
  return jsonResponse(result, { status: result.ok ? 200 : 502 });
}
