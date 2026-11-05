'use client'

// EC2 部署：以「帳號 → Region → VPC → OS → 登入憑證」表單建立一般區域
// EC2，部署流程以 SSE 即時回報進度，結果含連線資訊可複製／下載。
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Clipboard, Download, Loader2, RefreshCw, Server, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { DeployModeTabs } from "./deploy-tabs";
import { readJson, toastDanger } from "@/lib/api-client";
import { regionLabel } from "@/lib/regions";
import { readDeploymentStream } from "@/lib/deployment-stream";
import { sshKeyTypeLabel, type SshPublicKeyOption } from "@/lib/ssh-keys";
import { CustomSelect } from "@/components/ui/select";

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

interface ProgressEntry {
  time: string
  message: string
  details?: Record<string, unknown>
}

const STAGE_LABELS: Record<string, string> = {
  validating: "開始驗證部署輸入",
  ensure_vpc_ipv6: "確保 VPC IPv6 CIDR",
  ensure_subnet_ipv6: "確保子網 IPv6 CIDR",
  ensure_ipv6_route: "設定 IPv6 公網路由",
  ensure_ipv6_sg: "設定 IPv6 安全群組規則",
  waiting_vpc_ipv6: "等待 VPC IPv6 CIDR 關聯完成",
  waiting_subnet_ipv6: "等待子網 IPv6 CIDR 關聯完成",
  resources_ready: "網路資源已就緒",
  credentials_ready: "登入憑證已套用",
  instance_launched: "EC2 執行個體已啟動",
  waiting_for_running: "等待執行個體進入 running",
  instance_running: "執行個體已進入 running",
  waiting_for_public_dns: "等待公網 DNS",
  public_dns_ready: "公網 DNS 已就緒",
  waiting_for_status_checks: "等待狀態檢查",
  status_check_progress: "狀態檢查進度",
  status_checks_passed: "狀態檢查已通過",
  waiting_for_cloud_init: "等待 cloud-init 完成",
  cloud_init_complete: "cloud-init 已完成",
};


