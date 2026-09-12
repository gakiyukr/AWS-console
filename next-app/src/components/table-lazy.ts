"use client";

// HeroUI Table 的 SSR 在 Linux（CI）建置的 bundle 上會觸發 react-aria
// collections 的「cannot be rendered outside a collection」錯誤，使 Worker
// 在渲染期直接 500（Windows 本機建置則正常）。因此頁面使用 Table 時必須
// 以 <NoSsr>（見 no-ssr.tsx）包住，只在瀏覽器端渲染。
// 此檔僅轉介完整 Table namespace，維持 Table.Root / Table.Header 等
// 複合元件用法——不可改用 next/dynamic 包裝，那會丟失 namespace 屬性。
export { Table } from "@heroui/react/table";
