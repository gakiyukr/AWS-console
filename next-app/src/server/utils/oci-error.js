// OCI API 錯誤的統一轉譯。OCI 錯誤回應為 JSON：{ code, message, status }，
// 此處映射為帶 statusCode 的業務錯誤，供 http.js 的 toHttpError 轉為 HTTP 回應；
// 訊息一律為可直接顯示於 UI 的繁體中文。

export class OciApiError extends Error {
  /**
   * @param {string} message 可顯示的錯誤訊息
   * @param {number} statusCode HTTP 狀態碼
   * @param {{ ociCode?: string, retryable?: boolean }} [options]
   */
  constructor(message, statusCode, options = {}) {
    super(message);
    this.name = "OciApiError";
    this.statusCode = statusCode;
    this.ociCode = options.ociCode || "";
    this.retryable = Boolean(options.retryable);
  }
}

/** OCI 錯誤代碼 → 使用者可執行的文案對照。 */
const OCI_CODE_MESSAGES = {
  NotAuthenticated: "OCI 憑證無效或已過期，請檢查 API Key 與指紋。",
  NotAuthorizedOrNotFound: "資源不存在，或此帳號無權限存取（請確認 compartment 與 IAM 政策）。",
  TooManyRequests: "OCI API 暫時節流中，請稍後再試。",
  LimitExceeded: "已達此資源的配額上限。",
  OutOfHostCapacity: "OCI 目前此放大區（AD）沒有可用容量（Always Free A1 常見），請稍後重試。",
};

/**
 * 將 OCI 回應（非 2xx）轉為 OciApiError。
 * @param {Response} response 已讀取前的 fetch Response
 * @returns {Promise<OciApiError>}
 */
export async function ociErrorFromResponse(response) {
  let code = "";
  let message = "";
  try {
    const body = await response.json();
    code = String(body?.code || "");
    message = String(body?.message || "");
  } catch {
    // 非 JSON 回應（如 HTML 錯誤頁）僅保留狀態碼資訊
  }

  const status = response.status;
  const fallback = OCI_CODE_MESSAGES[code]
    || message
    || `OCI API 呼叫失敗（HTTP ${status}）`;
  const retryable = status === 429 || status >= 500;
  return new OciApiError(fallback, status, { ociCode: code, retryable });
}

/** 將任意錯誤轉為可顯示訊息；OciApiError 直接用原文，其餘通用化。 */
export function ociFailureMessage(error) {
  if (error instanceof OciApiError) {
    return error.retryable ? `${error.message}（可重試）` : error.message;
  }
  return error instanceof Error ? error.message : "OCI API 呼叫失敗";
}
