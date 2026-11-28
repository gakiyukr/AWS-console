'use client'

// EC2 機器總覽：D1 清單 × DescribeInstances 即時狀態。
// 電源操作先經確認對話框；新增機器一律走「新增 EC2」部署流程。
import Link from "next/link";
import { Loader2, RefreshCw, Server } from "lucide-react";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { ConfirmDialog, MachineName } from "@/components/confirm-dialog";
import { MachineTable } from "@/components/machine-table";
import { useMachines } from "@/lib/use-machines";

export default function Ec2OverviewPage() {
  const { machines, loading, refreshing, actionPendingId, busyPending, refresh, actions, dialogs } =
    useMachines("ec2");

  const stats = {
    running: machines.filter(machine => machine.state === "running").length,
    stopped: machines.filter(machine => machine.state === "stopped").length,
    wavelength: machines.filter(machine => machine.isWavelength).length,
    regions: new Set(machines.map(machine => machine.region)).size,
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">EC2</h2>
          <p className="text-sm text-muted">管理 EC2 執行個體的電源狀態與網路設定</p>
        </div>
        <div className="flex items-center gap-2">
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
        {!dialogs.rebootIp.target?.isWavelength ? (
          <div className="mt-3 flex items-center gap-2">
            <input
              id="reboot-ip-include-ipv6"
              type="checkbox"
              className="h-4 w-4"
              checked={dialogs.rebootIp.includeIpv6}
              onChange={event => dialogs.rebootIp.setIncludeIpv6(event.target.checked)}
            />
            <label htmlFor="reboot-ip-include-ipv6" className="text-sm">同時更換 IPv6 位址</label>
          </div>
        ) : null}
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


    </div>
  );
}
