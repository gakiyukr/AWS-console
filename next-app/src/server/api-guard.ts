// /api/** 認證守衛：對應 Nuxt 版 server/middleware/auth.ts 的 API 分支。
// Next.js App Router 沒有能在 Node 執行期存取 D1 的全域中介層，改由各
// 受保護路由在開頭呼叫 requireApiSession；回傳 Response 時路由應直接
// 回傳該回應，回傳 null 表示已通過驗證。
// 公開路徑（login/callback/session/setup）不經此函式，路由本身即為公開。
import { getSessionFromRequest, parseSessionValue } from "./utils/auth.js";
import { errorResponse } from "./utils/http.js";
import { getOidcConfigurationStatus, isAllowedEmail } from "./utils/oidc.js";
import { getEnv } from "./env";

/**
 * 受保護 /api/* 路由的共用守衛：
 * - 基礎設施故障 → 503（reason 僅含可公開的診斷代碼）
 * - SSO 未設定 → 503 sso_unconfigured
 * - 無效 session 或 email 不在允許清單 → 401
 */
export async function requireApiSession(request: Request): Promise<Response | null> {
  const env = await getEnv();
  const secret = env?.SESSION_SECRET;
  const oidcStatus = await getOidcConfigurationStatus(env);

  if (oidcStatus.state === "error" || !secret) {
    // 診斷代碼（reason）不在 API 回應中暴露；頁面導向 /503 時才會附帶
    return errorResponse(503, "認證服務目前無法使用");
  }
  if (oidcStatus.state === "unconfigured") {
    return errorResponse(503, "伺服器尚未完成 SSO 初始設定");
  }

  const session = getSessionFromRequest(request);
  const payload = session ? await parseSessionValue(session, secret) : null;
  if (!payload?.email || !(await isAllowedEmail(env, payload.email))) {
    return errorResponse(401, "未登入或 session 已失效");
  }
  return null;
}
