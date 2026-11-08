'use client'

// Lightsail 部署：以「帳號 → Region → Blueprint → Bundle → 登入憑證」表單
// 建立 Lightsail 執行個體，部署流程以 SSE 即時回報進度，結果含連線資訊可複製／下載。
import { useEffect, useState } from "react";
import Link from "next/link";
import { Clipboard, Download, Loader2, RefreshCw, Zap, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { regionLabel } from "@/lib/regions";
import { readDeploymentStream } from "@/lib/deployment-stream";
import { sshKeyTypeLabel, type SshPublicKeyOption } from "@/lib/ssh-keys";
import { CustomSelect } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AwsAccountOption {
  id: number
  name: string
  enabled: boolean
  isDefault: boolean
}

interface BlueprintOption {
  blueprintId: string
  name: string
  description: string
  platform: string
  group: string
}

interface BundleOption {
  bundleId: string
  name: string
  price: number
  cpuCount: number
  ramSizeInGb: number
  diskSizeInGb: number
  transferPerMonthInGb: number
}

interface ProgressEntry {
  time: string
  message: string
  details?: Record<string, unknown>
}

const STAGE_LABELS: Record<string, string> = {
  validating: "開始驗證部署輸入",
  launching_instance: "正在建立 Lightsail 執行個體",
  instance_launched: "執行個體已建立",
  waiting_for_running: "等待執行個體進入 running",
  instance_running: "執行個體已進入 running",
  allocating_static_ip: "正在分配靜態 IP",
  static_ip_attached: "靜態 IP 已附加",
  static_ip_skipped: "跳過靜態 IP 分配",
  firewall_configured: "防火牆規則已設定",
  firewall_skipped: "跳過防火牆設定",
};

export default function LightsailPage() {
  const [accounts, setAccounts] = useState<AwsAccountOption[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [blueprints, setBlueprints] = useState<BlueprintOption[]>([]);
  const [bundles, setBundles] = useState<BundleOption[]>([]);
  const [sshKeys, setSshKeys] = useState<SshPublicKeyOption[]>([]);
  const [form, setForm] = useState({
    accountId: null as number | null,
    region: "",
    blueprintId: "",
    bundleId: "",
    instanceName: "",
    credentialType: "ssh_key" as "ssh_key" | "password",
    sshKeyId: null as number | null,
    rootPassword: "",
    ipv6: false,
  });
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingBlueprints, setLoadingBlueprints] = useState(false);
  const [loadingBundles, setLoadingBundles] = useState(false);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);

  const resultText = result ? JSON.stringify(result, null, 2) : "";

  function appendProgress(message: string, details?: Record<string, unknown>) {
    setProgress(previous => [
      ...previous,
      {
        time: new Date().toLocaleTimeString("zh-TW"),
        message,
        ...(details ? { details } : {}),
      },
    ]);
  }

  async function loadSshKeys() {
    setLoadingKeys(true);
    try {
      const response = await fetch("/api/ssh-keys");
      if (!response.ok) throw new Error("載入 SSH 公鑰失敗");
      const payload = await readJson<{ keys?: SshPublicKeyOption[] }>(response);
      const keys: SshPublicKeyOption[] = payload.keys || [];
      setSshKeys(keys);
      setForm(previous => ({
        ...previous,
        sshKeyId: previous.sshKeyId && keys.some(key => key.id === previous.sshKeyId)
          ? previous.sshKeyId
          : keys[0]?.id ?? null,
      }));
    } catch {
      toastDanger("載入 SSH 公鑰失敗");
    } finally {
      setLoadingKeys(false);
    }
  }

  async function loadRegions(accountId: number | null, forceRefresh = false) {
    setRegions([]);
    setRegionError(null);
    setForm(previous => ({ ...previous, region: "", blueprintId: "", bundleId: "" }));
    if (!accountId) return;
    try {
      // 讀帳號的區域快取（建立帳號時建立）；forceRefresh 或快取為空會自動抓 live 並回填
      const url = `/api/accounts/${accountId}/regions/cache?platform=lightsail${forceRefresh ? "&refresh=1" : ""}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ regions?: string[]; cached?: boolean }>(response);
      setRegions(payload.regions || []);
      if (payload.cached === false && !forceRefresh) {
        toast.success("首次讀取：已從 AWS 抓取並快取此帳號的區域清單");
      } else if (forceRefresh) {
        toast.success("已重新整理並更新可用區域清單");
      }
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 Lightsail Region 失敗");
    }
  }

  async function loadRegionOptions(accountId: number | null, region: string) {
    setBlueprints([]);
    setBundles([]);
    setRegionError(null);
    setForm(previous => ({ ...previous, blueprintId: "", bundleId: "" }));
    if (!accountId || !region) return;

    setLoadingBlueprints(true);
    setLoadingBundles(true);

    try {
      const [bpRes, bundleRes] = await Promise.all([
        fetch(`/api/lightsail/blueprints?account_id=${accountId}&region=${region}`),
        fetch(`/api/lightsail/bundles?account_id=${accountId}&region=${region}`),
      ]);

      if (!bpRes.ok || !bundleRes.ok) {
        const errorMsg = !bpRes.ok ? await readError(bpRes) : await readError(bundleRes);
        setRegionError(errorMsg);
        toastDanger(errorMsg);
        return;
      }

      const [bpData, bundleData] = await Promise.all([
        readJson<{ blueprints?: BlueprintOption[] }>(bpRes),
        readJson<{ bundles?: BundleOption[] }>(bundleRes),
      ]);

      setBlueprints(bpData.blueprints || []);
      setBundles(bundleData.bundles || []);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "載入區域選項失敗";
      setRegionError(msg);
      toastDanger(msg);
    } finally {
      setLoadingBlueprints(false);
      setLoadingBundles(false);
    }
  }

  async function loadInitialOptions() {
    setLoadingInitial(true);
    try {
      const response = await fetch("/api/accounts");
      if (!response.ok) throw new Error("載入 AWS 帳號失敗");
      const payload = await readJson<{ accounts: AwsAccountOption[] }>(response);
      const enabled = payload.accounts.filter(account => account.enabled);
      const firstAccount = enabled.find(account => account.isDefault) || enabled[0];
      setAccounts(enabled);
      const activeAccount = form.accountId && enabled.some(account => account.id === form.accountId)
        ? enabled.find(account => account.id === form.accountId) ?? null
        : firstAccount;
      setForm(previous => ({
        ...previous,
        accountId: activeAccount?.id ?? null,
      }));
      if (activeAccount) await loadRegions(activeAccount.id);
    } catch {
      toastDanger("載入初始選項失敗");
    } finally {
      setLoadingInitial(false);
    }
  }

  useEffect(() => {
    // 首次掛載載入帳號、Region 選項與公鑰；載入函式各自管理 loading 狀態與錯誤提示
    async function init() {
      await Promise.all([loadInitialOptions(), loadSshKeys()]);
    }
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeploy() {
    if (!form.accountId || !form.region || !form.blueprintId || !form.bundleId || !form.instanceName) {
      toastDanger("請填寫所有必填欄位。");
      return;
    }

    if (form.credentialType === "ssh_key" && !form.sshKeyId) {
      toastDanger("請選擇 SSH 公鑰。");
      return;
    }

    if (form.credentialType === "password" && form.rootPassword.length < 8) {
      toastDanger("密碼長度至少 8 字元。");
      return;
    }

    setBusy(true);
    setResult(null);
    setProgress([]);
    appendProgress("開始 Lightsail 部署");

    const body = {
      account_id: form.accountId,
      region: form.region,
      blueprint_id: form.blueprintId,
      bundle_id: form.bundleId,
      instance_name: form.instanceName,
      ipv6: form.ipv6,
      credential_type: form.credentialType,
      ...(form.credentialType === "ssh_key"
        ? { ssh_key_id: form.sshKeyId }
        : { root_password: form.rootPassword }),
    };

    try {
      const response = await fetch("/api/lightsail/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const deployResult = await readDeploymentStream(response, {
        onProgress: appendProgress,
        stageLabels: STAGE_LABELS,
      });

      setResult(deployResult);
      appendProgress("Lightsail 部署流程完成", deployResult);
      toast.success("Lightsail 執行個體部署成功！");
    } catch (error) {
      const message = error instanceof Error ? error.message : "部署失敗";
      appendProgress(message);
      toastDanger(message);
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    if (!resultText) return;
    await navigator.clipboard.writeText(resultText);
    toast.success("部署結果已複製");
  }

  function downloadResult() {
    if (!resultText) return;
    const blob = new Blob([resultText], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lightsail-${form.instanceName}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function resetForm() {
    setResult(null);
    setProgress([]);
    setForm(previous => ({ ...previous, instanceName: "" }));
  }

  async function reloadOptions() {
    void loadSshKeys();
    await loadInitialOptions();
    if (form.accountId) {
      await loadRegions(form.accountId, true);
    }
  }



  return (
    <div className="space-y-6">
      <div>
        <Link href="/lightsail" className="text-xs text-muted underline-offset-4 hover:underline">
          ← 返回 Lightsail
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <Zap className="size-8 text-warning" />
          <h1 className="text-2xl font-semibold">新增 Lightsail</h1>
        </div>
      </div>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">部署設定</h2>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={loadingInitial || busy}
            onPress={reloadOptions}
          >
            {loadingInitial ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <RefreshCw aria-hidden size={16} />}
            重新載入
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">AWS 帳號</label>
            <CustomSelect
              value={form.accountId}
              placeholder="請選擇帳號"
              options={accounts.map(account => ({
                value: String(account.id),
                label: account.name,
              }))}
              onChange={async (val) => {
                const accountId = Number(val) || null;
                setForm(previous => ({ ...previous, accountId, region: "", blueprintId: "", bundleId: "" }));
                if (accountId) await loadRegions(accountId);
              }}
              disabled={loadingInitial || busy}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium">Region</label>
              {form.accountId ? (
                <button
                  type="button"
                  onClick={() => form.accountId && void loadRegions(form.accountId, true)}
                  className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-colors"
                  title="從 AWS 重新抓取此帳號已開通的區域清單"
                >
                  <RefreshCw size={12} />
                  <span>重新整理區域</span>
                </button>
              ) : null}
            </div>
            <CustomSelect
              value={form.region}
              placeholder="請選擇 Region"
              options={regions.map(region => ({
                value: region,
                label: regionLabel(region),
              }))}
              onChange={async (region) => {
                setForm(previous => ({ ...previous, region, blueprintId: "", bundleId: "" }));
                if (region && form.accountId) {
                  await loadRegionOptions(form.accountId, region);
                }
              }}
              disabled={!form.accountId || busy}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">作業系統映像（Blueprint）</label>
            <CustomSelect
              value={form.blueprintId}
              placeholder={loadingBlueprints ? "載入中..." : "請選擇 Blueprint"}
              options={blueprints.map(bp => ({
                value: bp.blueprintId,
                label: bp.name,
              }))}
              onChange={(val) => setForm(previous => ({ ...previous, blueprintId: val }))}
              disabled={!form.region || loadingBlueprints || busy}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">規格方案（Bundle）</label>
            <CustomSelect
              value={form.bundleId}
              placeholder={loadingBundles ? "載入中..." : "請選擇 Bundle"}
              options={bundles.map(bundle => ({
                value: bundle.bundleId,
                label: `${bundle.name} - $${bundle.price}/月 (${bundle.cpuCount} vCPU, ${bundle.ramSizeInGb} GB RAM)`,
              }))}
              onChange={(val) => setForm(previous => ({ ...previous, bundleId: val }))}
              disabled={!form.region || loadingBundles || busy}
            />
          </div>

          {regionError && (
            <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger sm:col-span-2">
              <p className="font-medium">⚠️ {regionError}</p>
              <p className="mt-1 text-danger/80">
                若尚未開通該區域，請至 <Link href="/accounts" className="underline font-semibold hover:text-danger">帳號管理</Link> 開通該區域，開通後點擊上方「重新整理區域」。
              </p>
            </div>
          )}

          <div className="sm:col-span-2">
            <Label htmlFor="lightsail-name" className="mb-1.5 block text-sm font-medium">執行個體名稱</Label>
            <Input
              id="lightsail-name"
              type="text"
              placeholder="my-lightsail-instance"
              value={form.instanceName}
              onChange={(e) => setForm(previous => ({ ...previous, instanceName: e.target.value }))}
              disabled={busy}
            />
          </div>

          {/* IPv6 選項 */}
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={form.ipv6}
                disabled={busy}
                onChange={(e) => setForm(previous => ({ ...previous, ipv6: e.target.checked }))}
              />
              啟用 IPv6（雙棧：IPv4 + IPv6；位址由 Lightsail 自動指派）
            </label>
          </div>

          {/* 登入憑證：公鑰取自 D1 公鑰庫，密碼僅存在於本次請求 */}
          <div className="grid grid-cols-1 gap-4 rounded-md border border-divider p-4 sm:col-span-2 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <label htmlFor="lightsail-credential-type" className="text-sm font-medium">登入憑證</label>
              <CustomSelect
                id="lightsail-credential-type"
                value={form.credentialType}
                disabled={busy}
                options={[
                  { value: "ssh_key", label: "SSH 公鑰" },
                  { value: "password", label: "自訂密碼" },
                ]}
                onChange={val => setForm(previous => ({
                  ...previous,
                  credentialType: val as "ssh_key" | "password",
                }))}
              />
              <p className="text-xs text-muted">
                公鑰登入會停用 root 密碼認證；自訂密碼不會被儲存，部署後請自行妥善保管。
              </p>
            </div>
            {form.credentialType === "ssh_key" ? (
              <div className="grid content-start gap-2">
                <label htmlFor="lightsail-ssh-key" className="text-sm font-medium">SSH 公鑰</label>
                <CustomSelect
                  id="lightsail-ssh-key"
                  value={form.sshKeyId}
                  placeholder={loadingKeys ? "載入中..." : "請選擇公鑰"}
                  options={sshKeys.map(key => ({
                    value: key.id,
                    label: `${key.label} (${sshKeyTypeLabel(key.publicKey)})`,
                  }))}
                  onChange={val => setForm(previous => ({
                    ...previous,
                    sshKeyId: typeof val === "number" ? val : null,
                  }))}
                  disabled={loadingKeys || busy}
                />
                <p className="text-xs text-muted">
                  公鑰由伺服器注入系統授權清單。無可用公鑰？至帳號管理建立。
                </p>
              </div>
            ) : (
              <div className="grid content-start gap-2">
                <Label htmlFor="lightsail-root-pwd" className="text-sm font-medium">自訂 root 密碼</Label>
                <Input
                  id="lightsail-root-pwd"
                  type="password"
                  value={form.rootPassword}
                  onChange={event => setForm(previous => ({ ...previous, rootPassword: event.target.value }))}
                  placeholder="至少 8 字元"
                  disabled={busy}
                />
                <p className="text-xs text-muted">
                  此密碼僅用於本次初始化，伺服器不保存。
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Button
            variant="primary"
            onPress={handleDeploy}
            isDisabled={busy || !form.accountId || !form.region || !form.blueprintId || !form.bundleId || !form.instanceName}
          >
            {busy ? (
              <>
                <Loader2 aria-hidden size={16} className="animate-spin" />
                部署中...
              </>
            ) : (
              <>
                <Zap aria-hidden size={16} />
                開始部署
              </>
            )}
          </Button>
          {result && (
            <Button variant="ghost" onPress={resetForm}>
              <Trash2 className="size-4" />
              清除結果
            </Button>
          )}
        </div>
      </Card>

      {progress.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-4 text-lg font-medium">部署進度</h2>
          <div className="space-y-2 rounded-lg bg-surface p-4 font-mono text-sm">
            {progress.map((entry, index) => (
              <div key={index} className="flex gap-2">
                <span className="text-muted">[{entry.time}]</span>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {result && (
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium">部署結果</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onPress={copyResult}>
                <Clipboard className="size-4" />
                複製
              </Button>
              <Button size="sm" variant="ghost" onPress={downloadResult}>
                <Download className="size-4" />
                下載
              </Button>
            </div>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-surface p-4 text-sm">
            {resultText}
          </pre>
        </Card>
      )}
    </div>
  );
}
