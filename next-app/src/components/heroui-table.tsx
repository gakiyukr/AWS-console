"use client";

// 供 table-lazy.ts 以 next/dynamic 載入的實體包裝層。
// HeroUI Table 為複合元件（Table.Header / Table.Body 等），無法直接
// 傳入 next/dynamic，故以預設匯出轉介整個元件 namespace。
import { Table } from "@heroui/react/table";

export default Table;
