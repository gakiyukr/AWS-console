'use client'

// 「新增 EC2」的部署模式切換：一般 Region 與 Wavelength Zone 兩種表單
// 屬同一個 EC2 部署流程，以分頁在兩個子路由間切換（URL 可直達、可分享）。
import Link from "next/link";

const TABS = [
  { key: "regional", href: "/ec2/new", label: "一般 EC2" },
  { key: "wavelength", href: "/ec2/new/wavelength", label: "Wavelength EC2" },
] as const;

export function DeployModeTabs({ current }: { current: "regional" | "wavelength" }) {
  return (
    <div className="flex w-fit gap-1 rounded-lg border border-divider bg-surface p-1" role="tablist" aria-label="部署模式">
      {TABS.map(tab => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            role="tab"
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            className={`flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-accent-soft text-accent-soft-foreground"
                : "text-muted hover:bg-default hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
