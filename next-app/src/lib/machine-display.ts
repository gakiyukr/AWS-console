// 機器狀態的顯示對照與複製工具：機器總覽（EC2／Lightsail）與公開分享頁
// 共用，避免狀態標籤在兩處各自維護而漂移。
import { toast } from "@heroui/react/toast";
import type { ChipVariant } from "@/components/chip";

export const STATE_LABELS: Record<string, string> = {
  running: "運行中",
  stopped: "已停止",
  pending: "啟動中",
  stopping: "停止中",
  "shutting-down": "關閉中",
  terminated: "已終止",
};

/** 狀態代碼 → 繁中標籤；未知代碼原樣顯示。 */
export function stateLabel(state: string | null) {
  return state ? STATE_LABELS[state] || state : "未知";
}

/** 狀態標籤配色：運行中強調、已停止中性、其餘（含查詢失敗）柔和。 */
export function stateBadgeVariant(state: string | null): ChipVariant {
  if (state === "running") return "primary";
  if (state === "stopped" || state === "stopping") return "secondary";
  return "soft";
}

/** 複製文字到剪貼簿並提示；失敗時以紅色 toast 回報。 */
export async function copyToClipboard(text: string, successMessage = "已複製到剪貼簿") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch {
    toast("複製失敗，請手動選取", { variant: "danger" });
  }
}
