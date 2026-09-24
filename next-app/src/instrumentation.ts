// 生產環境錯誤觀測：Next 會把 RSC 錯誤遮蔽成泛用訊息（digest），此 hook
// 在 Worker 端把原始錯誤（含 digest 與 stack）寫進 console.error，
// 配合 wrangler.jsonc 的 observability.enabled 即可在 Cloudflare
// Dashboard 的 Workers Logs 查得真實錯誤，無需臨時掛除錯 hook。
export async function onRequestError(err: unknown) {
  const e = err as { digest?: unknown; stack?: string } | null;
  console.error("[onRequestError] digest:", e?.digest);
  console.error("[onRequestError] stack:", e?.stack);
  console.error("[onRequestError] message:", String(err));
}
