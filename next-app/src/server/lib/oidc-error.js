// OIDC 登入流程錯誤：code 供路由層映射為 /login?error=<code>。
// 放置於 lib 而非 utils，避免被 Nitro 的自動匯入掃描後在宣告
// 模組內注入同名 import，造成「already been declared」。
export class OidcError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = "OidcError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
