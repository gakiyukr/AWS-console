import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { requireConsolePage } from "@/server/page-guard";

// 受保護頁面一律動態渲染：CI 建置環境可能把這些頁靜態預渲染，請求時
// 在預渲染殼上存取動態 API 會丟 DYNAMIC_SERVER_USAGE 導致 500。
export const dynamic = "force-dynamic";

// 受保護頁面共用 layout：進入前先通過頁面守衛（503 / setup / login 重導）。
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await requireConsolePage();
  return <AppShell>{children}</AppShell>;
}
