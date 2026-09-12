// 內聯狀態標籤。HeroUI 3 的 Badge 是「浮疊角標」設計（placement 預設
// top-right，絕對定位疊在錨點角落），不適合作為一般狀態標籤使用，
// 故以本元件取代，配色沿用 HeroUI 主題 token。
import type { ReactNode } from "react";

export type ChipVariant = "primary" | "secondary" | "soft" | "default";

const VARIANT_STYLES: Record<ChipVariant, string> = {
  primary: "bg-[var(--accent)] text-[var(--accent-foreground)] border-transparent",
  secondary: "bg-[var(--default)] text-[var(--default-foreground)] border-[var(--background)]",
  soft: "bg-[var(--default-soft)] text-[var(--default-soft-foreground)] border-transparent",
  default: "bg-[var(--default)] text-[var(--default-foreground)] border-[var(--background)]",
};

export function Chip({
  children,
  variant = "secondary",
  size = "md",
}: {
  children: ReactNode;
  variant?: ChipVariant;
  size?: "sm" | "md";
}) {
  const sizeStyles = size === "sm" ? "min-h-4 rounded-xl px-1.5 text-[10px]" : "min-h-7 rounded-3xl px-2 text-xs";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border font-medium leading-[1.34] ${sizeStyles} ${VARIANT_STYLES[variant]}`}
    >
      {children}
    </span>
  );
}
