'use client'

// EC2 機器總覽：D1 清單 × DescribeInstances 即時狀態。電源操作與移除
// 先經確認對話框；新增機器以「帳號 → Region → 執行個體」三層下拉由
// 後端即時列出候選，或直接前往「新增 EC2」部署一台新機。
import Link from "next/link";
import { useState } from "react";
import { Loader2, Plus, RefreshCw, Server } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Modal } from "@heroui/react/modal";
import { ConfirmDialog, MachineName } from "@/components/confirm-dialog";
import { MachineTable } from "@/components/machine-table";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { useMachines } from "@/lib/use-machines";

interface AwsAccountOption {
  id: number
  name: string
  enabled: boolean
  isDefault: boolean
}

interface InstanceOption {
  instanceId: string
  name: string
  state: string
  isWavelength: boolean
}

const EMPTY_ADD_FORM = {
  awsAccountId: null as number | null,
  region: "",
  instanceId: "",
  name: "",
  isWavelength: false,
};

export default function Ec2OverviewPage() {
  const { machines, loading, refreshing, actionPendingId, busyPending, refresh, actions, dialogs } =
    useMachines("ec2");

  // ── 新增機器（從既有 AWS 執行個體挑選） ────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
  const [adding, setAdding] = useState(false);
  const [accounts, setAccounts] = useState<AwsAccountOption[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingInstances, setLoadingInstances] = useState(false);

  const stats = {
    running: machines.filter(machine => machine.state === "running").length,
    stopped: machines.filter(machine => machine.state === "stopped").length,
    wavelength: machines.filter(machine => machine.isWavelength).length,
    regions: new Set(machines.map(machine => machine.region)).size,
  };

  async function openAddDialog() {
    setAddForm(EMPTY_ADD_FORM);
    setRegions([]);
    setInstances([]);
    setAddOpen(true);
    try {
      const response = await fetch("/api/accounts");
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ accounts?: AwsAccountOption[] }>(response);
      const enabled = (payload.accounts || []).filter(account => account.enabled);
      setAccounts(enabled);
      const preferred = enabled.find(account => account.isDefault) || enabled[0];
      if (preferred) {
        setAddForm(previous => ({ ...previous, awsAccountId: preferred.id }));
        await loadRegions(preferred.id);
      }
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入帳號失敗");
    }
  }

  async function loadRegions(accountId: number) {
    setLoadingRegions(true);
    try {
      const response = await fetch(`/api/ec2/regions?account_id=${accountId}`);
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ regions?: string[] }>(response);
      setRegions(payload.regions || []);
    } catch {
      toastDanger("載入地區失敗");
    } finally {
      setLoadingRegions(false);
    }
  }

  async function loadInstances(accountId: number, region: string) {
    if (!region) return;
    setLoadingInstances(true);
    try {
      const response = await fetch(
        `/api/ec2/instances?account_id=${accountId}&region=${encodeURIComponent(region)}`,
      );
      if (!response.ok) throw new Error(await readError(response));
      setInstances(await readJson<InstanceOption[]>(response));
    } catch {
      toastDanger("載入執行個體失敗");
    } finally {
      setLoadingInstances(false);
    }
  }

  async function submitAdd() {
    setAdding(true);
    try {
      const response = await fetch("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...addForm, platform: "ec2" }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("機器已新增");
      setAddOpen(false);
      await refresh();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "新增失敗");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">EC2</h2>
          <p className="text-sm text-muted">管理 EC2 執行個體的電源狀態與網路設定</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onPress={openAddDialog}>
            <Plus aria-hidden size={16} />
            加入既有機器
          </Button>
          <Link
            href="/ec2/new"
            className="inline-flex h-8 items-center gap-2 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-[var(--accent-foreground)] transition-opacity hover:opacity-90"
          >
            <Server aria-hidden size={16} />
            新增 EC2
          </Link>
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
          <MachineTable
            machines={machines}
            loading={loading}
            refreshing={refreshing}
            actionPendingId={actionPendingId}
            busyPending={busyPending}
            platform="ec2"
            emptyText="清單中還沒有 EC2 機器。"
            onRefresh={refresh}
            actions={actions}
          />
        </Card.Content>
      </Card>

      {/* 加入既有機器 */}
      <Modal.Root isOpen={addOpen} onOpenChange={setAddOpen}>
        <Modal.Backdrop>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>加入既有 EC2 機器</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="grid gap-4">
                <div className="grid gap-2">
                  <label htmlFor="add-account" className="text-sm font-medium">AWS 帳號</label>
                  <select
                    id="add-account"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={addForm.awsAccountId ?? ""}
                    onChange={event => {
                      const accountId = Number(event.target.value);
                      setAddForm({ ...EMPTY_ADD_FORM, awsAccountId: accountId });
                      setInstances([]);
                      void loadRegions(accountId);
                    }}
                  >
                    {accounts.map(account => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="add-region" className="text-sm font-medium">地區</label>
                  <select
                    id="add-region"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={addForm.region}
                    disabled={loadingRegions}
                    onChange={event => {
                      const region = event.target.value;
                      setAddForm(previous => ({ ...previous, region, instanceId: "" }));
                      if (addForm.awsAccountId) void loadInstances(addForm.awsAccountId, region);
                    }}
                  >
                    <option value="">請選擇地區</option>
                    {regions.map(region => (
                      <option key={region} value={region}>{region}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="add-instance" className="text-sm font-medium">執行個體</label>
                  <select
                    id="add-instance"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={addForm.instanceId}
                    disabled={loadingInstances || instances.length === 0}
                    onChange={event => {
                      const selected = instances.find(item => item.instanceId === event.target.value);
                      setAddForm(previous => ({
                        ...previous,
                        instanceId: event.target.value,
                        name: selected?.name || event.target.value,
                        isWavelength: Boolean(selected?.isWavelength),
                      }));
                    }}
                  >
                    <option value="">{loadingInstances ? "載入中…" : "請選擇執行個體"}</option>
                    {instances.map(instance => (
                      <option key={instance.instanceId} value={instance.instanceId}>
                        {instance.name || instance.instanceId}（{instance.state}）
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="add-name" className="text-sm font-medium">顯示名稱</label>
                  <Input
                    id="add-name"
                    value={addForm.name}
                    onChange={event => setAddForm(previous => ({ ...previous, name: event.target.value }))}
                  />
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setAddOpen(false)}>取消</Button>
                <Button
                  isDisabled={adding || !addForm.awsAccountId || !addForm.region || !addForm.instanceId || !addForm.name}
                  onPress={submitAdd}
                >
                  {adding ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                  加入
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* 確認對話框 */}
      <ConfirmDialog
        open={dialogs.stop.open}
        onOpenChange={dialogs.stop.setOpen}
        title="確認關閉機器"
        confirmLabel="關閉"
        onConfirm={dialogs.stop.confirm}
      >
        確定要關閉 <MachineName machine={dialogs.stop.target} /> 嗎？關機後 SSH 連線會中斷。
      </ConfirmDialog>

      <ConfirmDialog
        open={dialogs.reboot.open}
        onOpenChange={dialogs.reboot.setOpen}
        title="確認重啟機器"
        confirmLabel="重啟"
        onConfirm={dialogs.reboot.confirm}
      >
        確定要重啟 <MachineName machine={dialogs.reboot.target} /> 嗎？重啟不會更換公網 IP。
      </ConfirmDialog>

      <ConfirmDialog
        open={dialogs.terminate.open}
        onOpenChange={dialogs.terminate.setOpen}
        title="確認終止執行個體"
        confirmLabel="終止"
        danger
        onConfirm={dialogs.terminate.confirm}
      >
        確定要終止 <MachineName machine={dialogs.terminate.target} /> 嗎？執行個體將被永久刪除，此操作無法復原。
      </ConfirmDialog>

      <ConfirmDialog
        open={dialogs.rebootIp.open}
        onOpenChange={dialogs.rebootIp.setOpen}
        title="確認更換公網 IP"
        confirmLabel="更換 IP"
        pending={dialogs.rebootIp.pending}
        onConfirm={dialogs.rebootIp.confirm}
      >
        確定要更換 <MachineName machine={dialogs.rebootIp.target} /> 的公網 IP 嗎？此操作將：
        <br />
        • 暫時關閉執行個體（中斷 SSH 連線）
        <br />
        • 自動啟動執行個體
        <br />
        • 分配新的公網 IP／DNS
      </ConfirmDialog>

      <ConfirmDialog
        open={dialogs.ipv6.open}
        onOpenChange={dialogs.ipv6.setOpen}
        title="確認開通 IPv6"
        confirmLabel="開通 IPv6"
        pending={dialogs.ipv6.pending}
        onConfirm={dialogs.ipv6.confirm}
      >
        確定要為 <MachineName machine={dialogs.ipv6.target} /> 開通 IPv6 嗎？此操作將：
        <br />
        • 為 VPC／子網關聯 IPv6 CIDR（若尚未具備）
        <br />
        • 加入 Internet Gateway 的 <code>::/0</code> 路由與安全群組規則
        <br />
        • 指派 IPv6 位址並<strong>重新開機一次</strong>（約 1 分鐘，不會更換 IPv4 公網 IP）
      </ConfirmDialog>

      <ConfirmDialog
        open={dialogs.remove.open}
        onOpenChange={dialogs.remove.setOpen}
        title="移除機器"
        confirmLabel="移除"
        danger
        pending={dialogs.remove.pending}
        onConfirm={dialogs.remove.confirm}
      >
        確定要將 <MachineName machine={dialogs.remove.target} /> 從清單移除嗎？只會移除清單記錄，AWS 上的執行個體不受影響。
      </ConfirmDialog>
    </div>
  );
}
