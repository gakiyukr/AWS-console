// OCID 顯示輔助：OCI 的資源識別碼很長（70+ 字元），表格內一律截斷顯示
// （頭尾保留）＋複製按鈕，避免破版。
export function truncateOcid(ocid: string, head = 20, tail = 8): string {
  if (!ocid) return "—";
  if (ocid.length <= head + tail + 1) return ocid;
  return `${ocid.slice(0, head)}…${ocid.slice(-tail)}`;
}

export const LIFECYCLE_LABELS: Record<string, string> = {
  MOVING: "搬移中",
  PROVISIONING: "佈建中",
  RUNNING: "執行中",
  STARTING: "啟動中",
  STOPPING: "關機中",
  STOPPED: "已停止",
  CREATING_IMAGE: "建立映像中",
  TERMINATING: "終止中",
  TERMINATED: "已終止",
};

export function lifecycleLabel(state: string): string {
  return LIFECYCLE_LABELS[state] || state || "—";
}

/** 狀態是否為過渡態（電源輪詢中）。 */
export function isTransitionState(state: string): boolean {
  return state === "PROVISIONING" || state === "STARTING" || state === "STOPPING";
}
