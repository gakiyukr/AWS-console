'use client'

// 首頁：多雲主控台總覽儀表板（Cloud Console Dashboard）
// 整合 AWS (EC2 / Lightsail) 與 Oracle Cloud (OCI) 運算資源、帳號健康度與最新操作日誌。
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
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

interface Machine {
  id: number
  platform?: "ec2" | "lightsail"
  isWavelength?: boolean
  state?: string
}

interface OciInstance {
  id: string
  lifecycleState: string
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
    // 1. AWS 機器資料
    try {
      const res = await fetch("/api/machines");
      if (res.ok) {
        const data = await readJson<{ machines?: Machine[] }>(res);
        const machines = data.machines || [];
        const ec2s = machines.filter(m => (m.platform || "ec2") === "ec2");
        const ls = machines.filter(m => m.platform === "lightsail");

        setEc2Count(ec2s.length);
        setEc2Running(ec2s.filter(m => m.state === "running").length);
        setEc2Stopped(ec2s.filter(m => m.state === "stopped").length);
        setWavelengthCount(ec2s.filter(m => m.isWavelength).length);

        setLightsailCount(ls.length);
        setLightsailRunning(ls.filter(m => m.state === "running").length);
      }
    } catch {
      // 忽略單項載入錯誤
    }

    // 2. OCI 執行個體資料
    try {
      const res = await fetch("/api/instances");
      if (res.ok) {
        const data = await readJson<{ instances?: OciInstance[] }>(res);
        const instances = data.instances || [];
        setOciCount(instances.length);
        setOciRunning(instances.filter(i => i.lifecycleState === "RUNNING").length);
        setOciError(null);
      } else {
        const errorData = await res.json().catch(() => ({ error: "" })) as { error?: string };
        setOciError(errorData?.error || "尚未設定可用的 OCI 帳號");
      }
    } catch {
      setOciError("無法載入 OCI 資料");
    }

    // 3. OCI 保留 IP
    try {
      const res = await fetch("/api/reserved-ips");
      if (res.ok) {
        const data = await readJson<{ reservedIps?: ReservedIp[] }>(res);
        setReservedIpCount((data.reservedIps || []).length);
      }
    } catch {
      // 忽略單項載入錯誤
    }

    // 4. 帳號統計
    try {
      const [awsRes, ociRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/oci-accounts"),
      ]);
      if (awsRes.ok) {
        const data = await readJson<{ accounts?: unknown[] }>(awsRes);
        setAwsAccountCount((data.accounts || []).length);
      }
      if (ociRes.ok) {
        const data = await readJson<{ accounts?: unknown[] }>(ociRes);
        setOciAccountCount((data.accounts || []).length);
      }
    } catch {
      // 忽略
    }

    // 5. 最新操作日誌
    try {
      const res = await fetch("/api/logs?limit=5");
      if (res.ok) {
        const data = await readJson<{ logs?: LogEntry[] }>(res);
        setRecentLogs(data.logs || []);
      }
    } catch {
      // 忽略
    }
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
