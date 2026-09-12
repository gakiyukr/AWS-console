"use client";

import { useEffect, useState, type ReactNode } from "react";

// 掛載閘門：children 僅在瀏覽器端渲染，伺服器端（SSR）回傳 null。
// 首次客戶端渲染同樣回傳 null 以避免 hydration 不一致，掛載後才顯示。
// 用於包住 HeroUI Table——其 SSR 在 CI（Linux）建置的 bundle 上會觸發
// react-aria collections 錯誤，導致整頁 500。
export function NoSsr({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return <>{mounted ? children : fallback}</>;
}
