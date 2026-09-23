'use client'

// 機器總覽：D1 清單 × DescribeInstances 即時狀態。電源操作與移除
// 先經確認對話框；新增機器以「帳號 → Region → 執行個體」三層下拉
// 由後端即時列出候選，顯示名稱自 Name 標籤帶入。
import { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Modal } from "@heroui/react/modal";
import { Table } from "@/components/table-lazy";
import { NoSsr } from "@/components/no-ssr";
import { regionLabel } from "@/lib/regions";

// 機器列資料結構：D1 清單 × DescribeInstances 即時狀態合併後的結果
interface MachineRow {
  id: number
  region: string
  instanceId: string
  name: string
  isWavelength: boolean
  state: string | null
  publicIpAddress: string | null
  publicDnsName: string | null
  awsAccountId: number | null
  awsAccountName: string | null
}

interface AwsAccountOption {
  id: number
  name: string
  enabled: boolean
  isDefault: boolean
}

// GET /api/ec2/instances 回傳的候選執行個體
interface InstanceOption {
  instanceId: string
  name: string
  state: string
  isWavelength: boolean
}

const STATE_LABELS: Record<string, string> = {
  running: "運行中",
  stopped: "已停止",
  pending: "啟動中",
  stopping: "停止中",
  "shutting-down": "關閉中",
  terminated: "已終止",
};

function stateLabel(state: string | null) {
  if (!state) return "未知";
  return STATE_LABELS[state] || state;
}

function stateBadgeVariant(state: string | null) {
  if (state === "running") return "primary" as const;
  if (state === "stopped" || state === "stopping") return "secondary" as const;
  return "soft" as const;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.error === "string" ? body.error : "操作失敗";
  } catch {
    return "操作失敗";
  }
}

function toastDanger(message: string) {
  toast(message, { variant: "danger" });
}

