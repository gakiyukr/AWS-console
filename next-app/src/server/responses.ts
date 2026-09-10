// Next.js Route Handler 的回應輔助：302 重導與 Set-Cookie 組裝。
// Nuxt 版以 sendRedirect/setHeader 完成，此處改以標準 Response 表達，
// 移植的路由邏輯與錯誤代碼維持不變。
export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}
