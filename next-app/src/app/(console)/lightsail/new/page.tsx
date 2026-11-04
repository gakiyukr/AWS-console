'use client'

// Lightsail 部署：以「帳號 → Region → Blueprint → Bundle → 登入憑證」表單
// 建立 Lightsail 執行個體，部署流程以 SSE 即時回報進度，結果含連線資訊可複製／下載。
import { useEffect, useState } from "react";
import Link from "next/link";
import { Clipboard, Download, Loader2, RefreshCw, Zap, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { readJson, toastDanger } from "@/lib/api-client";
import { regionLabel } from "@/lib/regions";
import { readDeploymentStream } from "@/lib/deployment-stream";
import { sshKeyTypeLabel, type SshPublicKeyOption } from "@/lib/ssh-keys";

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
  });
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingBlueprints, setLoadingBlueprints] = useState(false);
  const [loadingBundles, setLoadingBundles] = useState(false);
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

  async function loadRegions(accountId: number | null) {
    setRegions([]);
    setForm(previous => ({ ...previous, region: "", blueprintId: "", bundleId: "" }));
    if (!accountId) return;
    try {
      const response = await fetch(`/api/lightsail/regions?account_id=${accountId}`);
      if (!response.ok) throw new Error("載入 Lightsail Region 失敗");
      const payload = await readJson<{ regions?: string[] }>(response);
      setRegions(payload.regions || []);
    } catch {
      toastDanger("載入 Lightsail Region 失敗");
    }
  }

  async function loadBlueprints(accountId: number | null, region: string) {
    setBlueprints([]);
    setForm(previous => ({ ...previous, blueprintId: "" }));
    if (!accountId || !region) return;
    setLoadingBlueprints(true);
    try {
      const response = await fetch(
        `/api/lightsail/blueprints?account_id=${accountId}&region=${region}`,
      );
      if (!response.ok) throw new Error("載入 Blueprint 失敗");
      const payload = await readJson<{ blueprints?: BlueprintOption[] }>(response);
      setBlueprints(payload.blueprints || []);
    } catch {
      toastDanger("載入 Blueprint 失敗");
    } finally {
      setLoadingBlueprints(false);
    }
  }

  async function loadBundles(accountId: number | null, region: string) {
    setBundles([]);
    setForm(previous => ({ ...previous, bundleId: "" }));
    if (!accountId || !region) return;
    setLoadingBundles(true);
    try {
      const response = await fetch(
        `/api/lightsail/bundles?account_id=${accountId}&region=${region}`,
      );
      if (!response.ok) throw new Error("載入 Bundle 失敗");
      const payload = await readJson<{ bundles?: BundleOption[] }>(response);
      setBundles(payload.bundles || []);
    } catch {
      toastDanger("載入 Bundle 失敗");
    } finally {
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

  function reloadOptions() {
    void loadInitialOptions();
    void loadSshKeys();
  }

  const selectClassName = "h-9 rounded-md border bg-background px-3 text-sm";

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
            <select
              className={selectClassName}
              value={form.accountId ?? ""}
              onChange={async (e) => {
                const accountId = Number(e.target.value) || null;
                setForm(previous => ({ ...previous, accountId, region: "", blueprintId: "", bundleId: "" }));
                if (accountId) await loadRegions(accountId);
              }}
              disabled={loadingInitial || busy}
            >
              <option value="">請選擇帳號</option>
              {accounts.map(account => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Region</label>
            <select
              className={selectClassName}
              value={form.region}
              onChange={async (e) => {
                const region = e.target.value;
                setForm(previous => ({ ...previous, region, blueprintId: "", bundleId: "" }));
                if (region && form.accountId) {
                  await Promise.all([
                    loadBlueprints(form.accountId, region),
                    loadBundles(form.accountId, region),
                  ]);
                }
              }}
              disabled={!form.accountId || busy}
            >
              <option value="">請選擇 Region</option>
              {regions.map(region => (
                <option key={region} value={region}>
                  {regionLabel(region)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">作業系統映像（Blueprint）</label>
            <select
              className={selectClassName}
              value={form.blueprintId}
              onChange={(e) => setForm(previous => ({ ...previous, blueprintId: e.target.value }))}
              disabled={!form.region || loadingBlueprints || busy}
            >
              <option value="">請選擇 Blueprint</option>
              {blueprints.map(bp => (
                <option key={bp.blueprintId} value={bp.blueprintId}>
                  {bp.name} ({bp.platform})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">規格方案（Bundle）</label>
            <select
              className={selectClassName}
              value={form.bundleId}
              onChange={(e) => setForm(previous => ({ ...previous, bundleId: e.target.value }))}
              disabled={!form.region || loadingBundles || busy}
            >
              <option value="">請選擇 Bundle</option>
              {bundles.map(bundle => (
                <option key={bundle.bundleId} value={bundle.bundleId}>
                  {bundle.name} - ${bundle.price}/月 ({bundle.cpuCount} vCPU, {bundle.ramSizeInGb} GB RAM)
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium">執行個體名稱</label>
            <input
              type="text"
              className={selectClassName}
              placeholder="my-lightsail-instance"
              value={form.instanceName}
              onChange={(e) => setForm(previous => ({ ...previous, instanceName: e.target.value }))}
              disabled={busy}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium">登入憑證類型</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.credentialType === "ssh_key"}
                  onChange={() => setForm(previous => ({ ...previous, credentialType: "ssh_key" }))}
                  disabled={busy}
                />
                <span>SSH 公鑰</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.credentialType === "password"}
                  onChange={() => setForm(previous => ({ ...previous, credentialType: "password" }))}
                  disabled={busy}
                />
                <span>密碼</span>
              </label>
            </div>
          </div>

          {form.credentialType === "ssh_key" && (
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium">SSH 公鑰</label>
              <select
                className={selectClassName}
                value={form.sshKeyId ?? ""}
                onChange={(e) => setForm(previous => ({ ...previous, sshKeyId: Number(e.target.value) || null }))}
                disabled={loadingKeys || busy}
              >
                <option value="">請選擇公鑰</option>
                {sshKeys.map(key => (
                  <option key={key.id} value={key.id}>
                    {key.label} ({sshKeyTypeLabel(key.publicKey)})
                  </option>
                ))}
              </select>
            </div>
          )}

          {form.credentialType === "password" && (
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium">Root 密碼</label>
              <input
                type="password"
                className={selectClassName}
                placeholder="至少 8 字元"
                value={form.rootPassword}
                onChange={(e) => setForm(previous => ({ ...previous, rootPassword: e.target.value }))}
                disabled={busy}
              />
            </div>
          )}
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