export default function MachinesPage() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionPendingId, setActionPendingId] = useState<number | null>(null);

  const stats = {
    running: machines.filter(m => m.state === "running").length,
    stopped: machines.filter(m => m.state === "stopped").length,
    wavelength: machines.filter(m => m.isWavelength).length,
    regions: new Set(machines.map(m => m.region)).size,
  };

  async function loadMachines() {
    try {
      const response = await fetch("/api/machines");
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      setMachines(await response.json());
    } catch {
      toastDanger("載入機器清單失敗");
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      await loadMachines();
      if (!cancelled) setLoading(false);
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/machines");
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      setMachines(await response.json());
    } catch {
      toastDanger("重新整理失敗");
    } finally {
      setRefreshing(false);
    }
  }

  // 電源操作：stop/reboot 需先經確認對話框才會呼叫
  async function performAction(machine: MachineRow, action: "start" | "stop" | "reboot") {
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
      const message = action === "start" 
        ? `${machine.name} 已送出啟動請求`
        : action === "stop"
          ? `${machine.name} 已送出關閉請求`
          : `${machine.name} 已送出重啟請求`;
      toast.success(message);
      await new Promise(resolve => setTimeout(resolve, 2000));
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "操作失敗");
    } finally {
      setActionPendingId(null);
    }
  }

  // ── 新增機器對話框 ──────────────────────────────────────────
  const emptyAddForm = { awsAccountId: null as number | null, region: "", instanceId: "", name: "", isWavelength: false };
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyAddForm);
  const [adding, setAdding] = useState(false);
  const [accounts, setAccounts] = useState<AwsAccountOption[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingInstances, setLoadingInstances] = useState(false);

  async function openAddDialog() {
    setAddForm(emptyAddForm);
    setAddOpen(true);
    if (accounts.length) return;
    setLoadingAccounts(true);
    try {
      const response = await fetch("/api/accounts");
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json();
      const enabled: AwsAccountOption[] = payload.accounts.filter(
        (account: AwsAccountOption) => account.enabled,
      );
      setAccounts(enabled);
      const first = enabled.find(account => account.isDefault) || enabled[0];
      if (first) {
        setAddForm(previous => ({ ...previous, awsAccountId: first.id }));
        void loadAddRegions(first.id);
      }
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 AWS 帳號失敗");
    } finally {
      setLoadingAccounts(false);
    }
  }

  async function loadAddRegions(accountId: number | null) {
    setRegions([]);
    setInstances([]);
    setAddForm(previous => ({ ...previous, region: "", instanceId: "", name: "", isWavelength: false }));
    if (!accountId) return;
    setLoadingRegions(true);
    try {
      const response = await fetch(`/api/ec2/regions?account_id=${accountId}`);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json();
      setRegions(payload.regions || []);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 Region 失敗");
    } finally {
      setLoadingRegions(false);
    }
  }

  async function loadAddInstances(region: string, accountId: number | null) {
    setInstances([]);
    setAddForm(previous => ({ ...previous, instanceId: "", name: "", isWavelength: false }));
    if (!accountId || !region) return;
    setLoadingInstances(true);
    try {
      const response = await fetch(`/api/ec2/instances?account_id=${accountId}&region=${encodeURIComponent(region)}`);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json();
      setInstances(payload.instances || []);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入執行個體清單失敗");
    } finally {
      setLoadingInstances(false);
    }
  }

  // 選定執行個體後以 Name 標籤帶入顯示名稱，並記下 Wavelength 偵測結果
  function selectInstance(instanceId: string) {
    const instance = instances.find(item => item.instanceId === instanceId);
    setAddForm(previous => ({
      ...previous,
      instanceId,
      name: instance?.name || "",
      isWavelength: instance?.isWavelength ?? false,
    }));
  }

  async function submitAdd() {
    if (adding) return;
    setAdding(true);
    try {
      const response = await fetch("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("機器已新增");
      setAddOpen(false);
      setAddForm(emptyAddForm);
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "新增失敗");
    } finally {
      setAdding(false);
    }
  }

  // ── 確認對話框（關閉／移除共用結構，目標與開關分離保存） ────
  const [stopTarget, setStopTarget] = useState<MachineRow | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [rebootTarget, setRebootTarget] = useState<MachineRow | null>(null);
  const [rebootOpen, setRebootOpen] = useState(false);
  const [rebootIpTarget, setRebootIpTarget] = useState<MachineRow | null>(null);
  const [rebootIpOpen, setRebootIpOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MachineRow | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  function requestPowerAction(machine: MachineRow, action: "start" | "stop") {
    if (action === "stop") {
      setStopTarget(machine);
      setStopOpen(true);
      return;
    }
    void performAction(machine, action);
  }

  function requestReboot(machine: MachineRow) {
    setRebootTarget(machine);
    setRebootOpen(true);
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

  function requestRebootIp(machine: MachineRow) {
    setRebootIpTarget(machine);
    setRebootIpOpen(true);
  }

  async function confirmRebootIp() {
    const machine = rebootIpTarget;
    setRebootIpOpen(false);
    setRebootIpTarget(null);
    if (!machine) return;
    try {
      const response = await fetch(`/api/machines/${machine.id}/reboot-ip`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("已送出停止→啟動請求（將更換公網 IP）。");
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更換 IP 失敗");
    }
  }
  async function submitRemove() {
    const target = removeTarget;
    if (!target || removing) return;
    setRemoving(true);
    try {
      const response = await fetch(`/api/machines/${target.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
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

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
    toast.success("已複製到剪貼簿");
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">機器總覽</h2>
          <p className="text-sm text-muted">管理 D1 清單中所有 EC2 執行個體的電源狀態</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" isDisabled={adding} onPress={openAddDialog}>
            <Plus aria-hidden size={16} />
            新增機器
          </Button>
          <Button variant="secondary" size="sm" isDisabled={refreshing} onPress={refresh}>
            {refreshing ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <RefreshCw aria-hidden size={16} />}
            重新整理
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "運行中", value: stats.running },
          { label: "已停止", value: stats.stopped },
          { label: "Wavelength 執行個體", value: stats.wavelength },
          { label: "涵蓋地區", value: stats.regions },
        ].map(stat => (
          <Card key={stat.label}>
            <Card.Content className="grid gap-1 p-6">
              <p className="text-sm text-muted">{stat.label}</p>
              <p className="text-3xl font-semibold tabular-nums">{stat.value}</p>
            </Card.Content>
          </Card>
        ))}
      </div>

      <Card>
        <Card.Content className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted">
              <Loader2 aria-hidden size={20} className="mr-2 animate-spin" />
              載入中…
            </div>
          ) : machines.length === 0 ? (
            <p className="py-12 text-center text-muted">清單中還沒有機器。</p>
          ) : (
            <NoSsr>
            <Table.Root>
              <Table.ScrollContainer>
                <Table.Content aria-label="機器清單">
                  <Table.Header>
                    <Table.Column isRowHeader>名稱</Table.Column>
                    <Table.Column>地區</Table.Column>
                    <Table.Column>AWS 帳號</Table.Column>
                    <Table.Column>狀態</Table.Column>
                    <Table.Column>公網 IP</Table.Column>
                    <Table.Column>DNS</Table.Column>
                    <Table.Column>操作</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {machines.map(machine => (
                      <Table.Row id={String(machine.id)} key={machine.id}>
                        <Table.Cell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{machine.name}</span>
                            {machine.isWavelength ? (
                              <Chip variant="secondary" size="sm">WL</Chip>
                            ) : null}
                          </div>
                          <div className="font-mono text-xs text-muted">{machine.instanceId}</div>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono text-xs">{machine.region}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-xs">{machine.awsAccountName || "未關聯"}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip variant={stateBadgeVariant(machine.state)} size="sm">
                            {stateLabel(machine.state)}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          {machine.publicIpAddress ? (
                            <button
                              type="button"
                              title="點擊複製"
                              className="font-mono text-xs underline-offset-4 hover:underline"
                              onClick={() => copyText(machine.publicIpAddress!)}
                            >
                              {machine.publicIpAddress}
                            </button>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {machine.publicDnsName ? (
                            <button
                              type="button"
                              title="點擊複製"
                              className="block max-w-56 truncate font-mono text-xs underline-offset-4 hover:underline"
                              onClick={() => copyText(machine.publicDnsName!)}
                            >
                              {machine.publicDnsName}
                            </button>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              aria-label="重新整理狀態"
                              isDisabled={refreshing || actionPendingId !== null}
                              onPress={refresh}
                            >
                              <RefreshCw aria-hidden size={16} />
                            </Button>
                            {machine.state !== "running" ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                isDisabled={actionPendingId === machine.id}
                                onPress={() => requestPowerAction(machine, "start")}
                              >
                                啟動
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  isDisabled={actionPendingId === machine.id}
                                  onPress={() => requestReboot(machine)}
                                >
                                  重啟
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  isDisabled={actionPendingId === machine.id}
                                  onPress={() => requestRebootIp(machine)}
                                >
                                  更換 IP
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  isDisabled={actionPendingId === machine.id}
                                  onPress={() => requestPowerAction(machine, "stop")}
                                >
                                  關閉
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              isDisabled={actionPendingId === machine.id}
                              onPress={() => {
                                setRemoveTarget(machine);
                                setRemoveOpen(true);
                              }}
                            >
                              移除
                            </Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table.Root>
            </NoSsr>
          )}
        </Card.Content>
      </Card>

      {/* 新增機器 */}
      <Modal.Root isOpen={addOpen} onOpenChange={setAddOpen}>
        <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>新增機器</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm text-muted">
                從 AWS 帳號選擇既有 EC2 執行個體加入管理清單（儲存於 D1）
              </p>
              <div className="grid gap-4 py-2">
                <div className="grid gap-2">
                  <label htmlFor="add-account" className="text-sm font-medium">AWS 帳號</label>
                  <select
                    id="add-account"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    disabled={loadingAccounts || adding}
                    value={addForm.awsAccountId ?? ""}
                    onChange={event => {
                      const accountId = event.target.value ? Number(event.target.value) : null;
                      setAddForm(previous => ({ ...previous, awsAccountId: accountId }));
                      void loadAddRegions(accountId);
                    }}
                  >
                    <option value="" disabled>
                      {loadingAccounts ? "載入中..." : (accounts.length ? "請選擇 AWS 帳號" : "尚無可用帳號，請先至帳號管理新增")}
                    </option>
                    {accounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {account.name}{account.isDefault ? "（預設）" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="add-region" className="text-sm font-medium">地區</label>
                  <select
                    id="add-region"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    disabled={!addForm.awsAccountId || loadingRegions || adding}
                    value={addForm.region}
                    onChange={event => {
                      const region = event.target.value;
                      setAddForm(previous => ({ ...previous, region }));
                      void loadAddInstances(region, addForm.awsAccountId);
                    }}
                  >
                    <option value="">{loadingRegions ? "載入中..." : "請選擇地區"}</option>
                    {regions.map(region => (
                      <option key={region} value={region}>{regionLabel(region)}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="add-instance" className="text-sm font-medium">執行個體</label>
                  <select
                    id="add-instance"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    disabled={!addForm.region || loadingInstances || adding}
                    value={addForm.instanceId}
                    onChange={event => selectInstance(event.target.value)}
                  >
                    <option value="">
                      {loadingInstances ? "載入中..." : (instances.length ? "請選擇執行個體" : "此地區沒有執行個體")}
                    </option>
                    {instances.map(instance => (
                      <option key={instance.instanceId} value={instance.instanceId}>
                        {instance.name || instance.instanceId}（{instance.instanceId}，{stateLabel(instance.state)}）
                      </option>
                    ))}
                  </select>
                  {addForm.isWavelength ? (
                    <p className="text-xs text-muted">偵測為 Wavelength 執行個體，加入後將標記 WL。</p>
                  ) : null}
                </div>
                <div className="grid gap-2">
                  <label htmlFor="add-name" className="text-sm font-medium">顯示名稱</label>
                  <Input
                    id="add-name"
                    placeholder="SEA-1"
                    disabled={adding}
                    value={addForm.name}
                    onChange={event => setAddForm(previous => ({ ...previous, name: event.target.value }))}
                  />
                </div>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" isDisabled={adding} onPress={() => setAddOpen(false)}>
                取消
              </Button>
              <Button
                isDisabled={adding || !addForm.awsAccountId || !addForm.region || !addForm.instanceId || !addForm.name}
                onPress={submitAdd}
              >
                {adding ? <Loader2 aria-hidden size={16} className="animate-spin" /> : null}
                新增
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* 確認關閉 */}
      <Modal.Root isOpen={stopOpen} onOpenChange={setStopOpen}>
        <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>確認關閉機器</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              確定要關閉「{stopTarget?.name}」嗎？此操作將停止 AWS 上的 EC2 執行個體。
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setStopOpen(false)}>取消</Button>
              <Button onPress={confirmStop}>關閉</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
      {/* 確認重啟 */}
      <Modal.Root isOpen={rebootOpen} onOpenChange={setRebootOpen}>
        <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>確認重啟機器</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              確定要重啟「{rebootTarget?.name}」嗎？此操作將中斷 SSH 連線並重新啟動 AWS EC2 執行個體。
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setRebootOpen(false)}>取消</Button>
              <Button onPress={confirmReboot}>重啟</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* 確認更換 IP（停止→啟動） */}
      <Modal.Root isOpen={rebootIpOpen} onOpenChange={setRebootIpOpen}>
        <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>確認更換公網 IP</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              確定要更換「{rebootIpTarget?.name}」的公網 IP 嗎？此操作將：<br />
              • 暫時關閉執行個體（中斷 SSH 連線）<br />
              • 自動啟動執行個體<br />
              • 分配新的公網 IP/DNS
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setRebootIpOpen(false)}>取消</Button>
              <Button onPress={confirmRebootIp}>更換 IP</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* 確認移除 */}
      <Modal.Root isOpen={removeOpen} onOpenChange={setRemoveOpen}>
        <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>確認移除機器</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              將「{removeTarget?.name}」從管理清單移除？這只會移除清單記錄，不會終止 AWS 上的執行個體。
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" isDisabled={removing} onPress={() => setRemoveOpen(false)}>取消</Button>
              <Button variant="danger" isDisabled={removing} onPress={submitRemove}>
                {removing ? <Loader2 aria-hidden size={16} className="animate-spin" /> : null}
                移除
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </div>
  );
}
