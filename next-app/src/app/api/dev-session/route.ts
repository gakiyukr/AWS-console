// 僅限本機 dev 的測試登入端點：直接簽發 dev@example.com 的 session，
// 供 UI 預覽繞過 IdP。生產環境（NEXTJS_ENV 非 development）一律 404。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSignedValue } from "@/server/utils/auth.js";
import { getEnv } from "@/server/env";

export async function GET(request: Request): Promise<Response> {
  const env = (await getEnv()) as unknown as Record<string, unknown>;
  if (process.env.NODE_ENV !== "development" || env.NEXTJS_ENV === "production") {
    return new Response("Not Found", { status: 404 });
  }
  const secret = (env as unknown as CloudflareEnv)?.SESSION_SECRET;
  if (!secret) {
    return new Response("SESSION_SECRET missing", { status: 503 });
  }
  const url = new URL(request.url);
  const email = url.searchParams.get("email") || "dev@example.com";
  const sessionValue = await createSignedValue({ email }, secret);
  const cookieStore = await cookies();
  cookieStore.set("ec2_session", sessionValue, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
    maxAge: 24 * 60 * 60,
  });
  redirect("/");
}
