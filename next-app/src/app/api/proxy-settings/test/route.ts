// POST /api/proxy-settings/test：測試指定代理的連通性、出口 IP 與延遲。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getProxySettings, testProxyConnection } from "@/server/utils/proxy.js";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;

  const env = await getEnv();
  const body = await readJsonBody(request);

  const protocol = body?.protocol === "socks5" ? "socks5" : body?.protocol === "https" ? "https" : "http";
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  const port = Number(body?.port) || 8080;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  let password = typeof body?.password === "string" ? body.password : "";

  if (!host) {
    return errorResponse(400, "請先填寫代理主機位址（Host）。");
  }

  // 若密碼為空但未修改，從資料庫取出原密碼測試
  if (!password) {
    const existing = await getProxySettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY);
    if (existing.host === host && existing.port === port && existing.password) {
      password = existing.password;
    }
  }

  const result = await testProxyConnection({
    enabled: true,
    protocol,
    host,
    port,
    username,
    password,
  });

  return jsonResponse(result);
}
