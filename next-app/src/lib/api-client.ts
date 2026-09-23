// 各頁面共用的 API 互動小工具：錯誤訊息擷取、JSON 解析與 toast 提示。
// 原本六個頁面各自複製同一份實作，集中於此避免文案與行為漂移。
import { toast } from "@heroui/react/toast";

/** 以紅色 toast 顯示錯誤訊息 */
export function toastDanger(message: string) {
  toast(message, { variant: "danger" });
}

/**
 * 解析 JSON 回應並套用呼叫端宣告的形狀。
 *
 * `Response.json()` 回傳 `unknown`，呼叫端需要明確描述預期欄位。
 * 此函式把斷言集中在一處並以 `T` 參數化，避免每個呼叫點各寫一次
 * `as`；資料形狀由後端 API 契約保證。
 */
export async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

/**
 * 自 API 錯誤回應取出訊息。後端錯誤一律以 { error: string } 回傳，
 * 解析失敗或格式不符時退回通用文案。
 */
export async function readError(response: Response): Promise<string> {
  try {
    const body = await readJson<{ error?: unknown }>(response);
    return typeof body?.error === "string" ? body.error : "操作失敗";
  } catch {
    return "操作失敗";
  }
}
