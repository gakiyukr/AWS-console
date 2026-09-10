"use client";

import { Button } from "@heroui/react/button";
import {
  Activity,
  CloudCog,
  KeyRound,
  Menu,
  RadioTower,
  ScrollText,
  Server,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

const navigation = [
  { href: "/", label: "機器總覽", icon: Activity },
  { href: "/ec2", label: "EC2 部署", icon: Server },
  { href: "/wavelength", label: "Wavelength 部署", icon: RadioTower },
  { href: "/logs", label: "操作日誌", icon: ScrollText },
  { href: "/accounts", label: "帳號管理", icon: KeyRound },
  { href: "/settings", label: "設定", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {mobileOpen && (
        <button
          aria-label="關閉導覽選單"
          className="fixed inset-0 z-30 bg-black/35 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-divider bg-surface transition-transform duration-200 lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center gap-3 border-b border-divider px-5">
          <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-foreground">
            <CloudCog aria-hidden="true" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">AWS Console</p>
            <p className="text-xs text-muted">雲端基礎設施</p>
          </div>
          <Button
            aria-label="關閉導覽選單"
            className="lg:hidden"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setMobileOpen(false)}
          >
            <X aria-hidden="true" size={18} />
          </Button>
        </div>

        <nav aria-label="主要導覽" className="flex-1 space-y-1 overflow-y-auto p-3">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
                  active
                    ? "bg-accent-soft text-accent-soft-foreground"
                    : "text-muted hover:bg-default hover:text-foreground"
                }`}
                onClick={() => setMobileOpen(false)}
              >
                <Icon aria-hidden="true" size={18} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-divider p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="grid size-9 place-items-center rounded-full bg-default text-sm font-semibold">
              G
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">SSO 使用者</p>
              <p className="truncate text-xs text-muted">尚未連接 session</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center border-b border-divider bg-background/90 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <Button
            aria-label="開啟導覽選單"
            className="mr-3 lg:hidden"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setMobileOpen(true)}
          >
            <Menu aria-hidden="true" size={20} />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-muted">AWS 主控台</p>
          </div>
          <span className="text-xs text-muted">預覽環境</span>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
