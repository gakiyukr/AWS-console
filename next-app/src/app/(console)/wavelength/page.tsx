'use client'

// Wavelength 部署：初始化 Zone 託管資源、部署 Wavelength EC2（可選
// 同建 SSH forwarder），或為既有 WL 執行個體部署區域型 forwarder。
// 部署流程以 SSE 即時回報進度，結果可複製／下載。
import { useEffect, useRef, useState } from "react";
import { Check, Clipboard, Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { regionLabel } from "@/lib/regions";
import { readDeploymentStream } from "@/lib/deployment-stream";
import { sshKeyTypeLabel, type SshPublicKeyOption } from "@/lib/ssh-keys";

interface SelectOption {
  value: string
  label: string
}

interface AwsAccountOption {
  id: number
  name: string
  enabled: boolean
  isDefault: boolean
}

interface ExistingInstance {
  instance_id: string
  state: string
  instance_type: string
  private_ip: string
  private_dns_name: string
  public_dns_name: string
  subnet_id: string
  vpc_id: string
  availability_zone: string
}

interface ProgressEntry {
  time: string
  message: string
  details?: Record<string, unknown>
}

const STAGE_LABELS: Record<string, string> = {
  validating: "開始驗證部署輸入",
  validating_existing_forwarder: "驗證既有 WL forwarder 輸入",
  credentials_ready: "登入憑證已套用",
  zone_ready: "Wavelength Zone 已就緒",
  resources_ready: "網路資源已就緒",
  instance_launched: "執行個體已啟動",
  waiting_for_running: "等待執行個體進入 running",
  instance_running: "執行個體已進入 running",
  waiting_for_public_dns: "等待公網 DNS",
  public_dns_ready: "公網 DNS 已就緒",
  waiting_for_status_checks: "等待狀態檢查",
  status_check_progress: "狀態檢查進度",
  status_checks_passed: "狀態檢查已通過",
  waiting_for_cloud_init: "等待 cloud-init 完成",
  cloud_init_complete: "cloud-init 已完成",
  preparing_forwarder: "準備區域型 SSH forwarder",
  forwarder_launched: "SSH forwarder 已啟動",
  waiting_for_forwarder_running: "等待 forwarder 進入 running",
  forwarder_running: "forwarder 已進入 running",
  waiting_for_forwarder_public_dns: "等待 forwarder 公網 DNS",
  forwarder_public_dns_ready: "forwarder 公網 DNS 已就緒",
  waiting_for_forwarder_status_checks: "等待 forwarder 狀態檢查",
  forwarder_status_checks_passed: "forwarder 狀態檢查已通過",
  waiting_for_forwarder_cloud_init: "等待 forwarder cloud-init 完成",
  forwarder_cloud_init_complete: "forwarder cloud-init 已完成",
};

function toastDanger(message: string) {
  toast(message, { variant: "danger" });
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.error === "string" ? body.error : "操作失敗";
  } catch {
    return "操作失敗";
  }
}

const EMPTY_FORM = {
  accountId: null as number | null,
  region: "",
  zone: "",
  vpcId: "",
  instanceType: "",
  os: "",
  enableForwarder: false,
  useExistingInstance: false,
  existingInstanceId: "",
  credentialType: "ssh_key" as "ssh_key" | "password",
  sshKeyId: null as number | null,
  rootPassword: "",
};

