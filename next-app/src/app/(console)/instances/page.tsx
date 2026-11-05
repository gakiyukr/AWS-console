'use client'

// 執行個體總覽（MVP 核心）：狀態統計卡、表格（名稱／OCID 截斷／shape／AD／
// 狀態／公網 IP／IPv6）與六大操作。電源操作送出後輪詢單台狀態；
// 換 IP、IPv6、防火牆為 SSE 進度卡（沿用部署頁模式）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Globe,
  Loader2,
  Network,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Share2,
  ShieldCheck,
  Tag,
  Terminal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Chip } from "@/components/chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NoSsr } from "@/components/no-ssr";
import { Table } from "@/components/table-lazy";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { readDeploymentStream } from "@/lib/deployment-stream";
import { isTransitionState, lifecycleLabel, truncateOcid } from "@/lib/ocid";
import { CustomSelect } from "@/components/ui/select";

interface OciAccountOption {
  id: number
  name: string
  region: string
  compartmentOcid: string
}

interface InstanceRow {
  id: string
  displayName: string
  alias?: string | null
  notes?: string | null
  lifecycleState: string
  shape: string
  availabilityDomain: string
  timeCreated: string | null
  publicIp: string | null
  ipv6Address: string | null
}

// 換 IP／IPv6／防火牆／主機 Agent SSE 的 stage 代碼 → 繁中標籤
const OPERATION_STAGE_LABELS: Record<string, string> = {
  vcn: "VCN IPv6 CIDR",
  subnet: "子網 IPv6 CIDR",
  igw: "Internet Gateway",
  route: "路由表",
  "security-list": "安全清單",
  assign: "指派位址",
  lookup: "查詢現有 IP",
  delete: "刪除舊 IP",
  create: "配置新 IP",
  "agent-submit": "送出 Agent 指令",
  "agent-exec": "主機端執行中",
  done: "完成",
};

const POWER_POLL_INTERVAL_MS = 3_000;
const POWER_POLL_MAX_ATTEMPTS = 40;

type PendingPowerAction = "start" | "stop" | "force-stop" | "reboot" | "force-reboot";

interface PendingOperation {
  kind: "reboot-ip" | "ipv6" | "firewall" | "host-firewall"
  instance: InstanceRow
}

