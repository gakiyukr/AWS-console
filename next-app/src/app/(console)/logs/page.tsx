'use client'

// 操作日誌：檢視電源操作、Wavelength 初始化與部署的稽核記錄，
// 支援帳號／操作／結果／筆數篩選，可下載 JSON。
import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Table } from "@/components/table-lazy";
import { NoSsr } from "@/components/no-ssr";
import { toastDanger } from "@/lib/api-client";

interface OperationLog {
  id: number
  createdAt: string
  action: string
  region: string | null
  instanceId: string | null
  status: "success" | "failure"
  detail: string | null
  awsAccountId: number | null
}

interface AwsAccountOption {
  id: number
  name: string
}

const ACTION_LABELS: Record<string, string> = {
  start: "啟動執行個體",
  stop: "停止執行個體",
  reboot: "重啟執行個體",
  terminate: "終止執行個體",
  "reboot-ip": "更換公網 IP",
  machine_remove: "自清單移除機器",
  init_zone: "初始化 WL Zone",
  deploy_wavelength: "部署 Wavelength EC2",
  deploy_regional: "部署一般 EC2",
  deploy_forwarder: "部署 SSH forwarder",
  enable_region: "開通 Region",
};


// D1 datetime('now') 為 UTC 且無時區標記，補成 ISO 格式再轉本地時間；
// 直接 new Date() 會把「YYYY-MM-DD HH:MM:SS」當本地時間（UTC+8 少 8 小時），
// Safari 更會解析失敗顯示 Invalid Date。
function formatCreatedAt(value: string) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW");
}

// detail 多為 JSON 字串，能解析就美化顯示
function displayDetail(detail: string | null) {
  if (!detail) return "—";
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

export default function LogsPage() {
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [accounts, setAccounts] = useState<AwsAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ accountId: "", action: "", status: "", limit: 200 });

  async function loadLogs() {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: String(filters.limit) });
      if (filters.action) query.set("action", filters.action);
      if (filters.status) query.set("status", filters.status);
      if (filters.accountId) query.set("account_id", filters.accountId);
      const response = await fetch(`/api/logs?${query.toString()}`);
      if (!response.ok) throw new Error("載入操作日誌失敗");
      const payload = await response.json();
      setLogs(payload.logs || []);
    } catch {
      toastDanger("載入操作日誌失敗");
    } finally {
      setLoading(false);
    }
  }

  function downloadLogs() {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aws-console-operation-logs-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const response = await fetch("/api/accounts");
        if (!response.ok) throw new Error();
        const payload = await response.json();
        if (!cancelled) setAccounts(payload.accounts);
      } catch {
        toastDanger("載入 AWS 帳號失敗");
      }
      await loadLogs();
      if (cancelled) return;
    }
    void init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectClassName = "h-9 rounded-md border bg-background px-3 text-sm";

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">操作日誌</h2>
          <p className="text-sm text-muted">查看電源操作、Wavelength 初始化與部署稽核記錄</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" isDisabled={loading || logs.length === 0} onPress={downloadLogs}>
            <Download aria-hidden size={16} />
            下載 JSON
          </Button>
          <Button size="sm" isDisabled={loading} onPress={loadLogs}>
            {loading ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <RefreshCw aria-hidden size={16} />}
            重新整理
          </Button>
        </div>
      </div>

      <Card>
        <Card.Content className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_140px_auto] lg:items-end">
          <div className="grid gap-2">
            <label htmlFor="log-account" className="text-sm font-medium">AWS 帳號</label>
            <select
              id="log-account"
              className={selectClassName}
              value={filters.accountId}
              onChange={event => setFilters(previous => ({ ...previous, accountId: event.target.value }))}
            >
              <option value="">全部帳號</option>
              {accounts.map(account => (
                <option key={account.id} value={String(account.id)}>{account.name}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <label htmlFor="log-action" className="text-sm font-medium">操作</label>
            <select
              id="log-action"
              className={selectClassName}
              value={filters.action}
              onChange={event => setFilters(previous => ({ ...previous, action: event.target.value }))}
            >
              <option value="">全部操作</option>
              {Object.entries(ACTION_LABELS).map(([action, label]) => (
                <option key={action} value={action}>{label}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <label htmlFor="log-status" className="text-sm font-medium">結果</label>
            <select
              id="log-status"
              className={selectClassName}
              value={filters.status}
              onChange={event => setFilters(previous => ({ ...previous, status: event.target.value }))}
            >
              <option value="">全部結果</option>
              <option value="success">成功</option>
              <option value="failure">失敗</option>
            </select>
          </div>
          <div className="grid gap-2">
            <label htmlFor="log-limit" className="text-sm font-medium">筆數</label>
            <select
              id="log-limit"
              className={selectClassName}
              value={filters.limit}
              onChange={event => setFilters(previous => ({ ...previous, limit: Number(event.target.value) }))}
            >
              {[50, 200, 500, 1000].map(limit => (
                <option key={limit} value={limit}>{limit}</option>
              ))}
            </select>
          </div>
          <Button variant="secondary" isDisabled={loading} onPress={loadLogs}>
            套用篩選
          </Button>
        </Card.Content>
      </Card>

      <Card>
        <Card.Content className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted">
              <Loader2 aria-hidden size={20} className="mr-2 animate-spin" />
              載入中...
            </div>
          ) : logs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted">沒有符合條件的操作日誌</div>
          ) : (
            <div className="overflow-x-auto">
              <NoSsr>
              <Table.Root>
                <Table.ScrollContainer>
                  <Table.Content aria-label="操作日誌">
                    <Table.Header>
                      <Table.Column isRowHeader>時間</Table.Column>
                      <Table.Column>操作</Table.Column>
                      <Table.Column>AWS 帳號</Table.Column>
                      <Table.Column>地區／執行個體</Table.Column>
                      <Table.Column>結果</Table.Column>
                      <Table.Column>詳細資料</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {logs.map(entry => (
                        <Table.Row id={String(entry.id)} key={entry.id}>
                          <Table.Cell>
                            <span className="whitespace-nowrap text-xs">
                              {formatCreatedAt(entry.createdAt)}
                            </span>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="font-medium">{ACTION_LABELS[entry.action] || entry.action}</div>
                            <div className="font-mono text-xs text-muted">{entry.action}</div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="text-xs">{entry.awsAccountId ? `#${entry.awsAccountId}` : "—"}</div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="font-mono text-xs">{entry.region || "—"}</div>
                            <div className="font-mono text-xs text-muted">{entry.instanceId || "—"}</div>
                          </Table.Cell>
                          <Table.Cell>
                            <Chip variant={entry.status === "success" ? "primary" : "soft"} size="sm">
                              {entry.status === "success" ? "成功" : "失敗"}
                            </Chip>
                          </Table.Cell>
                          <Table.Cell>
                            <pre className="max-h-48 max-w-2xl overflow-auto whitespace-pre-wrap break-all text-xs">
                              {displayDetail(entry.detail)}
                            </pre>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table.Root>
              </NoSsr>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
