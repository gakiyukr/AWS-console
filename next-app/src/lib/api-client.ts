// 各頁面共用的 API 互動小工具：錯誤訊息擷取與 toast 提示。
// 原本六個頁面各自複製同一份實作，集中於此避免文案與行為漂移。
import { toast } from "@heroui/react/toast";

/** 以紅色 toast 顯示錯誤訊息 */
export function toastDanger(message: string) {
  toast(message, { variant: "danger" });
}

/**
 * 自 API 錯誤回應取出訊息。後端錯誤一律以 { error: string } 回傳，
 * 解析失敗或格式不符時退回通用文案。
 */
export async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.error === "string" ? body.error : "操作失敗";
  } catch {
    return "操作失敗";
  }
}