export default function InstancesPage() {
  const [accounts, setAccounts] = useState<OciAccountOption[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [region, setRegion] = useState<string>("");
  const [loading, setLoading] = useState(true);
  // 電源操作後輪詢中的執行個體 OCID 集合
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set());
  const pollingIdsRef = useRef<Set<string>>(new Set());
  const [pendingPower, setPendingPower] = useState<{ instance: InstanceRow, action: PendingPowerAction } | null>(null);
  const [powerSubmitting, setPowerSubmitting] = useState(false);
  const [stopForce, setStopForce] = useState(false);
  const [cleanHost, setCleanHost] = useState(true);
  const [operation, setOperation] = useState<PendingOperation | null>(null);
  const [operationRunning, setOperationRunning] = useState(false);
  const pollTimersRef = useRef<Map<string, number>>(new Map());
  const pollInstanceStatusRef = useRef<(instanceId: string, targetStates: string[], attempt?: number) => void>(() => {});

  // 終止主機對話框狀態
  const [terminatingInstance, setTerminatingInstance] = useState<InstanceRow | null>(null);
  const [preserveBootVolume, setPreserveBootVolume] = useState(true);
  const [terminating, setTerminating] = useState(false);

  // 自訂別名對話框狀態
  const [editingAliasInstance, setEditingAliasInstance] = useState<InstanceRow | null>(null);
  const [aliasValue, setAliasValue] = useState("");
  const [notesValue, setNotesValue] = useState("");
  const [savingAlias, setSavingAlias] = useState(false);

  // 分享連結對話框狀態
  const [sharingInstance, setSharingInstance] = useState<InstanceRow | null>(null);
  const [shareAction, setShareAction] = useState("start");
  const [shareDuration, setShareDuration] = useState("24");
  const [shareMaxUses, setShareMaxUses] = useState("0");
  const [shareNote, setShareNote] = useState("");
  const [creatingShare, setCreatingShare] = useState(false);
  const [createdShareUrl, setCreatedShareUrl] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/oci-accounts");
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ accounts: OciAccountOption[] }>(response);
      setAccounts(payload.accounts);
      return payload.accounts;
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 OCI 帳號失敗");
      return [];
    }
  }, []);

  const loadInstances = useCallback(async (targetAccountId: string, page: string | null = null) => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (targetAccountId) query.set("account_id", targetAccountId);
      if (page) query.set("page", page);
      const response = await fetch(`/api/instances?${query.toString()}`);
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ instances: InstanceRow[], nextPage: string | null, region: string }>(response);
      setInstances(payload.instances);
      setNextPage(payload.nextPage);
      setRegion(payload.region || "");
      // 過渡態（佈建中／啟動中／關機中）自動輪詢至目標態
      for (const row of payload.instances) {
        if (!pollingIdsRef.current.has(row.id) && isTransitionState(row.lifecycleState)) {
          const targets = row.lifecycleState === "STOPPING" ? ["STOPPED"] : ["RUNNING"];
          setPollingIds(previous => new Set(previous).add(row.id));
          pollInstanceStatusRef.current(row.id, targets);
        }
      }
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入執行個體失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const loaded = await loadAccounts();
      if (cancelled) return;
      const defaultId = loaded.find(account => account.id)?.id;
      if (typeof defaultId === "number") {
        setAccountId(String(defaultId));
        await loadInstances(String(defaultId));
      } else {
        setLoading(false);
      }
    }
    void init();
    const timers = pollTimersRef.current;
    return () => {
      cancelled = true;
      timers.forEach(timer => window.clearTimeout(timer));
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 電源操作送出後：輪詢單台狀態直到目標態（3s × 40）
  function pollInstanceStatus(instanceId: string, targetStates: string[], attempt = 0) {
    if (attempt >= POWER_POLL_MAX_ATTEMPTS) {
      pollingIdsRef.current.delete(instanceId);
      setPollingIds(previous => {
        const next = new Set(previous);
        next.delete(instanceId);
        return next;
      });
      toastDanger("狀態更新逾時，請手動重新整理。");
      return;
    }
    pollingIdsRef.current.add(instanceId);
    const timer = window.setTimeout(async () => {
      try {
        const query = accountId ? `?account_id=${accountId}` : "";
        const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}${query}`);
        if (response.ok) {
          const payload = await readJson<{ instance: { lifecycleState: string } }>(response);
          setInstances(previous => previous.map(row => row.id === instanceId
            ? { ...row, lifecycleState: payload.instance.lifecycleState }
            : row));
          if (targetStates.includes(payload.instance.lifecycleState)) {
            pollingIdsRef.current.delete(instanceId);
            setPollingIds(previous => {
              const next = new Set(previous);
              next.delete(instanceId);
              return next;
            });
            toast.success(`狀態已更新：${lifecycleLabel(payload.instance.lifecycleState)}`);
            return;
          }
        }
        pollInstanceStatus(instanceId, targetStates, attempt + 1);
      } catch {
        pollInstanceStatus(instanceId, targetStates, attempt + 1);
      }
    }, POWER_POLL_INTERVAL_MS);
    pollTimersRef.current.set(instanceId, timer);
  }
  pollInstanceStatusRef.current = pollInstanceStatus;

  async function submitPowerAction() {
    if (!pendingPower) return;
    const { instance, action } = pendingPower;
    const resolvedAction = action === "stop" && stopForce ? "force-stop" : action;
    setPowerSubmitting(true);
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(instance.id)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: resolvedAction, accountId }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ targetStates: string[] }>(response);
      toast.success(`${lifecycleLabel(instance.lifecycleState)} → 操作已送出`);
      setPendingPower(null);
      setStopForce(false);
      setPollingIds(previous => new Set(previous).add(instance.id));
      pollInstanceStatus(instance.id, payload.targetStates);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "電源操作失敗");
    } finally {
      setPowerSubmitting(false);
    }
  }

  // 換 IP／IPv6／防火牆／主機 Agent：SSE 進度
  async function runOperation() {
    if (!operation || operationRunning) return;
    setOperationRunning(true);
    try {
      const payload: Record<string, unknown> = { accountId };
      if (operation.kind === "firewall") {
        payload.cleanHost = cleanHost;
      }
      const response = await fetch(`/api/instances/${encodeURIComponent(operation.instance.id)}/${operation.kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await readDeploymentStream(response, { stageLabels: OPERATION_STAGE_LABELS, onProgress: message => toast.success(message) });
      const message = typeof result.message === "string" ? result.message : "操作完成";
      toast.success(message);
      if (Array.isArray(result.warnings)) {
        for (const warning of result.warnings) {
          toast.warning(String(warning));
        }
      }
      setOperation(null);
      await loadInstances(accountId);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "操作失敗");
    } finally {
      setOperationRunning(false);
    }
  }

  function copyText(value: string) {
    void navigator.clipboard.writeText(value).then(
      () => toast.success("已複製"),
      () => toastDanger("複製失敗"),
    );
  }

  // 終止執行個體（Phase 2）
  async function submitTerminate() {
    if (!terminatingInstance) return;
    setTerminating(true);
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(terminatingInstance.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, preserveBootVolume }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ targetStates: string[], message: string }>(response);
      toast.success(payload.message || "終止指令已送出");
      const targetId = terminatingInstance.id;
      setTerminatingInstance(null);
      setPollingIds(previous => new Set(previous).add(targetId));
      pollInstanceStatus(targetId, payload.targetStates);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "終止執行個體失敗");
    } finally {
      setTerminating(false);
    }
  }

  // 儲存別名與備註（Phase 2）
  async function submitSaveAlias() {
    if (!editingAliasInstance) return;
    setSavingAlias(true);
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(editingAliasInstance.id)}/alias`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: aliasValue, notes: notesValue }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("別名已更新");
      setEditingAliasInstance(null);
      await loadInstances(accountId);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "儲存別名失敗");
    } finally {
      setSavingAlias(false);
    }
  }

  // 建立分享連結（Phase 2）
  async function submitCreateShare() {
    if (!sharingInstance) return;
    setCreatingShare(true);
    try {
      const response = await fetch("/api/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceId: sharingInstance.id,
          action: shareAction,
          ociAccountId: Number(accountId),
          durationHours: Number(shareDuration),
          maxUses: Number(shareMaxUses),
          note: shareNote,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ link: { id: string } }>(response);
      const url = `${window.location.origin}/share/${payload.link.id}`;
      setCreatedShareUrl(url);
      toast.success("分享連結已成功產生");
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "建立分享連結失敗");
    } finally {
      setCreatingShare(false);
    }
  }

  const runningCount = instances.filter(row => row.lifecycleState === "RUNNING").length;
  const stoppedCount = instances.filter(row => row.lifecycleState === "STOPPED").length;

  const selectedAccount = accounts.find(account => String(account.id) === accountId);
  const busyStates = pollingIds;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">執行個體</h2>
          <p className="text-sm text-muted">
            {selectedAccount
              ? ` compartment 即時清單 · ${selectedAccount.region}${region && region !== selectedAccount.region ? `（回報 region：${region}）` : ""}`
              : "即時列出 compartment 內的執行個體"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/instances/new">
            <Button size="sm" variant="secondary">
              <Plus aria-hidden size={16} />
              新增執行個體
            </Button>
          </Link>
          <div className="w-48">
            <CustomSelect
              value={accountId}
              placeholder="選擇 OCI 帳號"
              options={accounts.map(account => ({
                value: String(account.id),
                label: account.name,
              }))}
              onChange={val => {
                setAccountId(val);
                void loadInstances(val);
              }}
            />
          </div>
          <Button size="sm" isDisabled={loading} onPress={() => loadInstances(accountId)}>
            {loading ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <RefreshCw aria-hidden size={16} />}
            重新整理
          </Button>
        </div>
      </div>

      {accounts.length === 0 && !loading ? (
        <Card>
          <Card.Content className="grid gap-2 p-8 text-center">
            <p className="text-sm text-muted">尚未設定 OCI 帳號。</p>
            <div>
              <a href="/accounts" className="text-sm underline underline-offset-4">前往帳號管理新增</a>
            </div>
          </Card.Content>
        </Card>
      ) : (
        <>
          {/* 狀態統計卡 */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="執行中" value={runningCount} tone="primary" />
            <StatCard label="已停止" value={stoppedCount} />
            <StatCard label="總數" value={instances.length} />
          </div>

          <Card>
            <Card.Content className="p-6">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-muted">
                  <Loader2 aria-hidden size={20} className="mr-2 animate-spin" />
                  載入中...
                </div>
              ) : instances.length === 0 ? (
                <div className="py-12 text-center text-sm text-muted">此 compartment 沒有執行個體</div>
              ) : (
                <div className="overflow-x-auto">
                  <NoSsr>
                  <Table.Root>
                    <Table.ScrollContainer>
                      <Table.Content aria-label="執行個體清單">
                        <Table.Header>
                          <Table.Column isRowHeader>名稱</Table.Column>
                          <Table.Column>OCID</Table.Column>
                          <Table.Column>Shape</Table.Column>
                          <Table.Column>AD</Table.Column>
                          <Table.Column>狀態</Table.Column>
                          <Table.Column>公網 IP</Table.Column>
                          <Table.Column>IPv6</Table.Column>
                          <Table.Column>操作</Table.Column>
                        </Table.Header>
                        <Table.Body>
                          {instances.map(row => {
                            const busy = busyStates.has(row.id) || isTransitionState(row.lifecycleState);
                            const running = row.lifecycleState === "RUNNING";
                            return (
                              <Table.Row id={row.id} key={row.id}>
                                <Table.Cell>
                                  <div className="flex items-center gap-1.5">
                                    <div>
                                      <div className="flex items-center gap-1.5">
                                        <span className="font-medium">{row.alias || row.displayName || "（未命名）"}</span>
                                        {row.alias ? (
                                          <span className="rounded bg-default px-1.5 py-0.5 text-[10px] text-muted">
                                            {row.displayName}
                                          </span>
                                        ) : null}
                                      </div>
                                      {row.notes ? <p className="text-[11px] text-muted">{row.notes}</p> : null}
                                    </div>
                                    <button
                                      type="button"
                                      className="text-muted hover:text-foreground"
                                      title="修改別名與備註"
                                      onClick={() => {
                                        setEditingAliasInstance(row);
                                        setAliasValue(row.alias || "");
                                        setNotesValue(row.notes || "");
                                      }}
                                    >
                                      <Tag size={12} />
                                    </button>
                                  </div>
                                </Table.Cell>
                                <Table.Cell>
                                  <button
                                    type="button"
                                    title={row.id}
                                    className="flex items-center gap-1 font-mono text-xs text-muted hover:text-foreground"
                                    onClick={() => copyText(row.id)}
                                  >
                                    {truncateOcid(row.id)}
                                    <Copy aria-hidden size={12} />
                                  </button>
                                </Table.Cell>
                                <Table.Cell><span className="text-xs">{row.shape || "—"}</span></Table.Cell>
                                <Table.Cell><span className="text-xs">{row.availabilityDomain || "—"}</span></Table.Cell>
                                <Table.Cell>
                                  <Chip variant={running ? "primary" : row.lifecycleState === "STOPPED" ? "soft" : "secondary"}>
                                    {busy ? <Loader2 aria-hidden size={10} className="mr-1 animate-spin" /> : null}
                                    {lifecycleLabel(row.lifecycleState)}
                                  </Chip>
                                </Table.Cell>
                                <Table.Cell><span className="font-mono text-xs">{row.publicIp || "—"}</span></Table.Cell>
                                <Table.Cell><span className="font-mono text-xs">{row.ipv6Address || "—"}</span></Table.Cell>
                                <Table.Cell>
                                  <div className="flex flex-wrap gap-1">
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      aria-label="開機"
                                      isDisabled={busy || running}
                                      onPress={() => setPendingPower({ instance: row, action: "start" })}
                                    >
                                      <Power aria-hidden size={14} />
                                      開機
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      aria-label="關機"
                                      isDisabled={busy || row.lifecycleState === "STOPPED"}
                                      onPress={() => { setStopForce(false); setPendingPower({ instance: row, action: "stop" }); }}
                                    >
                                      <PowerOff aria-hidden size={14} />
                                      關機
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label="重啟"
                                      isDisabled={busy || !running}
                                      onPress={() => setPendingPower({ instance: row, action: "reboot" })}
                                    >
                                      <RotateCcw aria-hidden size={14} />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label="換 IP"
                                      isDisabled={busy || !running}
                                      onPress={() => setOperation({ kind: "reboot-ip", instance: row })}
                                    >
                                      <Network aria-hidden size={14} />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label="加 IPv6"
                                      isDisabled={busy}
                                      onPress={() => setOperation({ kind: "ipv6", instance: row })}
                                    >
                                      <Globe aria-hidden size={14} />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label="開防火牆"
                                      isDisabled={busy}
                                      onPress={() => setOperation({ kind: "firewall", instance: row })}
                                    >
                                      <ShieldCheck aria-hidden size={14} />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label="清理主機防火牆 (iptables)"
                                      isDisabled={busy || !running}
                                      onPress={() => setOperation({ kind: "host-firewall", instance: row })}
                                    >
                                      <Terminal aria-hidden size={14} />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label="建立分享連結"
                                      isDisabled={busy}
                                      onPress={() => {
                                        setSharingInstance(row);
                                        setShareAction("start");
                                        setShareDuration("24");
                                        setShareMaxUses("0");
                                        setShareNote("");
                                        setCreatedShareUrl(null);
                                      }}
                                    >
                                      <Share2 aria-hidden size={14} />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-danger"
                                      aria-label="終止執行個體"
                                      isDisabled={busy || row.lifecycleState === "TERMINATED" || row.lifecycleState === "TERMINATING"}
                                      onPress={() => {
                                        setTerminatingInstance(row);
                                        setPreserveBootVolume(true);
                                      }}
                                    >
                                      <Trash2 aria-hidden size={14} />
                                    </Button>
                                  </div>
                                </Table.Cell>
                              </Table.Row>
                            );
                          })}
                        </Table.Body>
                      </Table.Content>
                    </Table.ScrollContainer>
                  </Table.Root>
                  </NoSsr>
                </div>
              )}
              {nextPage ? (
                <div className="mt-4 flex justify-end">
                  <Button size="sm" variant="secondary" isDisabled={loading} onPress={() => loadInstances(accountId, nextPage)}>
                    下一頁
                  </Button>
                </div>
              ) : null}
            </Card.Content>
          </Card>
        </>
      )}

      {/* 開機／關機／重啟確認 */}
      <ConfirmDialog
        open={pendingPower !== null}
        onOpenChange={open => { if (!open) { setPendingPower(null); setStopForce(false); } }}
        title={powerDialogTitle(pendingPower?.action)}
        confirmLabel="確認執行"
        pending={powerSubmitting}
        onConfirm={submitPowerAction}
      >
        {pendingPower ? (
          <div className="grid gap-2 text-sm">
            <p>對「{pendingPower.instance.displayName || "（未命名）"}」執行{powerDialogTitle(pendingPower.action)}？</p>
            {pendingPower.action === "stop" ? (
              <label className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={stopForce}
                  onChange={event => setStopForce(event.target.checked)}
                />
                強制關機（STOP）：略過作業系統關機程序，有檔案系統損壞風險
              </label>
            ) : null}
            {pendingPower.action === "reboot" ? (
              <p className="text-xs text-muted">將以 SOFTRESET 優雅重啟；強制重啟（RESET）風險較高，未在此提供。</p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>

      {/* 換 IP／IPv6／防火牆／主機清理確認 */}
      <ConfirmDialog
        open={operation !== null}
        onOpenChange={open => { if (!open && !operationRunning) setOperation(null); }}
        title={operationTitle(operation?.kind)}
        confirmLabel="開始操作"
        pending={operationRunning}
        onConfirm={runOperation}
      >
        {operation ? (
          <OperationWarning
            kind={operation.kind}
            cleanHost={cleanHost}
            setCleanHost={setCleanHost}
            isInstanceRunning={operation.instance.lifecycleState === "RUNNING"}
          />
        ) : null}
      </ConfirmDialog>

      {/* 終止執行個體確認（Phase 2） */}
      <ConfirmDialog
        open={terminatingInstance !== null}
        onOpenChange={open => { if (!open && !terminating) setTerminatingInstance(null); }}
        title={`終止執行個體：${terminatingInstance?.displayName || ""}`}
        confirmLabel="確認終止（不可逆）"
        pending={terminating}
        onConfirm={submitTerminate}
      >
        <div className="grid gap-3 text-sm">
          <p className="text-danger font-semibold">
            警告：此操作將永久銷毀此執行個體，該主機將進入 TERMINATING 狀態！
          </p>
          <label className="flex items-start gap-2 rounded-md border border-divider bg-surface-secondary/50 p-3 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={preserveBootVolume}
              onChange={event => setPreserveBootVolume(event.target.checked)}
              className="mt-0.5 rounded border-divider"
            />
            <div>
              <span className="font-medium text-foreground">保留開機磁碟 (preserveBootVolume)</span>
              <p className="text-muted mt-0.5">
                勾選後將保留該主機的開機磁碟區（Boot Volume），後續可用於掛載或建立新機器；取消勾選則開機磁碟一併被永久刪除。
              </p>
            </div>
          </label>
        </div>
      </ConfirmDialog>

      {/* 自訂別名與備註對話框（Phase 2） */}
      <ConfirmDialog
        open={editingAliasInstance !== null}
        onOpenChange={open => { if (!open) setEditingAliasInstance(null); }}
        title="自訂主機別名與備註"
        confirmLabel="儲存設定"
        pending={savingAlias}
        onConfirm={submitSaveAlias}
      >
        <div className="grid gap-3 text-sm">
          <div>
            <label htmlFor="alias-input" className="text-xs font-medium">主機別名（Alias）</label>
            <Input
              id="alias-input"
              placeholder="例：個人網站伺服器"
              value={aliasValue}
              onChange={event => setAliasValue(event.target.value)}
              className="mt-1"
            />
            <p className="mt-1 text-[11px] text-muted">留空儲存可清除自訂別名，改還原為 OCI 原生名稱。</p>
          </div>
          <div>
            <label htmlFor="notes-input" className="text-xs font-medium">備註說明（選填）</label>
            <Input
              id="notes-input"
              placeholder="例：部署在 ap-tokyo-1，包含 Nginx 與 Docker"
              value={notesValue}
              onChange={event => setNotesValue(event.target.value)}
              className="mt-1"
            />
          </div>
        </div>
      </ConfirmDialog>

      {/* 建立分享連結對話框（Phase 2） */}
      <ConfirmDialog
        open={sharingInstance !== null}
        onOpenChange={open => { if (!open) setSharingInstance(null); }}
        title={`建立分享連結：${sharingInstance?.displayName || ""}`}
        confirmLabel={createdShareUrl ? "完成" : "產生連結"}
        pending={creatingShare}
        onConfirm={createdShareUrl ? async () => setSharingInstance(null) : submitCreateShare}
      >
        <div className="grid gap-3 text-sm">
          {createdShareUrl ? (
            <div className="grid gap-2">
              <p className="text-xs text-success font-semibold">分享連結已建立成功！</p>
              <div className="flex items-center gap-2 rounded-md border border-divider bg-surface-secondary/50 p-2 font-mono text-xs">
                <span className="truncate flex-1">{createdShareUrl}</span>
                <Button size="sm" variant="ghost" isIconOnly onPress={() => copyText(createdShareUrl)}>
                  <Copy size={13} />
                </Button>
              </div>
              <p className="text-[11px] text-muted">
                獲得此連結的任何人皆可在授權限制內執行指定操作，無需登入主控台。
              </p>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="share-action-select" className="text-xs font-medium">授權操作動作</label>
                <div className="mt-1">
                  <CustomSelect
                    id="share-action-select"
                    value={shareAction}
                    options={[
                      { value: "start", label: "開機 (START)" },
                      { value: "stop", label: "關機 (SOFTSTOP)" },
                      { value: "force-stop", label: "強制斷電 (STOP)" },
                      { value: "reboot", label: "重啟 (SOFTRESET)" },
                      { value: "reboot-ip", label: "更換公網 IP (rotate-ip)" },
                      { value: "firewall", label: "一鍵開防火牆 (firewall)" },
                    ]}
                    onChange={setShareAction}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="share-duration-select" className="text-xs font-medium">有效期限</label>
                  <div className="mt-1">
                    <CustomSelect
                      id="share-duration-select"
                      value={shareDuration}
                      options={[
                        { value: "1", label: "1 小時" },
                        { value: "6", label: "6 小時" },
                        { value: "24", label: "24 小時（1 天）" },
                        { value: "72", label: "72 小時（3 天）" },
                        { value: "168", label: "7 天" },
                      ]}
                      onChange={setShareDuration}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="share-max-uses-select" className="text-xs font-medium">次數上限</label>
                  <div className="mt-1">
                    <CustomSelect
                      id="share-max-uses-select"
                      value={shareMaxUses}
                      options={[
                        { value: "0", label: "無限制" },
                        { value: "1", label: "僅限 1 次" },
                        { value: "3", label: "最多 3 次" },
                        { value: "5", label: "最多 5 次" },
                      ]}
                      onChange={setShareMaxUses}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label htmlFor="share-note-input" className="text-xs font-medium">連結備註（選填）</label>
                <Input
                  id="share-note-input"
                  placeholder="例：提供給測試同仁開機使用"
                  value={shareNote}
                  onChange={event => setShareNote(event.target.value)}
                  className="mt-1"
                />
              </div>
            </>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string, value: number, tone?: "primary" }) {
  return (
    <Card>
      <Card.Content className="p-4">
        <p className="text-xs text-muted">{label}</p>
        <p className={`text-2xl font-bold ${tone === "primary" ? "text-[var(--accent)]" : ""}`}>{value}</p>
      </Card.Content>
    </Card>
  );
}

function powerDialogTitle(action: PendingPowerAction | undefined) {
  switch (action) {
    case "start": return "開機";
    case "stop": return "關機";
    case "force-stop": return "強制關機";
    case "reboot": return "重啟";
    case "force-reboot": return "強制重啟";
    default: return "電源操作";
  }
}

function operationTitle(kind: PendingOperation["kind"] | undefined) {
  switch (kind) {
    case "reboot-ip": return "更換公網 IP";
    case "ipv6": return "一鍵加 IPv6";
    case "firewall": return "一鍵開防火牆";
    case "host-firewall": return "清理主機防火牆 (iptables)";
    default: return "操作確認";
  }
}

function OperationWarning({
  kind,
  cleanHost,
  setCleanHost,
  isInstanceRunning,
}: {
  kind: PendingOperation["kind"]
  cleanHost: boolean
  setCleanHost: (val: boolean) => void
  isInstanceRunning: boolean
}) {
  if (kind === "reboot-ip") {
    return (
      <div className="grid gap-2 text-sm">
        <p>刪除目前的臨時公網 IP 並配置新 IP，位址會立即改變。</p>
        <p className="text-xs text-muted">Reserved Public IP 不受影響（偵測到時將直接拒絕操作）；SSH 等既有連線會中斷。</p>
      </div>
    );
  }
  if (kind === "ipv6") {
    return (
      <div className="grid gap-2 text-sm">
        <p>將完整開通 IPv6：VCN /56 → 子網 /64 → ::/0 路由 → 安全清單 → VNIC 指派。</p>
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs">
          注意：IPv6 於 VCN／子網層級開通後即無法關閉。
        </p>
      </div>
    );
  }
  if (kind === "host-firewall") {
    return (
      <div className="grid gap-2 text-sm">
        <p>
          透過 <strong>Oracle Cloud Agent（Run Command API）</strong>向執行個體發送指令，
          自動註解 Ubuntu（<code>/etc/iptables/rules.v4 & rules.v6</code>）或 Oracle Linux 預設阻擋其他埠的 REJECT 鏈。
        </p>
        <p className="text-xs text-muted">
          本指令安全執行，絕不沖刷（flush）iSCSI 開機磁碟及系統核心規則；執行個體必須處於 <strong>RUNNING</strong> 開機狀態且已啟用 Cloud Agent。
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <p>將對子網的預設安全清單全開入站（TCP／UDP／ICMP，v4+v6）與出站；已存在相同規則時自動跳過。</p>
      <label className="flex items-start gap-2 rounded-md border border-divider bg-surface-secondary/50 p-3 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={cleanHost}
          onChange={event => setCleanHost(event.target.checked)}
          className="mt-0.5 rounded border-divider"
        />
        <div>
          <span className="font-medium text-foreground">同步清理主機層 iptables（OCI Cloud Agent）</span>
          <p className="text-muted mt-0.5">
            自動透過 Cloud Agent 註解 Ubuntu／Oracle Linux 出廠預設擋掉 22 以外埠的 REJECT 規則。
          </p>
          {!isInstanceRunning && (
            <p className="text-warning mt-1">注意：目前主機非開機狀態，將僅處理雲層規則。</p>
          )}
        </div>
      </label>
    </div>
  );
}