export default function WavelengthPage() {
  const [accounts, setAccounts] = useState<AwsAccountOption[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [vpcs, setVpcs] = useState<SelectOption[]>([]);
  const [instanceTypes, setInstanceTypes] = useState<string[]>([]);
  const [osOptions, setOsOptions] = useState<SelectOption[]>([]);
  const [existingInstances, setExistingInstances] = useState<ExistingInstance[]>([]);
  const [sshKeys, setSshKeys] = useState<SshPublicKeyOption[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);

  const [loadingKeys, setLoadingKeys] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingRegion, setLoadingRegion] = useState(false);
  const [loadingTypes, setLoadingTypes] = useState(false);
  // 快速切換 Zone 會併發多個機型查詢，以序號讓過期回應作廢
  const instanceTypesRequestId = useRef(0);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);

  function updateForm(patch: Partial<typeof EMPTY_FORM>) {
    setForm(previous => ({ ...previous, ...patch }));
  }

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
      const payload = await response.json();
      const keys: SshPublicKeyOption[] = payload.keys || [];
      setSshKeys(keys);
      updateForm({
        sshKeyId: form.sshKeyId && keys.some(key => key.id === form.sshKeyId)
          ? form.sshKeyId
          : keys[0]?.id ?? null,
      });
    } catch {
      toastDanger("載入 SSH 公鑰失敗");
    } finally {
      setLoadingKeys(false);
    }
  }

  async function loadRegions(accountId: number | null) {
    setRegions([]);
    updateForm({ region: "", zone: "", vpcId: "", instanceType: "", existingInstanceId: "" });
    if (!accountId) return;
    try {
      const response = await fetch(`/api/wavelength/regions?account_id=${accountId}`);
      if (!response.ok) throw new Error("載入 Wavelength Region 失敗");
      const payload = await response.json();
      setRegions(payload.regions || []);
    } catch {
      toastDanger("載入 Wavelength Region 失敗");
    }
  }

  async function loadInitialOptions() {
    setLoadingInitial(true);
    try {
      const [accountResponse, osResponse] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/wavelength/os-options"),
      ]);
      if (!accountResponse.ok) throw new Error("載入 AWS 帳號失敗");
      const accountPayload = await accountResponse.json();
      const enabled: AwsAccountOption[] = accountPayload.accounts.filter(
        (account: AwsAccountOption) => account.enabled,
      );
      const firstAccount = enabled.find(account => account.isDefault) || enabled[0];
      setAccounts(enabled);
      // 重新載入時保留目前選取的帳號（若仍啟用），否則下游的 region/zone/VPC
      // 會與被重置的帳號組成矛盾組合；僅首次載入才套用預設帳號。
      const keepAccountId = form.accountId && enabled.some(account => account.id === form.accountId)
        ? form.accountId
        : null;
      const activeAccount = keepAccountId
        ? enabled.find(account => account.id === keepAccountId) ?? null
        : firstAccount;
      if (!keepAccountId) {
        updateForm({ accountId: firstAccount?.id ?? null });
      }
      if (activeAccount) {
        const regionResponse = await fetch(`/api/wavelength/regions?account_id=${activeAccount.id}`);
        if (!regionResponse.ok) {
          throw new Error("載入 Wavelength Region 失敗");
        }
        const regionPayload = await regionResponse.json();
        setRegions(regionPayload.regions || []);
      }
      if (!osResponse.ok) throw new Error("載入作業系統選項失敗");
      const osPayload = await osResponse.json();
      const os: SelectOption[] = osPayload.os || [];
      setOsOptions(os);
      updateForm({ os: os[0]?.value || "" });
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入部署選項失敗");
    } finally {
      setLoadingInitial(false);
    }
  }

  // 部署請求的憑證欄位：公鑰模式帶 D1 列 id，密碼模式帶本次輸入的明碼
  function credentialPayload() {
    return form.credentialType === "ssh_key"
      ? { credential_type: "ssh_key", ssh_key_id: form.sshKeyId }
      : { credential_type: "password", root_password: form.rootPassword };
  }

  function selectAccount(accountId: number | null) {
    updateForm({ accountId });
    void loadRegions(accountId);
  }

  async function loadRegionOptions(region: string) {
    setZones([]);
    setVpcs([]);
    setInstanceTypes([]);
    setExistingInstances([]);
    updateForm({ region, zone: "", vpcId: "", instanceType: "", existingInstanceId: "" });
    if (!form.accountId || !region) return;

    setLoadingRegion(true);
    try {
      const [zoneResponse, vpcResponse] = await Promise.all([
        fetch(`/api/wavelength/zones?account_id=${form.accountId}&region=${encodeURIComponent(region)}`),
        fetch(`/api/wavelength/vpcs?account_id=${form.accountId}&region=${encodeURIComponent(region)}`),
      ]);
      if (!zoneResponse.ok || !vpcResponse.ok) throw new Error("載入 Zone 或 VPC 失敗");
      const zonePayload = await zoneResponse.json();
      const vpcPayload = await vpcResponse.json();
      setZones(zonePayload.zones || []);
      setVpcs(vpcPayload.vpcs || []);
    } catch {
      toastDanger("載入 Zone 或 VPC 失敗");
    } finally {
      setLoadingRegion(false);
    }
  }
  async function loadInstanceTypes(zone: string) {
    const requestId = ++instanceTypesRequestId.current;
    setInstanceTypes([]);
    updateForm({ instanceType: "" });
    if (!form.region || !zone) return;

    setLoadingTypes(true);
    try {
      const response = await fetch(
        `/api/wavelength/instance-types?account_id=${form.accountId}&region=${encodeURIComponent(form.region)}&zone=${encodeURIComponent(zone)}`,
      );
      if (!response.ok) throw new Error("載入執行個體類型失敗");
      const payload = await response.json();
      // 切換 Zone 會併發多個請求，較慢的舊回應不得覆蓋新選擇
      if (requestId !== instanceTypesRequestId.current) return;
      const types: string[] = payload.instance_types || [];
      setInstanceTypes(types);
      // Wavelength Zone 可能沒有 Instance Type Offering，但部署仍可進行
      // 允許使用者手動指定常見機型（t3.nano, t3.small, t3.medium 等）
      if (types.length === 0) {
        console.warn(`Wavelength Zone ${zone} 沒有 Instance Type Offering，將顯示常用選項`);
        setInstanceTypes(["t3.nano", "t3.small", "t3.medium"]);
        updateForm({ instanceType: "t3.nano" });
        toast.info("此 Zone 未回報可用機型，已預設 t3.nano");
      } else {
        updateForm({ instanceType: types[0] || "" });
      }
    } catch {
      if (requestId !== instanceTypesRequestId.current) return;
      toastDanger("載入執行個體類型失敗");
    } finally {
      if (requestId === instanceTypesRequestId.current) {
        setLoadingTypes(false);
      }
    }
  }
  // 覆蓋參數解決 React 閉包過期狀態：勾選 checkbox 或切換 Zone 時，
  // setState 尚未生效，閉包內的 form.useExistingInstance / form.zone 仍是舊值，
  // 直接讀取會在守衛處短路而不發出請求。
  async function loadExistingInstances(overrides?: { useExisting?: boolean; zone?: string; vpc?: string }) {
    const useExisting = overrides?.useExisting ?? form.useExistingInstance;
    const zone = overrides?.zone ?? form.zone;
    const vpcId = overrides?.vpc ?? form.vpcId;
    setExistingInstances([]);
    updateForm({ existingInstanceId: "" });
    if (!useExisting || !form.region || !zone || !vpcId) return;

    setLoadingInstances(true);
    try {
      const response = await fetch(
        `/api/wavelength/instances?account_id=${form.accountId}&region=${encodeURIComponent(form.region)}&zone=${encodeURIComponent(zone)}&vpc_id=${encodeURIComponent(vpcId)}`,
      );
      if (!response.ok) throw new Error("載入既有 Wavelength 執行個體失敗");
      const payload = await response.json();
      const instances: ExistingInstance[] = payload.instances || [];
      setExistingInstances(instances);
      updateForm({ existingInstanceId: instances[0]?.instance_id || "" });
    } catch {
      toastDanger("載入既有 Wavelength 執行個體失敗");
    } finally {
      setLoadingInstances(false);
    }
  }

  function selectVpc(vpcId: string) {
    updateForm({ vpcId });
    // VPC 變更後先前的執行個體清單與選擇已失效，需一併清除，
    // 否則會送出 vpc_id 與 instance_id 互相矛盾的 payload。
    setExistingInstances([]);
    updateForm({ existingInstanceId: "" });
    if (form.useExistingInstance && form.region && form.zone) {
      void loadExistingInstances({ vpc: vpcId });
    }
  }

  function selectZone(zone: string) {
    updateForm({ zone });
    void loadInstanceTypes(zone).then(() => loadExistingInstances({ zone }));
  }

  function toggleUseExistingInstance(checked: boolean) {
    updateForm({ useExistingInstance: checked });
    if (checked) void loadExistingInstances({ useExisting: true });
  }
  async function runJsonAction(action: string, endpoint: string, payload: Record<string, unknown>, success: string) {
    setBusyAction(action);
    setResult(null);
    appendProgress(`POST ${endpoint}`);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const data = await response.json();
      setResult(data);
      appendProgress(success, data);
      toast.success(success);
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失敗";
      appendProgress(message);
      toastDanger(message);
    } finally {
      setBusyAction("");
    }
  }

  // SSE 部署動作（Wavelength EC2／既有 forwarder）
  async function runDeployAction(action: string, endpoint: string, payload: Record<string, unknown>, success: string) {
    setBusyAction(action);
    setResult(null);
    appendProgress(`POST ${endpoint}`);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readDeploymentStream(response, {
        onProgress: appendProgress,
        stageLabels: STAGE_LABELS,
      });
      setResult(data);
      appendProgress(success, data);
      toast.success(success);
    } catch (error) {
      const message = error instanceof Error ? error.message : "部署失敗";
      appendProgress(message);
      toastDanger(message);
    } finally {
      setBusyAction("");
    }
  }

  function initializeZone() {
    void runJsonAction("init", "/api/wavelength/init", {
      account_id: form.accountId,
      region: form.region,
      zone: form.zone,
      vpc_id: form.vpcId,
    }, "Wavelength Zone 初始化完成");
  }

  function deployWavelength() {
    void runDeployAction("wavelength", "/api/wavelength/deploy", {
      account_id: form.accountId,
      region: form.region,
      zone: form.zone,
      vpc_id: form.vpcId,
      instance_type: form.instanceType,
      os: form.os,
      enable_forwarder: form.enableForwarder,
      ...credentialPayload(),
    }, "Wavelength EC2 部署流程完成");
  }

  function deployExistingForwarder() {
    void runDeployAction("forwarder", "/api/wavelength/forwarder", {
      account_id: form.accountId,
      region: form.region,
      zone: form.zone,
      vpc_id: form.vpcId,
      instance_id: form.existingInstanceId,
      os: form.os,
      ...credentialPayload(),
    }, "既有 Wavelength EC2 的 forwarder 部署完成");
  }

  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    toast.success("部署結果已複製");
  }

  function downloadResult() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aws-wavelength-result-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    // 首次掛載載入帳號、Region、OS 選項與公鑰；載入函式各自管理 loading
    // 狀態與錯誤提示，故此處無需額外的取消旗標。
    async function init() {
      await Promise.all([loadInitialOptions(), loadSshKeys()]);
    }
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isBusy = Boolean(busyAction);
  const canInitialize = Boolean(form.accountId && form.region && form.zone && form.vpcId);
  const credentialReady = form.credentialType === "ssh_key"
    ? Boolean(form.sshKeyId)
    : form.rootPassword.length >= 8 && form.rootPassword.length <= 128;
  const canDeployWavelength = Boolean(canInitialize && form.instanceType && form.os && credentialReady);
  const canDeployExistingForwarder = Boolean(canInitialize && form.os && form.existingInstanceId && credentialReady);
  const resultText = result ? JSON.stringify(result, null, 2) : "";
  const selectClassName = "h-9 rounded-md border bg-background px-3 text-sm";

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Wavelength 部署</h2>
          <p className="text-sm text-muted">初始化網路資源並部署 Wavelength EC2 與 SSH forwarder</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={loadingInitial || isBusy}
          onPress={() => {
            void loadInitialOptions();
            void loadSshKeys();
          }}
        >
          {loadingInitial ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <RefreshCw aria-hidden size={16} />}
          重新載入選項
        </Button>
      </div>

      <Card>
        <Card.Content className="grid gap-4 p-6">
          <div>
            <h3 className="text-base font-semibold">部署參數</h3>
            <p className="text-sm text-muted">選項直接從所選 AWS 帳號查詢</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="grid content-start gap-2">
              <label htmlFor="wl-account" className="text-sm font-medium">AWS 帳號</label>
              <select
                id="wl-account"
                className={selectClassName}
                disabled={loadingInitial || isBusy}
                value={form.accountId ?? ""}
                onChange={event => selectAccount(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="" disabled>請選擇 AWS 帳號</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name}{account.isDefault ? "（預設）" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="wl-region" className="text-sm font-medium">Region</label>
              <select
                id="wl-region"
                className={selectClassName}
                disabled={loadingInitial || isBusy}
                value={form.region}
                onChange={event => void loadRegionOptions(event.target.value)}
              >
                <option value="">請選擇 Region</option>
                {regions.map(region => (
                  <option key={region} value={region}>{regionLabel(region)}</option>
                ))}
              </select>
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="wl-zone" className="text-sm font-medium">Wavelength Zone</label>
              <select
                id="wl-zone"
                className={selectClassName}
                disabled={!form.region || loadingRegion || isBusy}
                value={form.zone}
                onChange={event => selectZone(event.target.value)}
              >
                <option value="">{loadingRegion ? "載入中..." : "請選擇 Zone"}</option>
                {zones.map(zone => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="wl-vpc" className="text-sm font-medium">VPC</label>
              <select
                id="wl-vpc"
                className={selectClassName}
                disabled={!form.region || loadingRegion || isBusy}
                value={form.vpcId}
                onChange={event => selectVpc(event.target.value)}
              >
                <option value="">{loadingRegion ? "載入中..." : "請選擇 VPC"}</option>
                {vpcs.map(vpc => (
                  <option key={vpc.value} value={vpc.value}>{vpc.label}</option>
                ))}
              </select>
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="wl-type" className="text-sm font-medium">WL Instance Type</label>
              <select
                id="wl-type"
                className={selectClassName}
                disabled={!form.zone || loadingTypes || isBusy}
                value={form.instanceType}
                onChange={event => updateForm({ instanceType: event.target.value })}
              >
                <option value="">{loadingTypes ? "載入中..." : "請選擇機型"}</option>
                {instanceTypes.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
                {!loadingTypes && instanceTypes.length === 0 && (
                  <optgroup label="常見 Wavelength 機型（API 未回報時可選）">
                    <option value="t3.nano">t3.nano</option>
                    <option value="t3.small">t3.small</option>
                    <option value="t3.medium">t3.medium</option>
                    <option value="t3.large">t3.large</option>
                  </optgroup>
                )}
              </select>
              <p className="text-xs text-muted">
                {loadingTypes
                  ? "查詢 AWS 可用執行個體類型..."
                  : instanceTypes.length === 0
                    ? "所選 Zone 未回報可用機型；請改用上方常見機型，部署時仍會向 AWS 驗證。"
                    : `該 Zone 可用機型：${instanceTypes.join(", ")}`}
              </p>
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="wl-os" className="text-sm font-medium">作業系統</label>
              <select
                id="wl-os"
                className={selectClassName}
                disabled={loadingInitial || isBusy}
                value={form.os}
                onChange={event => updateForm({ os: event.target.value })}
              >
                <option value="">請選擇作業系統</option>
                {osOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end pb-2">
              <label htmlFor="wl-forwarder" className="flex items-center gap-2 text-sm">
                <input
                  id="wl-forwarder"
                  type="checkbox"
                  className="h-4 w-4"
                  checked={form.enableForwarder}
                  disabled={isBusy}
                  onChange={event => updateForm({ enableForwarder: event.target.checked })}
                />
                部署 WL 時同時建立 SSH forwarder
              </label>
            </div>
          </div>

          {/* 登入憑證為兩種部署動作共用：公鑰取自 D1 公鑰庫，密碼僅存在於本次請求 */}
          <div className="grid grid-cols-1 gap-4 rounded-md border p-4 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <label htmlFor="wl-credential-type" className="text-sm font-medium">登入憑證</label>
              <select
                id="wl-credential-type"
                className={selectClassName}
                disabled={isBusy}
                value={form.credentialType}
                onChange={event => updateForm({ credentialType: event.target.value as "ssh_key" | "password" })}
              >
                <option value="ssh_key">SSH 公鑰</option>
                <option value="password">自訂密碼</option>
              </select>
              <p className="text-xs text-muted">
                公鑰登入會停用 root 密碼認證；自訂密碼不會被儲存，部署後請自行妥善保管。
              </p>
            </div>
            {form.credentialType === "ssh_key" ? (
              <div className="grid content-start gap-2">
                <label htmlFor="wl-ssh-key" className="text-sm font-medium">SSH 公鑰</label>
                <select
                  id="wl-ssh-key"
                  className={selectClassName}
                  disabled={loadingKeys || isBusy}
                  value={form.sshKeyId ?? ""}
                  onChange={event => updateForm({ sshKeyId: event.target.value ? Number(event.target.value) : null })}
                >
                  <option value="" disabled>{loadingKeys ? "載入中..." : "請選擇公鑰"}</option>
                  {sshKeys.map(key => (
                    <option key={key.id} value={key.id}>
                      {key.label}（{sshKeyTypeLabel(key.publicKey)}）
                    </option>
                  ))}
                </select>
                {!loadingKeys && sshKeys.length === 0 ? (
                  <p className="text-xs text-amber-600">尚無公鑰，請先到設定頁新增，或改用自訂密碼。</p>
                ) : null}
              </div>
            ) : (
              <div className="grid content-start gap-2">
                <label htmlFor="wl-root-password" className="text-sm font-medium">root 密碼</label>
                <Input
                  id="wl-root-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="8–128 字元"
                  disabled={isBusy}
                  value={form.rootPassword}
                  onChange={event => updateForm({ rootPassword: event.target.value })}
                />
                <p className="text-xs text-muted">密碼僅用於本次部署，不會寫入資料庫或日誌。</p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="secondary" isDisabled={!canInitialize || isBusy} onPress={initializeZone}>
              {busyAction === "init" ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
              初始化 WL Zone
            </Button>
            <Button isDisabled={!canDeployWavelength || isBusy} onPress={deployWavelength}>
              {busyAction === "wavelength" ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
              部署 Wavelength EC2
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Content className="grid gap-4 p-6">
          <div>
            <h3 className="text-base font-semibold">既有 Wavelength EC2</h3>
            <p className="text-sm text-muted">為指定 VPC 與 Zone 內的既有執行個體建立區域型 SSH forwarder</p>
          </div>
          <div className="grid gap-4">
            <label htmlFor="existing-forwarder" className="flex h-5 items-center gap-2 text-sm">
              <input
                id="existing-forwarder"
                type="checkbox"
                className="h-4 w-4"
                checked={form.useExistingInstance}
                disabled={isBusy}
                onChange={event => toggleUseExistingInstance(event.target.checked)}
              />
              載入既有 WL EC2
            </label>
            <div className="grid gap-2">
              <label htmlFor="existing-instance" className="text-sm font-medium">目標執行個體</label>
              <select
                id="existing-instance"
                className={selectClassName}
                disabled={!form.useExistingInstance || loadingInstances || isBusy}
                value={form.existingInstanceId}
                onChange={event => updateForm({ existingInstanceId: event.target.value })}
              >
                <option value="">{loadingInstances ? "載入中..." : "請選擇既有執行個體"}</option>
                {existingInstances.map(instance => (
                  <option key={instance.instance_id} value={instance.instance_id}>
                    {instance.instance_id} | {instance.private_ip || "無私網 IP"} | {instance.state} | {instance.instance_type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Button variant="secondary" isDisabled={!canDeployExistingForwarder || isBusy} onPress={deployExistingForwarder}>
                {busyAction === "forwarder" ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                部署既有 WL forwarder
              </Button>
            </div>
          </div>
        </Card.Content>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <Card.Content className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">本次操作進度</h3>
                <p className="text-sm text-muted">SSE 部署事件會即時顯示於此</p>
              </div>
              <Button
                variant="ghost"
                aria-label="清空進度"
                isDisabled={progress.length === 0 || isBusy}
                onPress={() => setProgress([])}
              >
                <Trash2 aria-hidden size={16} />
              </Button>
            </div>
            {progress.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">尚未執行操作</div>
            ) : (
              <div className="mt-4 h-80 overflow-y-auto rounded-md border">
                <div className="divide-y">
                  {progress.map((entry, index) => (
                    <div key={index} className="p-3 text-sm">
                      <div className="flex gap-2">
                        <span className="shrink-0 font-mono text-xs text-muted">{entry.time}</span>
                        <span>{entry.message}</span>
                      </div>
                      {entry.details ? (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted">
                          {JSON.stringify(entry.details, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card.Content>
        </Card>

        <Card>
          <Card.Content className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">部署結果</h3>
                <p className="text-sm text-muted">包含連線資訊與新建資源 ID，請妥善保存連線憑證</p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" aria-label="複製結果" isDisabled={!result} onPress={copyResult}>
                  <Clipboard aria-hidden size={16} />
                </Button>
                <Button variant="ghost" aria-label="下載 JSON" isDisabled={!result} onPress={downloadResult}>
                  <Download aria-hidden size={16} />
                </Button>
              </div>
            </div>
            {!result ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted">
                {isBusy ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                {isBusy ? "部署流程執行中" : "尚無部署結果"}
              </div>
            ) : (
              <div className="relative mt-4">
                <Check aria-hidden size={16} className="absolute right-3 top-3 text-green-600" />
                <pre className="h-80 overflow-auto rounded-md border bg-muted/40 p-3 pr-10 text-xs">{resultText}</pre>
              </div>
            )}
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
