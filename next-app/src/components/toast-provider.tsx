'use client'

// HeroUI 的 ToastProvider 內含 client-only 引用，必須由 Client Component
// 掛載；Server Component 的 root layout 僅渲染本包裝。
import { ToastProvider as HeroUIToastProvider } from "@heroui/react/toast";

export function ToastProvider() {
  return <HeroUIToastProvider />;
}
