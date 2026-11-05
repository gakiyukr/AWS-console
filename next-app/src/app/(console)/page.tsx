'use client'

// 首頁：多雲主控台總覽儀表板（Cloud Console Dashboard）
// 整合 AWS (EC2 / Lightsail) 與 Oracle Cloud (OCI) 運算資源、帳號健康度與最新操作日誌。
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  Cpu,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  XCircle,
  Zap,
} from "lucide-react";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@/components/chip";
import { readJson } from "@/lib/api-client";
import { copyToClipboard, stateBadgeVariant, stateLabel } from "@/lib/machine-display";

interface Machine {
  id: number
  region?: string
  instanceId?: string
  name?: string
  platform?: "ec2" | "lightsail" | string
  isWavelength?: boolean
  state?: string | null
  publicIpAddress?: string | null
  publicDnsName?: string | null
  ipv6Address?: string | null
  awsAccountName?: string | null
}

interface OciInstance {
  id: string
  displayName?: string
  alias?: string | null
  notes?: string | null
  lifecycleState: string
  shape?: string
  publicIp?: string | null
  ipv6Address?: string | null
}

interface ReservedIp {
  id: string
}

interface LogEntry {
  id: number
  createdAt: string
  action: string
  status: string
  instanceId?: string | null
  displayName?: string | null
  region?: string | null
  detail?: string | null
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // 機器列表明細
  const [machines, setMachines] = useState<Machine[]>([]);
  const [ociInstances, setOciInstances] = useState<OciInstance[]>([]);

  // AWS 統計
  const [ec2Count, setEc2Count] = useState(0);
  const [ec2Running, setEc2Running] = useState(0);
  const [ec2Stopped, setEc2Stopped] = useState(0);
  const [wavelengthCount, setWavelengthCount] = useState(0);
  const [lightsailCount, setLightsailCount] = useState(0);
  const [lightsailRunning, setLightsailRunning] = useState(0);

  // OCI 統計
  const [ociCount, setOciCount] = useState(0);
  const [ociRunning, setOciRunning] = useState(0);
  const [reservedIpCount, setReservedIpCount] = useState(0);
  const [ociError, setOciError] = useState<string | null>(null);

  // 帳號與日誌
  const [awsAccountCount, setAwsAccountCount] = useState(0);
  const [ociAccountCount, setOciAccountCount] = useState(0);
  const [recentLogs, setRecentLogs] = useState<LogEntry[]>([]);

