// POST /api/logout：清除 session cookie。
// 前端側邊欄登出按鈕呼叫後導向 /login；IdP 端的 SSO session 不受影響。
import { buildClearedSessionCookie } from "@/server/utils/auth.js";
import { jsonResponse } from "@/server/utils/http.js";

export async function POST(): Promise<Response> {
  const headers = new Headers(jsonResponse({ ok: true }).headers);
  headers.append("Set-Cookie", buildClearedSessionCookie());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
