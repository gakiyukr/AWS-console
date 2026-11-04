// 分享頁服務端入口：token 即憑證，查無有效連結時渲染獨立告知頁，
// 不導向主控台任何狀態頁（訪客與主控台無關，也不洩漏入口存在性）。
// 此頁只驗證連結存在；機器清單由 client 元件向公開 API 取得。
import { redirect } from "next/navigation";
import { getEnv } from "@/server/env";
import { getShareLinkByToken } from "@/server/utils/db.js";
import ShareView from "./share-view";

export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const env = await getEnv();

  let link: Awaited<ReturnType<typeof getShareLinkByToken>> = null;
  try {
    link = await getShareLinkByToken(env.DB, token);
  } catch {
    // D1 等基礎設施故障：與主控台頁面一致轉往 503 診斷頁
    redirect("/503");
  }

  if (!link || !link.enabled) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 py-12">
        <div className="w-full max-w-sm text-center">
          <p className="text-5xl font-bold tracking-tight">404</p>
          <p className="mt-3 text-sm text-muted">此分享連結不存在，或已被擁有者停用。</p>
        </div>
      </main>
    );
  }

  return <ShareView token={token} linkName={link.name} />;
}
