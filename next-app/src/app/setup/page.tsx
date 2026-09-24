// OOBE 服務端入口：先確認 Worker 已配置有效的 Setup Token，再渲染設定表單。
// 缺少或過短的 secret 時直接轉向診斷頁，secret 值不進入 RSC payload。
import { redirect } from "next/navigation";
import { getEnv } from "@/server/env";
import { isSetupTokenConfigured } from "@/server/utils/setup-token.js";
import SetupFormPage from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const env = await getEnv();
  if (!isSetupTokenConfigured(env)) {
    redirect("/503?reason=setup_token_missing");
  }
  return <SetupFormPage />;
}
