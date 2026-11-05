'use client'

// 機器表格：EC2 與 Lightsail 總覽共用。差異只在平台相關的動作——
// Lightsail 沒有「更換公網 IP」（stop→start 不換 IP），也沒有 Wavelength。
// 電源操作、IPv6、終止、移除的確認流程由頁面持有（各平台頁面需要自己的
// 對話框文案），本元件只負責呈現與觸發回呼。
import { Loader2, RefreshCw } from "lucide-react";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Table } from "@/components/table-lazy";
import { NoSsr } from "@/components/no-ssr";
import { copyToClipboard, stateBadgeVariant, stateLabel } from "@/lib/machine-display";

export interface MachineRow {
  id: number
  region: string
  instanceId: string
  name: string
  platform: string
  isWavelength: boolean
  state: string | null
  publicIpAddress: string | null
  publicDnsName: string | null
  ipv6Address: string | null
  ddnsHostname: string | null
  awsAccountId: number | null
  awsAccountName: string | null
}

export interface MachineTableActions {
  onStart: (machine: MachineRow) => void
  onStop: (machine: MachineRow) => void
  onReboot: (machine: MachineRow) => void
  onRebootIp: (machine: MachineRow) => void
  onIpv6: (machine: MachineRow) => void
  onDdns: (machine: MachineRow) => void
  onTerminate: (machine: MachineRow) => void
  onRemove: (machine: MachineRow) => void
}

interface MachineTableProps {
  machines: MachineRow[]
  loading: boolean
  refreshing: boolean
  actionPendingId: number | null
  /** 是否有長時間操作進行中（換 IP／IPv6），暫停其他列的動作 */
  busyPending: boolean
  /** 平台：決定顯示哪些動作（lightsail 不顯示「更換 IP」） */
  platform: "ec2" | "lightsail"
  emptyText: string
  onRefresh: () => void
  actions: MachineTableActions
}

/** 可點擊複製的等寬文字；空值顯示破折號。 */
function CopyableCell({ value, maxWidthClass = "" }: { value: string | null; maxWidthClass?: string }) {
  if (!value) {
    return <span className="text-muted">—</span>;
  }
  return (
    <div className={`min-w-0 ${maxWidthClass}`}>
      <button
        type="button"
        title={`${value}（點擊複製）`}
        className="line-clamp-1 w-full text-left font-mono text-xs underline-offset-4 hover:underline"
        onClick={() => copyToClipboard(value)}
      >
        {value}
      </button>
    </div>
  );
}

export function MachineTable({
  machines,
  loading,
  refreshing,
  actionPendingId,
  busyPending,
  platform,
  emptyText,
  onRefresh,
  actions,
}: MachineTableProps) {
  const showRebootIp = platform === "ec2";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted">
        <Loader2 aria-hidden size={20} className="mr-2 animate-spin" />
        載入中…
      </div>
    );
  }
  if (machines.length === 0) {
    return <p className="py-12 text-center text-muted">{emptyText}</p>;
  }

  return (
    <NoSsr>
      <Table.Root>
        <Table.ScrollContainer>
          {/* table-fixed + 每欄固定寬度：避免 auto layout 在窄螢幕把名稱、
              地區、狀態壓成折行，也避免寬螢幕把留白拉散。總寬小於容器時
              由 ScrollContainer 橫向捲動。 */}
          <Table.Content aria-label="機器清單" className="min-w-[1780px] table-fixed">
            <Table.Header>
              <Table.Column isRowHeader className="w-[300px]">名稱</Table.Column>
              <Table.Column className="w-[130px]">地區</Table.Column>
              <Table.Column className="w-[160px]">AWS 帳號</Table.Column>
              <Table.Column className="w-[100px]">狀態</Table.Column>
              <Table.Column className="w-[130px]">公網 IP</Table.Column>
              <Table.Column className="w-[190px]">IPv6</Table.Column>
              <Table.Column className="w-[250px]">DNS</Table.Column>
              <Table.Column className="w-[510px]">操作</Table.Column>
            </Table.Header>
            <Table.Body>
              {machines.map(machine => (
                <Table.Row id={String(machine.id)} key={machine.id}>
                  <Table.Cell>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono font-medium" title={machine.instanceId}>
                        {machine.instanceId}
                      </span>
                      {machine.isWavelength ? (
                        <Chip variant="secondary" size="sm">WL</Chip>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted" title={machine.name || undefined}>
                      {machine.name || "—"}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="whitespace-nowrap font-mono text-xs">{machine.region}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <span
                      className="block max-w-full truncate text-xs"
                      title={machine.awsAccountName || "未關聯"}
                    >
                      {machine.awsAccountName || "未關聯"}
                    </span>
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
                        className="whitespace-nowrap font-mono text-xs underline-offset-4 hover:underline"
                        onClick={() => copyToClipboard(machine.publicIpAddress!)}
                      >
                        {machine.publicIpAddress}
                      </button>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="overflow-hidden">
                    <CopyableCell value={machine.ipv6Address} />
                  </Table.Cell>
                  <Table.Cell className="overflow-hidden">
                    <CopyableCell value={machine.publicDnsName} />
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                      <Button
                        variant="ghost"
                        aria-label="重新整理狀態"
                        isDisabled={refreshing || actionPendingId !== null}
                        onPress={onRefresh}
                      >
                        <RefreshCw aria-hidden size={16} />
                      </Button>
                      {machine.state !== "running" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          isDisabled={actionPendingId === machine.id}
                          onPress={() => actions.onStart(machine)}
                        >
                          啟動
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            isDisabled={actionPendingId === machine.id}
                            onPress={() => actions.onReboot(machine)}
                          >
                            重啟
                          </Button>
                          {showRebootIp ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              isDisabled={actionPendingId !== null || busyPending}
                              onPress={() => actions.onRebootIp(machine)}
                            >
                              更換 IP
                            </Button>
                          ) : null}
                          {!machine.isWavelength ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              isDisabled={actionPendingId !== null || busyPending}
                              onPress={() => actions.onIpv6(machine)}
                            >
                              IPv6
                            </Button>
                          ) : null}
                          <Button
                            variant="secondary"
                            size="sm"
                            isDisabled={actionPendingId === machine.id}
                            onPress={() => actions.onStop(machine)}
                          >
                            關閉
                          </Button>
                        </>
                      )}
                      {platform === "ec2" && !machine.isWavelength ? (
                        <Button
                          variant={machine.ddnsHostname ? "primary" : "secondary"}
                          size="sm"
                          isDisabled={actionPendingId === machine.id}
                          onPress={() => actions.onDdns(machine)}
                        >
                          DDNS
                        </Button>
                      ) : null}
                      <Button
                        variant="danger"
                        size="sm"
                        isDisabled={actionPendingId === machine.id}
                        onPress={() => actions.onTerminate(machine)}
                      >
                        終止
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        isDisabled={actionPendingId === machine.id}
                        onPress={() => actions.onRemove(machine)}
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
  );
}
