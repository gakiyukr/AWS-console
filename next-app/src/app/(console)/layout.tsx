import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { requireConsolePage } from "@/server/page-guard";

// 受保護頁面共用 layout：進入前先通過頁面守衛（503 / setup / login 重導）。
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await requireConsolePage();
  return <AppShell>{children}</AppShell>;
}