export default function Ec2Page() {
  const [accounts, setAccounts] = useState<AwsAccountOption[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [vpcs, setVpcs] = useState<SelectOption[]>([]);
  const [osOptions, setOsOptions] = useState<SelectOption[]>([]);
  const [sshKeys, setSshKeys] = useState<SshPublicKeyOption[]>([]);
  const [form, setForm] = useState({
    accountId: null as number | null,
    region: "",
    vpcId: "",
    os: "",
    credentialType: "ssh_key" as "ssh_key" | "password",
    sshKeyId: null as number | null,
    rootPassword: "",
    ipv6: false,
  });
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingVpcs, setLoadingVpcs] = useState(false);
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

  // 載入 D1 公鑰庫供憑證下拉選擇；既有選擇失效時回落到第一把
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
    setForm(previous => ({ ...previous, region: "", vpcId: "" }));
    if (!accountId) return;
    try {
      // 讀帳號的區域快取（建立帳號時建立）；快取為空會自動回填
      const response = await fetch(`/api/accounts/${accountId}/regions/cache?platform=ec2`);
      if (!response.ok) throw new Error("載入 EC2 Region 失敗");
      const payload = await readJson<{ regions?: string[]; cached?: boolean }>(response);
      setRegions(payload.regions || []);
      if (payload.cached === false) toast.success("首次讀取：已從 AWS 抓取並快取此帳號的區域清單");
    } catch {
      toastDanger("載入 EC2 Region 失敗");
    }
  }

  async function loadInitialOptions() {
    setLoadingInitial(true);
    try {
      const [accountResponse, osResponse] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/ec2/os-options"),
      ]);
      if (!accountResponse.ok || !osResponse.ok) {
        throw new Error("載入 EC2 部署選項失敗");
      }
      const accountPayload = await readJson<{ accounts: AwsAccountOption[] }>(accountResponse);
      const osPayload = await readJson<{ os?: SelectOption[] }>(osResponse);
      const enabled: AwsAccountOption[] = accountPayload.accounts.filter(
        (account: AwsAccountOption) => account.enabled,
      );
      const firstAccount = enabled.find(account => account.isDefault) || enabled[0];
      const os: SelectOption[] = osPayload.os || [];
      setAccounts(enabled);
      setOsOptions(os);
      // 重新載入時保留目前選取的帳號（若仍啟用）；loadRegions 會清空
      // region/vpc，重新套用預設帳號等於丟掉使用者已完成的選擇。
      const activeAccount = form.accountId && enabled.some(account => account.id === form.accountId)
        ? enabled.find(account => account.id === form.accountId) ?? null
        : firstAccount;
      setForm(previous => ({
        ...previous,
        accountId: activeAccount?.id ?? null,
        os: previous.os || os[0]?.value || "",
      }));
      if (activeAccount) await loadRegions(activeAccount.id);
    } catch {
      toastDanger("載入 EC2 部署選項失敗");
    } finally {
      setLoadingInitial(false);
    }
  }

  async function loadVpcs(accountId: number | null, region: string) {
    setVpcs([]);
    setForm(previous => ({ ...previous, vpcId: "" }));
    if (!accountId || !region) return;

    setLoadingVpcs(true);
    try {
      const response = await fetch(`/api/ec2/vpcs?account_id=${accountId}&region=${encodeURIComponent(region)}`);
      if (!response.ok) throw new Error("載入 VPC 失敗");
      const payload = await readJson<{ vpcs?: SelectOption[] }>(response);
      setVpcs(payload.vpcs || []);
    } catch {
      toastDanger("載入 VPC 失敗");
    } finally {
      setLoadingVpcs(false);
    }
  }

  function selectAccount(accountId: number | null) {
    setForm(previous => ({ ...previous, accountId }));
    void loadRegions(accountId);
  }

  function selectRegion(region: string) {
    setForm(previous => ({ ...previous, region }));
    void loadVpcs(form.accountId, region);
  }

  useEffect(() => {
    // 首次掛載載入帳號、Region、OS 選項與公鑰；載入函式各自管理
    // loading 狀態與錯誤提示，故此處無需額外的取消旗標。
    async function init() {
      await Promise.all([loadInitialOptions(), loadSshKeys()]);
    }
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 部署請求的憑證欄位：公鑰模式帶 D1 列 id，密碼模式帶本次輸入的明碼
  function credentialPayload() {
    return form.credentialType === "ssh_key"
      ? { credential_type: "ssh_key", ssh_key_id: form.sshKeyId }
      : { credential_type: "password", root_password: form.rootPassword };
  }

  async function deployEc2() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    appendProgress("開始部署一般 EC2");
    try {
      const response = await fetch("/api/ec2/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: form.accountId,
          region: form.region,
          vpc_id: form.vpcId,
          os: form.os,
          ipv6: form.ipv6,
          ...credentialPayload(),
        }),
      });
      const finalResult = await readDeploymentStream(response, {
        onProgress: appendProgress,
        stageLabels: STAGE_LABELS,
      });
      setResult(finalResult);
      appendProgress("一般 EC2 部署流程完成", finalResult);
      toast.success("一般 EC2 部署流程完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "EC2 部署失敗";
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
    link.download = `aws-ec2-result-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function reloadOptions() {
    void loadInitialOptions();
    void loadSshKeys();
  }

  const credentialReady = form.credentialType === "ssh_key"
    ? Boolean(form.sshKeyId)
    : form.rootPassword.length >= 8 && form.rootPassword.length <= 128;
  const canDeploy = Boolean(form.accountId && form.region && form.vpcId && form.os && credentialReady);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/ec2" className="text-xs text-muted underline-offset-4 hover:underline">
            ← 返回 EC2
          </Link>
          <h2 className="text-2xl font-bold tracking-tight">新增 EC2</h2>
          <p className="text-sm text-muted">在一般 Region 或 Wavelength Zone 建立執行個體</p>
        </div>
        <Button variant="secondary" size="sm" isDisabled={loadingInitial || busy} onPress={reloadOptions}>
          {loadingInitial ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <RefreshCw aria-hidden size={16} />}
          重新載入選項
        </Button>
      </div>

      <DeployModeTabs current="regional" />

      <Card>
        <Card.Content className="grid gap-4 p-6">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <Server aria-hidden size={16} />
              部署參數
            </h3>
            <p className="text-sm text-muted">一般 EC2 固定使用 t3.nano，部署後會自動加入機器總覽</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="grid content-start gap-2">
              <label htmlFor="ec2-account" className="text-sm font-medium">AWS 帳號</label>
              <CustomSelect
                id="ec2-account"
                value={form.accountId}
                placeholder="請選擇 AWS 帳號"
                disabled={loadingInitial || busy}
                options={accounts.map(account => ({
                  value: String(account.id),
                  label: `${account.name}${account.isDefault ? "（預設）" : ""}`,
                }))}
                onChange={val => selectAccount(val ? Number(val) : null)}
              />
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="ec2-region" className="text-sm font-medium">Region</label>
              <CustomSelect
                id="ec2-region"
                value={form.region}
                placeholder="請選擇 Region"
                disabled={!form.accountId || loadingInitial || busy}
                options={regions.map(region => ({
                  value: region,
                  label: regionLabel(region),
                }))}
                onChange={selectRegion}
              />
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="ec2-vpc" className="text-sm font-medium">VPC</label>
              <CustomSelect
                id="ec2-vpc"
                value={form.vpcId}
                placeholder={loadingVpcs ? "載入中..." : "請選擇 VPC"}
                disabled={!form.region || loadingVpcs || busy}
                options={vpcs.map(vpc => ({
                  value: vpc.value,
                  label: vpc.label,
                }))}
                onChange={val => setForm(previous => ({ ...previous, vpcId: val }))}
              />
            </div>
            <div className="grid content-start gap-2">
              <label htmlFor="ec2-os" className="text-sm font-medium">作業系統</label>
              <CustomSelect
                id="ec2-os"
                value={form.os}
                placeholder="請選擇作業系統"
                disabled={loadingInitial || busy}
                options={osOptions.map(option => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={val => setForm(previous => ({ ...previous, os: val }))}
              />
            </div>
          </div>

          {/* IPv6：完整開通（VPC/子網 CIDR、IGW 路由、安全群組規則） */}
          <div className="flex items-center rounded-md border p-4">
            <label htmlFor="ec2-ipv6" className="flex items-center gap-2 text-sm">
              <input
                id="ec2-ipv6"
                type="checkbox"
                className="h-4 w-4"
                checked={form.ipv6}
                disabled={busy}
                onChange={event => setForm(previous => ({ ...previous, ipv6: event.target.checked }))}
              />
              啟用 IPv6（完整開通：CIDR、公網路由與安全群組規則）
            </label>
          </div>

          {/* 登入憑證：公鑰取自 D1 公鑰庫，密碼僅存在於本次請求 */}
          <div className="grid grid-cols-1 gap-4 rounded-md border p-4 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <label htmlFor="ec2-credential-type" className="text-sm font-medium">登入憑證</label>
              <CustomSelect
                id="ec2-credential-type"
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
                <label htmlFor="ec2-ssh-key" className="text-sm font-medium">SSH 公鑰</label>
                <CustomSelect
                  id="ec2-ssh-key"
                  value={form.sshKeyId}
                  placeholder={loadingKeys ? "載入中..." : "請選擇公鑰"}
                  disabled={loadingKeys || busy}
                  options={sshKeys.map(key => ({
                    value: String(key.id),
                    label: `${key.label}（${sshKeyTypeLabel(key.publicKey)}）`,
                  }))}
                  onChange={val => setForm(previous => ({
                    ...previous,
                    sshKeyId: val ? Number(val) : null,
                  }))}
                />
                {!loadingKeys && sshKeys.length === 0 ? (
                  <p className="text-xs text-amber-600">尚無公鑰，請先到設定頁新增，或改用自訂密碼。</p>
                ) : null}
              </div>
            ) : (
              <div className="grid content-start gap-2">
                <label htmlFor="ec2-root-password" className="text-sm font-medium">root 密碼</label>
                <Input
                  id="ec2-root-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="8–128 字元"
                  disabled={busy}
                  value={form.rootPassword}
                  onChange={event => setForm(previous => ({ ...previous, rootPassword: event.target.value }))}
                />
                <p className="text-xs text-muted">密碼僅用於本次部署，不會寫入資料庫或日誌。</p>
              </div>
            )}
          </div>

          <div className="flex justify-end border-t pt-4">
            <Button isDisabled={!canDeploy || busy} onPress={deployEc2}>
              {busy ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
              部署 EC2
            </Button>
          </div>
        </Card.Content>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <Card.Content className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">本次部署進度</h3>
                <p className="text-sm text-muted">EC2 建立與就緒狀態會即時顯示於此</p>
              </div>
              <Button
                variant="ghost"
                aria-label="清空進度"
                isDisabled={progress.length === 0 || busy}
                onPress={() => setProgress([])}
              >
                <Trash2 aria-hidden size={16} />
              </Button>
            </div>
            {progress.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">尚未執行部署</div>
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
                <p className="text-sm text-muted">包含 EC2 連線資訊，請妥善保存連線憑證</p>
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
                {busy ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                {busy ? "部署流程執行中" : "尚無部署結果"}
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