  async function loadDashboardData() {
    await Promise.allSettled([
      // 1. AWS 機器資料 (EC2 / Lightsail)
      (async () => {
        try {
          const res = await fetch("/api/machines");
          if (res.ok) {
            const raw = await readJson<Machine[] | { machines?: Machine[] }>(res);
            const list = Array.isArray(raw) ? raw : (raw?.machines || []);
            setMachines(list);

            const ec2s = list.filter(m => (m.platform || "ec2") === "ec2");
            const ls = list.filter(m => m.platform === "lightsail");

            setEc2Count(ec2s.length);
            setEc2Running(ec2s.filter(m => m.state === "running").length);
            setEc2Stopped(ec2s.filter(m => m.state === "stopped").length);
            setWavelengthCount(ec2s.filter(m => Boolean(m.isWavelength)).length);

            setLightsailCount(ls.length);
            setLightsailRunning(ls.filter(m => m.state === "running").length);
          }
        } catch (e) {
          console.error("載入 AWS 機器失敗", e);
        }
      })(),

      // 2. OCI 執行個體資料
      (async () => {
        try {
          const res = await fetch("/api/instances");
          if (res.ok) {
            const data = await readJson<{ instances?: OciInstance[] } | OciInstance[]>(res);
            const list = Array.isArray(data) ? data : (data?.instances || []);
            setOciInstances(list);
            setOciCount(list.length);
            setOciRunning(list.filter(i => i.lifecycleState === "RUNNING").length);
            setOciError(null);
          } else {
            const errorData = await res.json().catch(() => ({ error: "" })) as { error?: string };
            setOciError(errorData?.error || "尚未設定可用的 OCI 帳號");
          }
        } catch {
          setOciError("無法載入 OCI 資料");
        }
      })(),

      // 3. OCI 保留 IP
      (async () => {
        try {
          const res = await fetch("/api/reserved-ips");
          if (res.ok) {
            const data = await readJson<{ reservedIps?: ReservedIp[] } | ReservedIp[]>(res);
            const ips = Array.isArray(data) ? data : (data?.reservedIps || []);
            setReservedIpCount(ips.length);
          }
        } catch {
          // 忽略單項載入錯誤
        }
      })(),

      // 4. 帳號統計
      (async () => {
        try {
          const [awsRes, ociRes] = await Promise.all([
            fetch("/api/accounts"),
            fetch("/api/oci-accounts"),
          ]);
          if (awsRes.ok) {
            const data = await readJson<{ accounts?: unknown[] } | unknown[]>(awsRes);
            const accs = Array.isArray(data) ? data : (data?.accounts || []);
            setAwsAccountCount(accs.length);
          }
          if (ociRes.ok) {
            const data = await readJson<{ accounts?: unknown[] } | unknown[]>(ociRes);
            const accs = Array.isArray(data) ? data : (data?.accounts || []);
            setOciAccountCount(accs.length);
          }
        } catch {
          // 忽略
        }
      })(),

      // 5. 最新操作日誌
      (async () => {
        try {
          const res = await fetch("/api/logs?limit=5");
          if (res.ok) {
            const data = await readJson<{ logs?: LogEntry[] } | LogEntry[]>(res);
            const logs = Array.isArray(data) ? data : (data?.logs || []);
            setRecentLogs(logs);
          }
        } catch {
          // 忽略
        }
      })(),
    ]);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadDashboardData();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
  }

  const allActiveMachines = [
    ...machines.map(m => ({
      key: `aws-${m.id}`,
      cloud: (m.platform === "lightsail" ? "AWS Lightsail" : "AWS EC2") as string,
      cloudColor: m.platform === "lightsail" ? "text-blue-500" : "text-amber-500",
      id: m.instanceId || `machine-${m.id}`,
      name: m.name || m.instanceId,
      region: m.region || "—",
      ip: m.publicIpAddress || "—",
      isWl: Boolean(m.isWavelength),
      state: m.state || "未知",
      variant: stateBadgeVariant(m.state || null),
      label: stateLabel(m.state || null),
      link: m.platform === "lightsail" ? "/lightsail" : "/ec2",
    })),
    ...ociInstances.map(i => ({
      key: `oci-${i.id}`,
      cloud: "Oracle Cloud",
      cloudColor: "text-red-500",
      id: i.id,
      name: i.displayName || i.alias || i.id,
      region: i.shape || "OCI 運算",
      ip: i.publicIp || "—",
      isWl: false,
      state: i.lifecycleState,
      variant: (i.lifecycleState === "RUNNING" ? "primary" : "secondary") as "primary" | "secondary" | "soft",
      label: i.lifecycleState === "RUNNING" ? "執行中" : i.lifecycleState,
      link: "/instances",
    })),
  ];

