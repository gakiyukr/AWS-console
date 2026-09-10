// OIDC 設定儲存區故障：reason 供路由層導向對應的 /503 診斷內容。
// 放置於 lib 而非 utils，避免 Nitro 自動匯入同名符號造成重複宣告。
export class OidcConfigurationError extends Error {
  constructor(reason) {
    super("OIDC 設定儲存區無法使用");
    this.name = "OidcConfigurationError";
    this.reason = reason;
  }
}
