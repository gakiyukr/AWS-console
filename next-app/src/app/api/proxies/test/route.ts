// POST /api/proxies/test：測試「表單中尚未儲存」的代理設定。
// body { protocol, host, port, username, password } → 透過該代理實測出口 IP 與延遲。
// 已儲存代理的測試請用 POST /api/proxies/:id/test。
import { requireApiSession } from "@/server/api-guard";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { testProxyConnection } from "@/server/utils/proxy.js";

const PROTOCOLS = ["http", "https", "socks5"] as const;

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;

  const body = (await readJsonBody(request)) ?? {};
  const protocol = typeof body?.protocol === "string" ? (body.protocol.trim().toLowerCase() as (typeof PROTOCOLS)[number]) : "http";
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  const port = Number(body?.port);
  if (!PROTOCOLS.includes(protocol)) {
    return errorResponse(400, "協定須為 http、https 或 socks5。");
  }
  if (!host) {
    return errorResponse(400, "請輸入代理伺服器地址（Host）。");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return errorResponse(400, "代理端口必須介於 1 到 65535 之間。");
  }

  const result = await testProxyConnection({
    id: 0,
    name: "form-test",
    protocol,
    host,
    port,
    username: typeof body?.username === "string" ? body.username.trim() : "",
    password: typeof body?.password === "string" ? body.password : "",
  });
  return jsonResponse(result, { status: result.ok ? 200 : 502 });
}
