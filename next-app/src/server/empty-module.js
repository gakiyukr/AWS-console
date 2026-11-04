// 空模組 stub：供 next.config.ts 把 capjs-core 的 instrumentation 依賴
// （esbuild、javascript-obfuscator）替換掉。兩者僅在啟用 instrumentation
// 時於 lazy import 內執行，本專案從未啟用；在 Workers 上也無法使用。
const stub = {};

export default stub;
