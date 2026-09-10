// 受保護頁面的伺服器端守衛：對應 Nuxt 版 server/middleware/auth.ts 的
// 頁面分支。Next.js 無法在全域中介層存取 D1（middleware 跑在邊緣執行期），
// 改在 (console) layout 這類 Server Component 呼叫，以 next/headers 讀取
// cookie 後直接驗證，不經內部子請求——與 Nuxt 版相同的 CPU 節約考量。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseSessionValue, SESSION_COOKIE } from "./utils/auth.js";
import { getOidcConfigurationStatus, isAllowedEmail } from "./utils/oidc.js";
import { getEnv } from "./env";

// 模擬僅含 cookie 標頭的請求，重用 auth.js 的 cookie 解析
async function readSessionValue(): Promise<string | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  return cookie ?? null;
}

/**
 * (console) layout 的守衛：
 * - 基礎設施故障 → /503?reason=
 * - SSO 未設定 → /setup（OOBE）
 * - 未登入 → /login
 */
export async function requireConsolePage(): Promise<void> {
  const env = await getEnv();
  const secret = env?.SESSION_SECRET;
  const oidcStatus = await getOidcConfigurationStatus(env);

  const systemErrorReason = oidcStatus.state === "error"
    ? oidcStatus.reason
    : (!secret ? "session_secret_missing" : "");
  if (systemErrorReason) {
    redirect(`/503?reason=${encodeURIComponent(systemErrorReason)}`);
  }

  if (oidcStatus.state === "unconfigured") {
    redirect("/setup");
  }

  const session = secret ? await readSessionValue() : null;
  const payload = session ? await parseSessionValue(session, secret) : null;
  const authenticated = Boolean(payload?.email && await isAllowedEmail(env, payload.email));
  if (!authenticated) {
    redirect("/login");
  }
}
