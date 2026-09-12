"use client";

// HeroUI Table 的 SSR 在 Linux（CI）建置的 bundle 上會觸發 react-aria
// collections 的「cannot be rendered outside a collection」錯誤——不同平台
// 的 webpack 模組圖差異使 collection context 於 SSR 期缺失，Worker 會在
// 渲染期直接 500（Windows 本機建置則正常）。
// 因此 Table 一律以 next/dynamic 關閉 SSR，僅在瀏覽器端渲染。
import dynamic from "next/dynamic";
import type { Table as HeroUITable } from "@heroui/react/table";

const Table = dynamic(() => import("@/components/heroui-table"), {
  ssr: false,
}) as unknown as typeof HeroUITable;

export { Table };