  return (
    <div className="flex w-full flex-col gap-8">
      {/* 標題與更新按鈕 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">多雲主控台總覽</h2>
          <p className="text-sm text-muted">
            跨 AWS 與 Oracle Cloud (OCI) 基礎設施統一管理、資源監控與快捷部署
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={loading || refreshing}
          onPress={handleRefresh}
        >
          <RefreshCw
            aria-hidden="true"
            size={16}
            className={`mr-1.5 ${refreshing ? "animate-spin" : ""}`}
          />
          重新整理
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted">
          <Loader2 aria-hidden="true" size={24} className="mr-2 animate-spin" />
          載入多雲資源概況...
        </div>
      ) : (
        <>
          {/* 核心卡片列表 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* AWS EC2 卡片 */}
            <Card>
              <Card.Content className="flex flex-col justify-between gap-4 p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Server aria-hidden="true" size={18} className="text-amber-500" />
                      AWS EC2
                    </span>
                    <Chip variant="soft" size="sm">{ec2Count} 台機器</Chip>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-surface p-2 border border-divider">
                      <p className="text-xs text-muted">運行中</p>
                      <p className="text-lg font-bold text-emerald-500">{ec2Running}</p>
                    </div>
                    <div className="rounded-lg bg-surface p-2 border border-divider">
                      <p className="text-xs text-muted">已停止</p>
                      <p className="text-lg font-bold text-muted">{ec2Stopped}</p>
                    </div>
                    <div className="rounded-lg bg-surface p-2 border border-divider">
                      <p className="text-xs text-muted">Wavelength</p>
                      <p className="text-lg font-bold text-blue-500">{wavelengthCount}</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-divider pt-3">
                  <Link
                    href="/ec2/new"
                    className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
                  >
                    <Plus size={14} /> 新增機器
                  </Link>
                  <Link
                    href="/ec2"
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:bg-default transition-colors"
                  >
                    前往管理 <ArrowRight size={14} />
                  </Link>
                </div>
              </Card.Content>
            </Card>

            {/* AWS Lightsail 卡片 */}
            <Card>
              <Card.Content className="flex flex-col justify-between gap-4 p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Zap aria-hidden="true" size={18} className="text-blue-500" />
                      AWS Lightsail
                    </span>
                    <Chip variant="soft" size="sm">{lightsailCount} 台實例</Chip>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-lg bg-surface p-2 border border-divider">
                      <p className="text-xs text-muted">運行中</p>
                      <p className="text-lg font-bold text-emerald-500">{lightsailRunning}</p>
                    </div>
                    <div className="rounded-lg bg-surface p-2 border border-divider">
                      <p className="text-xs text-muted">實例總計</p>
                      <p className="text-lg font-bold">{lightsailCount}</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-divider pt-3">
                  <Link
                    href="/lightsail/new"
                    className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
                  >
                    <Plus size={14} /> 新增實例
                  </Link>
                  <Link
                    href="/lightsail"
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:bg-default transition-colors"
                  >
                    前往管理 <ArrowRight size={14} />
                  </Link>
                </div>
              </Card.Content>
            </Card>

            {/* Oracle Cloud (OCI) 卡片 */}
            <Card>
              <Card.Content className="flex flex-col justify-between gap-4 p-6">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Cpu aria-hidden="true" size={18} className="text-red-500" />
                      Oracle Cloud (OCI)
                    </span>
                    <Chip variant="soft" size="sm">{ociCount} 台執行個體</Chip>
                  </div>
                  {ociError ? (
                    <div className="mt-4 rounded-lg bg-surface p-3 text-center text-xs text-muted border border-divider">
                      {ociError}（請先至帳號管理配置）
                    </div>
                  ) : (
                    <div className="mt-4 grid grid-cols-2 gap-2 text-center">
                      <div className="rounded-lg bg-surface p-2 border border-divider">
                        <p className="text-xs text-muted">執行中</p>
                        <p className="text-lg font-bold text-emerald-500">{ociRunning}</p>
                      </div>
                      <div className="rounded-lg bg-surface p-2 border border-divider">
                        <p className="text-xs text-muted">保留公網 IP</p>
                        <p className="text-lg font-bold text-indigo-500">{reservedIpCount}</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between border-t border-divider pt-3">
                  <Link
                    href="/instances/new"
                    className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
                  >
                    <Plus size={14} /> 建立執行個體
                  </Link>
                  <Link
                    href="/instances"
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:bg-default transition-colors"
                  >
                    前往管理 <ArrowRight size={14} />
                  </Link>
                </div>
              </Card.Content>
            </Card>
          </div>

          {/* 快速執行個體總覽 */}
          {allActiveMachines.length > 0 && (
            <Card>
              <Card.Content className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base font-semibold">受管執行個體快速清單</h3>
                    <p className="text-xs text-muted">跨雲平台已納管與運行中的運算資源</p>
                  </div>
                  <Chip variant="soft" size="sm">{allActiveMachines.length} 台資源</Chip>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-divider text-muted">
                        <th className="py-2.5 pr-4 font-medium">平台</th>
                        <th className="py-2.5 pr-4 font-medium">執行個體名稱 / ID</th>
                        <th className="py-2.5 pr-4 font-medium">地區 / 規格</th>
                        <th className="py-2.5 pr-4 font-medium">公網 IP</th>
                        <th className="py-2.5 pr-4 font-medium">狀態</th>
                        <th className="py-2.5 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-divider">
                      {allActiveMachines.map(m => (
                        <tr key={m.key} className="hover:bg-default/40 transition-colors">
                          <td className="py-3 pr-4 font-medium">
                            <span className={m.cloudColor}>{m.cloud}</span>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-1.5 font-medium text-foreground">
                              <span>{m.name}</span>
                              {m.isWl && (
                                <Chip variant="secondary" size="sm">WL</Chip>
                              )}
                            </div>
                            <div className="font-mono text-[11px] text-muted truncate max-w-[200px]">
                              {m.id}
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-muted">{m.region}</td>
                          <td className="py-3 pr-4">
                            {m.ip && m.ip !== "—" ? (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(m.ip)}
                                className="group flex items-center gap-1 font-mono text-foreground hover:text-accent transition-colors"
                                title="點擊複製 IP"
                              >
                                <span>{m.ip}</span>
                                <Copy size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                              </button>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <Chip variant={m.variant} size="sm">
                              {m.label}
                            </Chip>
                          </td>
                          <td className="py-3 text-right">
                            <Link
                              href={m.link}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-foreground hover:bg-default transition-colors"
                            >
                              管理 <ArrowRight size={12} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card.Content>
            </Card>
          )}

          {/* 次要資訊與快捷入口 */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* 帳號與安全概況 */}
            <Card className="lg:col-span-1">
              <Card.Content className="flex flex-col justify-between gap-4 p-6">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <KeyRound aria-hidden="true" size={18} />
                    多雲憑證庫
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    AES-256-GCM 加密保護，各雲金鑰獨立隔離儲存
                  </p>

                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between rounded-lg border border-divider p-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-amber-500" />
                        <span className="text-sm font-medium">AWS 憑證帳號</span>
                      </div>
                      <span className="font-semibold">{awsAccountCount} 個</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-divider p-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-red-500" />
                        <span className="text-sm font-medium">OCI 簽章帳號</span>
                      </div>
                      <span className="font-semibold">{ociAccountCount} 個</span>
                    </div>
                  </div>
                </div>

                <Link
                  href="/accounts"
                  className="flex items-center justify-center gap-1 rounded-lg bg-default py-2 text-xs font-medium text-foreground hover:bg-default/80 transition-colors w-full"
                >
                  管理多雲憑證 <ArrowRight size={14} />
                </Link>
              </Card.Content>
            </Card>

            {/* 近期操作動態 */}
            <Card className="lg:col-span-2">
              <Card.Content className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <ScrollText aria-hidden="true" size={18} />
                    近期操作動態
                  </div>
                  <Link
                    href="/logs"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:text-foreground transition-colors"
                  >
                    完整日誌 <ArrowRight size={12} />
                  </Link>
                </div>

                {recentLogs.length === 0 ? (
                  <div className="py-10 text-center text-xs text-muted">
                    目前尚無操作紀錄
                  </div>
                ) : (
                  <div className="mt-4 divide-y divide-divider overflow-hidden rounded-lg border border-divider">
                    {recentLogs.map(log => {
                      const isSuccess = log.status === "success" || log.status === "ok";
                      return (
                        <div
                          key={log.id}
                          className="flex items-center justify-between gap-4 p-3 text-xs hover:bg-default/40 transition-colors"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {isSuccess ? (
                              <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
                            ) : (
                              <XCircle size={16} className="shrink-0 text-rose-500" />
                            )}
                            <div className="truncate">
                              <span className="font-medium text-foreground">
                                {log.action}
                              </span>
                              <span className="ml-2 text-muted truncate">
                                {log.displayName || log.instanceId || log.region || "—"}
                              </span>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <span className="text-muted">
                              {new Date(log.createdAt).toLocaleTimeString("zh-TW", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            <Chip variant={isSuccess ? "secondary" : "default"} size="sm">
                              {log.status}
                            </Chip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card.Content>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
