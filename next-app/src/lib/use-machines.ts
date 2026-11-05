'use client'

// 機器總覽的共用邏輯：載入清單、電源操作、IPv6、終止、移除與確認對話框
// 狀態。EC2 與 Lightsail 兩個頁面只負責各自的標題、統計卡與新增流程，
// 其餘行為在此統一，避免兩份 300 行的重複程式碼各自漂移。
import { useCallback, useEffect, useState } from "react";
import { toast } from "@heroui/react/toast";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import type { MachineRow } from "@/components/machine-table";

export type Platform = "ec2" | "lightsail";
export type PowerAction = "start" | "stop" | "reboot" | "terminate";

const POWER_ACTION_TOASTS: Record<PowerAction, string> = {
  start: "已送出啟動請求",
  stop: "已送出關機請求",
  reboot: "已送出重啟請求",
  terminate: "已終止並自清單移除",
};

export function useMachines(platform: Platform) {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionPendingId, setActionPendingId] = useState<number | null>(null);
  const [rebootIpPending, setRebootIpPending] = useState(false);
  const [ipv6Pending, setIpv6Pending] = useState(false);
  const [removing, setRemoving] = useState(false);

  // 確認對話框：目標與開關分離保存，關閉動畫期間仍能顯示內容
  const [stopTarget, setStopTarget] = useState<MachineRow | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [rebootTarget, setRebootTarget] = useState<MachineRow | null>(null);
  const [rebootOpen, setRebootOpen] = useState(false);
  const [rebootIpTarget, setRebootIpTarget] = useState<MachineRow | null>(null);
  const [rebootIpOpen, setRebootIpOpen] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<MachineRow | null>(null);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [ipv6Target, setIpv6Target] = useState<MachineRow | null>(null);
  const [ipv6Open, setIpv6Open] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MachineRow | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  // DDNS：對話框目標與 hostname 表單；ddnsConfigured 由頁面載入後傳入
  const [ddnsTarget, setDdnsTarget] = useState<MachineRow | null>(null);
  const [ddnsOpen, setDdnsOpen] = useState(false);
  const [ddnsPending, setDdnsPending] = useState(false);
  const [ddnsHostname, setDdnsHostname] = useState("");

  const loadMachines = useCallback(async () => {
    try {
      const response = await fetch(`/api/machines?platform=${platform}`);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      setMachines(await readJson<MachineRow[]>(response));
    } catch {
      toastDanger("載入機器清單失敗");
    }
  }, [platform]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadMachines();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMachines]);

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/machines?platform=${platform}`);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      setMachines(await readJson<MachineRow[]>(response));
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "重新整理失敗");
    } finally {
      setRefreshing(false);
    }
  }

  /** 直接執行的電源操作（start 不經確認；stop/reboot/terminate 先開對話框）。 */
  async function performAction(machine: MachineRow, action: PowerAction) {
    setActionPendingId(machine.id);
    try {
      const response = await fetch(`/api/machines/${machine.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success(`${machine.name} ${POWER_ACTION_TOASTS[action]}`);
      // 給 AWS 一點時間反映狀態，再重新載入
      await new Promise(resolve => setTimeout(resolve, 2000));
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "操作失敗");
    } finally {
      setActionPendingId(null);
    }
  }

  function requestStart(machine: MachineRow) {
    void performAction(machine, "start");
  }

  function requestStop(machine: MachineRow) {
    setStopTarget(machine);
    setStopOpen(true);
  }

  function requestReboot(machine: MachineRow) {
    setRebootTarget(machine);
    setRebootOpen(true);
  }

  function requestTerminate(machine: MachineRow) {
    setTerminateTarget(machine);
    setTerminateOpen(true);
  }

  function requestRebootIp(machine: MachineRow) {
    setRebootIpTarget(machine);
    setRebootIpOpen(true);
  }

  function requestIpv6(machine: MachineRow) {
    setIpv6Target(machine);
    setIpv6Open(true);
  }

  function requestRemove(machine: MachineRow) {
    setRemoveTarget(machine);
    setRemoveOpen(true);
  }

  function requestDdns(machine: MachineRow) {
    setDdnsTarget(machine);
    setDdnsHostname(machine.ddnsHostname || "");
    setDdnsOpen(true);
  }

  /** 儲存 DDNS 綁定並立即同步；成功後重新載入清單（ddnsHostname 欄會變）。 */
  async function confirmDdns() {
    const machine = ddnsTarget;
    if (!machine || ddnsPending) return;
    setDdnsPending(true);
    try {
      const response = await fetch(`/api/machines/${machine.id}/ddns`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: ddnsHostname.trim() }),
      });
      const payload = await readJson<{ message?: string; ddnsWarning?: string }>(response);
      if (!response.ok) throw new Error(await readError(response));
      toast.success(payload.message || "DDNS 已同步");
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "DDNS 同步失敗");
    } finally {
      setDdnsPending(false);
    }
  }

  /** 停用 DDNS（清除綁定；CF 記錄保留）。 */
  async function clearDdns() {
    const machine = ddnsTarget;
    if (!machine || ddnsPending) return;
    setDdnsPending(true);
    try {
      const response = await fetch(`/api/machines/${machine.id}/ddns`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("DDNS 已停用（Cloudflare 記錄保留，未自動刪除）");
      setDdnsOpen(false);
      setDdnsTarget(null);
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "停用 DDNS 失敗");
    } finally {
      setDdnsPending(false);
    }
  }

  async function confirmStop() {
    const machine = stopTarget;
    setStopOpen(false);
    setStopTarget(null);
    if (machine) await performAction(machine, "stop");
  }

  async function confirmReboot() {
    const machine = rebootTarget;
    setRebootOpen(false);
    setRebootTarget(null);
    if (machine) await performAction(machine, "reboot");
  }

  async function confirmTerminate() {
    const machine = terminateTarget;
    setTerminateOpen(false);
    setTerminateTarget(null);
    if (machine) await performAction(machine, "terminate");
  }

  async function confirmRebootIp() {
    const machine = rebootIpTarget;
    if (!machine || actionPendingId !== null || rebootIpPending) return;
    setRebootIpOpen(false);
    setRebootIpTarget(null);
    setRebootIpPending(true);
    setActionPendingId(machine.id);
    try {
      const response = await fetch(`/api/machines/${machine.id}/reboot-ip`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("已送出停止→啟動請求（將更換公網 IP）。");
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更換 IP 失敗");
    } finally {
      await loadMachines();
      setRebootIpPending(false);
      setActionPendingId(null);
    }
  }

  async function confirmIpv6() {
    const machine = ipv6Target;
    if (!machine || actionPendingId !== null || ipv6Pending) return;
    setIpv6Open(false);
    setIpv6Target(null);
    setIpv6Pending(true);
    setActionPendingId(machine.id);
    try {
      const response = await fetch(`/api/machines/${machine.id}/ipv6`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ message?: string; warnings?: string[] }>(response);
      toast.success(payload.message || "IPv6 已開通");
      for (const warning of payload.warnings || []) {
        toastDanger(warning);
      }
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "開通 IPv6 失敗");
    } finally {
      await loadMachines();
      setIpv6Pending(false);
      setActionPendingId(null);
    }
  }

  async function confirmRemove() {
    const machine = removeTarget;
    if (!machine || removing) return;
    setRemoving(true);
    try {
      const response = await fetch(`/api/machines/${machine.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("機器已從清單移除");
      setRemoveOpen(false);
      setRemoveTarget(null);
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "移除失敗");
    } finally {
      setRemoving(false);
    }
  }

  return {
    machines,
    loading,
    refreshing,
    actionPendingId,
    rebootIpPending,
    ipv6Pending,
    removing,
    busyPending: rebootIpPending || ipv6Pending,
    loadMachines,
    refresh,
    actions: {
      onStart: requestStart,
      onStop: requestStop,
      onReboot: requestReboot,
      onRebootIp: requestRebootIp,
      onIpv6: requestIpv6,
      onDdns: requestDdns,
      onTerminate: requestTerminate,
      onRemove: requestRemove,
    },
    dialogs: {
      stop: { target: stopTarget, open: stopOpen, setOpen: setStopOpen, confirm: confirmStop },
      reboot: { target: rebootTarget, open: rebootOpen, setOpen: setRebootOpen, confirm: confirmReboot },
      terminate: { target: terminateTarget, open: terminateOpen, setOpen: setTerminateOpen, confirm: confirmTerminate },
      rebootIp: { target: rebootIpTarget, open: rebootIpOpen, setOpen: setRebootIpOpen, confirm: confirmRebootIp, pending: rebootIpPending },
      ipv6: { target: ipv6Target, open: ipv6Open, setOpen: setIpv6Open, confirm: confirmIpv6, pending: ipv6Pending },
      remove: { target: removeTarget, open: removeOpen, setOpen: setRemoveOpen, confirm: confirmRemove, pending: removing },
      ddns: {
        target: ddnsTarget,
        open: ddnsOpen,
        setOpen: setDdnsOpen,
        confirm: confirmDdns,
        clear: clearDdns,
        pending: ddnsPending,
        hostname: ddnsHostname,
        setHostname: setDdnsHostname,
      },
    },
  };
}
