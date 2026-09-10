// 部署結果摘要工具：供操作日誌記錄使用。
// 部署結果內含 root 密碼等敏感欄位，寫入 D1 前必須剝除，
// 讓 /logs 頁可安全展示稽核資訊而不洩漏憑證。

/**
 * 遞迴剝除結果物件中的敏感欄位（password），其餘欄位原樣保留；
 * 非物件輸入原字串化，確保任何部署函式的回傳值都能安全序列化。
 */
export function summarizeDeployResult(result) {
  if (!result || typeof result !== "object") {
    return String(result);
  }
  if (Array.isArray(result)) {
    return result.map((item) => summarizeDeployResult(item));
  }
  const summary = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === "password") {
      continue;
    }
    summary[key] = value && typeof value === "object" ? summarizeDeployResult(value) : value;
  }
  return summary;
}
