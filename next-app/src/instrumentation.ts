// 生產環境錯誤觀測：Next 會把 RSC 錯誤遮蔽成泛用訊息（digest），此 hook
// 能在 Worker 端捕捉原始錯誤並 console.error，供 wrangler tail 檢視。
// 修復確認後應移除或改接正式錯誤回報。
export async function onRequestError(err: unknown, request: unknown, context: unknown) {
  const e = err as { digest?: unknown; stack?: string } | null;
  console.error("[onRequestError] digest:", e?.digest);
  console.error("[onRequestError] stack:", e?.stack);
  console.error("[onRequestError] raw:", String(err));
}
