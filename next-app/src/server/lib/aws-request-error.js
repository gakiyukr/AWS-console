// AWS Query API 的結構化例外。置於 server/utils 之外，避免 Nitro 對工具模組
// 自動匯入時將同名類別再次注入宣告所在檔案。
export class AwsRequestError extends Error {
  constructor(message, details = {}, extraDetails = {}) {
    super(message);
    this.name = "AwsRequestError";
    if (typeof details === "number") {
      this.statusCode = details;
      this.code = extraDetails.code || "";
    } else {
      this.code = details.code || "";
      this.statusCode = details.statusCode || 0;
    }
  }
}
