'use client'

// 帳號管理：維護 D1 中的多雲 API 憑證（AWS 與 Oracle Cloud OCI）
// 支援新增／編輯／測試／刪除，以及逐帳號的狀態管理。
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Globe, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Modal } from "@heroui/react/modal";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { regionLabel } from "@/lib/regions";

// ─── AWS 帳號定義 ───────────────────────────────────────────

interface AwsAccount {
  id: number
  name: string
  accessKeyHint: string
  enabled: boolean
  isDefault: boolean
  lastVerifiedAt: string | null
}

interface AccountRegion {
  region: string
  optInStatus: string
}

const REGION_STATUS_LABELS: Record<string, string> = {
  "opt-in-not-required": "預設啟用",
  "opted-in": "已開通",
  "not-opted-in": "未開通",
};

function regionStatusLabel(status: string) {
  return REGION_STATUS_LABELS[status] || "已啟用";
}

function isRegionActive(status: string) {
  return status !== "not-opted-in";
}

async function fetchRegionCache(accountId: number, platform: "ec2" | "lightsail"): Promise<string[]> {
  try {
    const response = await fetch(`/api/accounts/${accountId}/regions/cache?platform=${platform}&backfill=0`);
    if (!response.ok) return [];
    const payload = await readJson<{ regions?: string[] }>(response);
    return payload.regions || [];
  } catch {
    return [];
  }
}

const EMPTY_AWS_FORM = {
  name: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  enabled: true,
  isDefault: false,
};

// ─── OCI 帳號定義 ───────────────────────────────────────────

interface OciAccount {
  id: number
  name: string
  tenancyOcid: string
  userOcid: string
  fingerprint: string
  region: string
  compartmentOcid: string
  keyHint: string
  enabled: boolean
  isDefault: boolean
  lastVerifiedAt: string | null
}

const EMPTY_OCI_FORM = {
  name: "",
  tenancyOcid: "",
  userOcid: "",
  fingerprint: "",
  region: "",
  compartmentOcid: "",
  privateKeyPem: "",
  enabled: true,
  isDefault: false,
};

export default function AccountsPage() {
  const [activeTab, setActiveTab] = useState<"aws" | "oci">("aws");

  // ─── AWS 狀態 ─────────────────────────────────────────────
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [regionCaches, setRegionCaches] = useState<Record<number, { ec2: string[]; lightsail: string[] }>>({});
  const [refreshingCacheId, setRefreshingCacheId] = useState<number | null>(null);

  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [accountForm, setAccountForm] = useState(EMPTY_AWS_FORM);

  const [regionOpen, setRegionOpen] = useState(false);
  const [regionAccount, setRegionAccount] = useState<AwsAccount | null>(null);
  const [accountRegions, setAccountRegions] = useState<AccountRegion[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [enablingRegion, setEnablingRegion] = useState<string | null>(null);
  const activeRegions = accountRegions.filter(r => isRegionActive(r.optInStatus));
  const inactiveRegions = accountRegions.filter(r => !isRegionActive(r.optInStatus));

  // ─── OCI 狀態 ─────────────────────────────────────────────
  const [ociAccounts, setOciAccounts] = useState<OciAccount[]>([]);
  const [loadingOci, setLoadingOci] = useState(true);
  const [savingOci, setSavingOci] = useState(false);
  const [testingOciId, setTestingOciId] = useState<number | null>(null);

  const [ociAccountOpen, setOciAccountOpen] = useState(false);
  const [editingOciAccountId, setEditingOciAccountId] = useState<number | null>(null);
  const [ociAccountForm, setOciAccountForm] = useState(EMPTY_OCI_FORM);

  // ─── 資料載入 ─────────────────────────────────────────────
  const loadRegionCaches = useCallback(async (accountList: AwsAccount[]) => {
    const next: Record<number, { ec2: string[]; lightsail: string[] }> = {};
    await Promise.all(accountList.map(async account => {
      const platforms = await Promise.all((["ec2", "lightsail"] as const).map(
        platform => fetchRegionCache(account.id, platform),
      ));
      next[account.id] = { ec2: platforms[0], lightsail: platforms[1] };
    }));
    setRegionCaches(next);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/accounts");
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ accounts: AwsAccount[] }>(response);
      setAccounts(payload.accounts);
      await loadRegionCaches(payload.accounts);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 AWS 帳號資料失敗");
    } finally {
      setLoading(false);
    }
  }, [loadRegionCaches]);

  const loadOciData = useCallback(async () => {
    setLoadingOci(true);
    try {
      const response = await fetch("/api/oci-accounts");
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ accounts: OciAccount[] }>(response);
      setOciAccounts(payload.accounts || []);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 OCI 帳號資料失敗");
    } finally {
      setLoadingOci(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      await loadData();
      if (cancelled) return;
      await loadOciData();
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadData, loadOciData]);

  // ─── AWS 操作 ─────────────────────────────────────────────
  async function refreshRegionCache(account: AwsAccount) {
    setRefreshingCacheId(account.id);
    try {
      const response = await fetch(`/api/accounts/${account.id}/regions/cache`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ message?: string }>(response);
      toast.success(payload.message || "區域快取已更新");
      await loadRegionCaches([account]);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更新區域快取失敗");
    } finally {
      setRefreshingCacheId(null);
    }
  }

  function openNewAccount() {
    setEditingAccountId(null);
    setAccountForm({ ...EMPTY_AWS_FORM, isDefault: accounts.length === 0 });
    setAccountOpen(true);
  }

  function openEditAccount(account: AwsAccount) {
    setEditingAccountId(account.id);
    setAccountForm({
      name: account.name,
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
      enabled: account.enabled,
      isDefault: account.isDefault,
    });
    setAccountOpen(true);
  }

  async function saveAccount() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: accountForm.name,
        enabled: accountForm.enabled,
        isDefault: accountForm.isDefault,
      };
      if (!editingAccountId || accountForm.accessKeyId.trim()) {
        body.accessKeyId = accountForm.accessKeyId;
        body.secretAccessKey = accountForm.secretAccessKey;
        body.sessionToken = accountForm.sessionToken;
      }
      const response = await fetch(editingAccountId ? `/api/accounts/${editingAccountId}` : "/api/accounts", {
        method: editingAccountId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success(editingAccountId ? "AWS 帳號已更新" : "AWS 帳號已建立");
      setAccountOpen(false);
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "儲存 AWS 帳號失敗");
    } finally {
      setSaving(false);
    }
  }

  async function testAccount(account: AwsAccount) {
    setTestingId(account.id);
    try {
      const response = await fetch(`/api/accounts/${account.id}/test`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("AWS 憑證驗證成功");
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "AWS 憑證驗證失敗");
    } finally {
      setTestingId(null);
    }
  }

  async function removeAccount(account: AwsAccount) {
    if (!window.confirm(`確定刪除 AWS 帳號「${account.name}」？`)) {
      return;
    }
    try {
      const response = await fetch(`/api/accounts/${account.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("AWS 帳號已刪除");
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "刪除 AWS 帳號失敗");
    }
  }

  async function openRegionDialog(account: AwsAccount) {
    setRegionAccount(account);
    setRegionOpen(true);
    await loadAccountRegions(account.id);
  }

  async function loadAccountRegions(accountId: number) {
    setLoadingRegions(true);
    try {
      const response = await fetch(`/api/accounts/${accountId}/regions`);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await readJson<{ regions?: AccountRegion[] }>(response);
      setAccountRegions(payload.regions || []);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入區域清單失敗");
    } finally {
      setLoadingRegions(false);
    }
  }

  async function enableRegion(region: string) {
    if (!regionAccount) return;
    setEnablingRegion(region);
    try {
      const response = await fetch(`/api/accounts/${regionAccount.id}/regions/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await readJson<{ message?: string }>(response);
      toast.success(payload?.message || `已送出開通 ${region} 的請求`);
      await loadAccountRegions(regionAccount.id);
      await loadRegionCaches(accounts);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : `開通 ${region} 失敗`);
    } finally {
      setEnablingRegion(null);
    }
  }

  // ─── OCI 操作 ─────────────────────────────────────────────
  function updateOciField(key: keyof typeof EMPTY_OCI_FORM, value: string | boolean) {
    setOciAccountForm(previous => ({ ...previous, [key]: value }));
  }

  function openNewOciAccount() {
    setEditingOciAccountId(null);
    setOciAccountForm({ ...EMPTY_OCI_FORM, isDefault: ociAccounts.length === 0 });
    setOciAccountOpen(true);
  }

  function openEditOciAccount(account: OciAccount) {
    setEditingOciAccountId(account.id);
    setOciAccountForm({
      name: account.name,
      tenancyOcid: account.tenancyOcid,
      userOcid: account.userOcid,
      fingerprint: account.fingerprint,
      region: account.region,
      compartmentOcid: account.compartmentOcid,
      privateKeyPem: "",
      enabled: account.enabled,
      isDefault: account.isDefault,
    });
    setOciAccountOpen(true);
  }

  async function saveOciAccount() {
    setSavingOci(true);
    try {
      const body: Record<string, unknown> = {
        name: ociAccountForm.name,
        tenancyOcid: ociAccountForm.tenancyOcid,
        userOcid: ociAccountForm.userOcid,
        fingerprint: ociAccountForm.fingerprint,
        region: ociAccountForm.region,
        compartmentOcid: ociAccountForm.compartmentOcid,
        enabled: ociAccountForm.enabled,
        isDefault: ociAccountForm.isDefault,
      };
      if (!editingOciAccountId || ociAccountForm.privateKeyPem.trim()) {
        body.privateKeyPem = ociAccountForm.privateKeyPem;
      }
      const response = await fetch(editingOciAccountId ? `/api/oci-accounts/${editingOciAccountId}` : "/api/oci-accounts", {
        method: editingOciAccountId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success(editingOciAccountId ? "OCI 帳號已更新" : "OCI 帳號已建立");
      setOciAccountOpen(false);
      await loadOciData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "儲存 OCI 帳號失敗");
    } finally {
      setSavingOci(false);
    }
  }

  async function testOciAccount(account: OciAccount) {
    setTestingOciId(account.id);
    try {
      const response = await fetch(`/api/oci-accounts/${account.id}/test`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("OCI 憑證驗證成功");
      await loadOciData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "OCI 憑證驗證失敗");
    } finally {
      setTestingOciId(null);
    }
  }

  async function removeOciAccount(account: OciAccount) {
    if (!window.confirm(`確定刪除 OCI 帳號「${account.name}」？`)) {
      return;
    }
    try {
      const response = await fetch(`/api/oci-accounts/${account.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("OCI 帳號已刪除");
      await loadOciData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "刪除 OCI 帳號失敗");
    }
  }

  const inputClassName = "rounded-md border bg-background px-3 py-2 text-sm";

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">帳號管理</h2>
        <p className="text-sm text-muted">管理 D1 中的多雲 API 憑證（金鑰密文加密儲存，安全隔離）</p>
      </div>

      {/* 平台切換分頁 */}
      <div className="flex border-b border-divider gap-2">
        <button
          type="button"
          onClick={() => setActiveTab("aws")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors ${
            activeTab === "aws"
              ? "border-primary text-foreground font-semibold"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          <span>AWS 帳號</span>
          <Chip variant="soft" size="sm">{accounts.length}</Chip>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("oci")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors ${
            activeTab === "oci"
              ? "border-primary text-foreground font-semibold"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          <span>Oracle Cloud (OCI) 帳號</span>
          <Chip variant="soft" size="sm">{ociAccounts.length}</Chip>
        </button>
      </div>

      {/* ─── AWS 帳號區塊 ────────────────────────────────────── */}
      {activeTab === "aws" && (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound aria-hidden size={20} />
              <h3 className="text-lg font-semibold">AWS 帳號</h3>
            </div>
            <Button size="sm" onPress={openNewAccount}>
              <Plus aria-hidden size={16} />
              新增 AWS 帳號
            </Button>
          </div>
          {loading ? (
            <div className="flex py-8 text-sm text-muted">
              <Loader2 aria-hidden size={16} className="mr-2 animate-spin" />載入中...
            </div>
          ) : accounts.length === 0 ? (
            <div className="border-y py-10 text-center text-sm text-muted">尚未建立 AWS 帳號</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {accounts.map(account => (
                <Card key={account.id}>
                  <Card.Content className="grid gap-3 p-6">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="text-base font-semibold">{account.name}</h4>
                        <p className="text-sm text-muted">Access Key ····{account.accessKeyHint}</p>
                      </div>
                      <div className="flex gap-1">
                        {account.isDefault ? <Chip variant="default">預設</Chip> : null}
                        <Chip variant={account.enabled ? "secondary" : "soft"}>
                          {account.enabled ? "啟用" : "停用"}
                        </Chip>
                      </div>
                    </div>
                    <p className="text-xs text-muted">
                      最近驗證：{account.lastVerifiedAt
                        ? new Date(account.lastVerifiedAt).toLocaleString("zh-TW")
                        : "尚未驗證"}
                    </p>
                    {(() => {
                      const cache = regionCaches[account.id];
                      const ec2Count = cache?.ec2.length ?? 0;
                      const lightsailCount = cache?.lightsail.length ?? 0;
                      const tooltip = cache
                        ? `EC2：${cache.ec2.join("、") || "（無）"}\nLightsail：${cache.lightsail.join("、") || "（無）"}`
                        : "";
                      return (
                        <p className="text-xs text-muted" title={tooltip}>
                          區域快取：EC2 {ec2Count} 區 · Lightsail {lightsailCount} 區
                          {cache && ec2Count === 0 && lightsailCount === 0 ? "（尚未建立，開機器時自動抓取）" : ""}
                        </p>
                      );
                    })()}
                    <div className="flex justify-end gap-1 border-t pt-3">
                      <Button
                        variant="ghost"
                        aria-label="重新整理區域快取"
                        isDisabled={refreshingCacheId === account.id}
                        onPress={() => refreshRegionCache(account)}
                      >
                        {refreshingCacheId === account.id
                          ? <Loader2 aria-hidden size={16} className="animate-spin" />
                          : <RefreshCw aria-hidden size={16} />}
                      </Button>
                      <Button variant="ghost" aria-label="開通區域" onPress={() => openRegionDialog(account)}>
                        <Globe aria-hidden size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label="測試憑證"
                        isDisabled={testingId === account.id}
                        onPress={() => testAccount(account)}
                      >
                        {testingId === account.id
                          ? <Loader2 aria-hidden size={16} className="animate-spin" />
                          : <CheckCircle2 aria-hidden size={16} />}
                      </Button>
                      <Button variant="ghost" aria-label="編輯帳號" onPress={() => openEditAccount(account)}>
                        <Pencil aria-hidden size={16} />
                      </Button>
                      <Button variant="ghost" aria-label="刪除帳號" onPress={() => removeAccount(account)}>
                        <Trash2 aria-hidden size={16} />
                      </Button>
                    </div>
                  </Card.Content>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ─── OCI 帳號區塊 ────────────────────────────────────── */}
      {activeTab === "oci" && (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound aria-hidden size={20} />
              <h3 className="text-lg font-semibold">Oracle Cloud (OCI) 帳號</h3>
            </div>
            <Button size="sm" onPress={openNewOciAccount}>
              <Plus aria-hidden size={16} />
              新增 OCI 帳號
            </Button>
          </div>
          {loadingOci ? (
            <div className="flex py-8 text-sm text-muted">
              <Loader2 aria-hidden size={16} className="mr-2 animate-spin" />載入中...
            </div>
          ) : ociAccounts.length === 0 ? (
            <div className="border-y py-10 text-center text-sm text-muted">尚未建立 OCI 帳號</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {ociAccounts.map(account => (
                <Card key={account.id}>
                  <Card.Content className="grid gap-3 p-6">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0">
                        <h4 className="text-base font-semibold">{account.name}</h4>
                        <p className="truncate text-sm text-muted">
                          {account.region} · 指紋 ····{account.keyHint}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        {account.isDefault ? <Chip variant="default">預設</Chip> : null}
                        <Chip variant={account.enabled ? "secondary" : "soft"}>
                          {account.enabled ? "啟用" : "停用"}
                        </Chip>
                      </div>
                    </div>
                    <p className="text-xs text-muted truncate">
                      Compartment: {account.compartmentOcid}
                    </p>
                    <p className="text-xs text-muted">
                      最近驗證：{account.lastVerifiedAt
                        ? new Date(account.lastVerifiedAt).toLocaleString("zh-TW")
                        : "尚未驗證"}
                    </p>
                    <div className="flex justify-end gap-1 border-t pt-3">
                      <Button
                        variant="ghost"
                        aria-label="測試憑證"
                        isDisabled={testingOciId === account.id}
                        onPress={() => testOciAccount(account)}
                      >
                        {testingOciId === account.id
                          ? <Loader2 aria-hidden size={16} className="animate-spin" />
                          : <CheckCircle2 aria-hidden size={16} />}
                      </Button>
                      <Button variant="ghost" aria-label="編輯帳號" onPress={() => openEditOciAccount(account)}>
                        <Pencil aria-hidden size={16} />
                      </Button>
                      <Button variant="ghost" aria-label="刪除帳號" onPress={() => removeOciAccount(account)}>
                        <Trash2 aria-hidden size={16} />
                      </Button>
                    </div>
                  </Card.Content>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ─── AWS 新增／編輯對話框 ──────────────────────────── */}
      <Modal.Root isOpen={accountOpen} onOpenChange={setAccountOpen}>
        <Modal.Backdrop>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{editingAccountId ? "編輯 AWS 帳號" : "新增 AWS 帳號"}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  Secret 僅會加密寫入 D1，既有 Secret 不會讀回瀏覽器。
                </p>
                <div className="grid gap-4 py-2">
                  <div className="grid gap-2">
                    <label htmlFor="account-name" className="text-sm font-medium">名稱</label>
                    <Input
                      id="account-name"
                      value={accountForm.name}
                      onChange={event => setAccountForm(previous => ({ ...previous, name: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="access-key" className="text-sm font-medium">Access Key ID</label>
                    <Input
                      id="access-key"
                      autoComplete="off"
                      placeholder={editingAccountId ? "留空表示不替換" : ""}
                      value={accountForm.accessKeyId}
                      onChange={event => setAccountForm(previous => ({ ...previous, accessKeyId: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="secret-key" className="text-sm font-medium">Secret Access Key</label>
                    <Input
                      id="secret-key"
                      type="password"
                      autoComplete="new-password"
                      placeholder={editingAccountId ? "留空表示不替換" : ""}
                      value={accountForm.secretAccessKey}
                      onChange={event => setAccountForm(previous => ({ ...previous, secretAccessKey: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="session-token" className="text-sm font-medium">Session Token（選填）</label>
                    <textarea
                      id="session-token"
                      className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder={editingAccountId ? "替換憑證時才需填寫" : ""}
                      value={accountForm.sessionToken}
                      onChange={event => setAccountForm(previous => ({ ...previous, sessionToken: event.target.value }))}
                    />
                  </div>
                  <div className="flex gap-6">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={accountForm.enabled}
                        onChange={event => setAccountForm(previous => ({ ...previous, enabled: event.target.checked }))}
                      />
                      啟用
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={accountForm.isDefault}
                        onChange={event => setAccountForm(previous => ({ ...previous, isDefault: event.target.checked }))}
                      />
                      設為預設
                    </label>
                  </div>
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setAccountOpen(false)}>
                  取消
                </Button>
                <Button
                  isDisabled={saving || !accountForm.name || (!editingAccountId && (!accountForm.accessKeyId || !accountForm.secretAccessKey))}
                  onPress={saveAccount}
                >
                  {saving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                  儲存
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* ─── AWS 開通區域對話框 ──────────────────────────── */}
      <Modal.Root isOpen={regionOpen} onOpenChange={setRegionOpen}>
        <Modal.Backdrop>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>開通新區域 — {regionAccount?.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  列出此 AWS 帳號的全部 Region；開通 opt-in 區域後需數分鐘才可供部署。
                </p>
                {loadingRegions ? (
                  <div className="flex py-8 text-sm text-muted">
                    <Loader2 aria-hidden size={16} className="mr-2 animate-spin" />載入中...
                  </div>
                ) : (
                  <div className="max-h-80 space-y-5 overflow-y-auto pr-1">
                    <div className="space-y-2">
                      <p className="text-sm font-medium">可部署（{activeRegions.length}）</p>
                      {activeRegions.map(r => (
                        <div key={r.region} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                          <span className="text-sm">{regionLabel(r.region)}</span>
                          <Chip variant="secondary">{regionStatusLabel(r.optInStatus)}</Chip>
                        </div>
                      ))}
                      {activeRegions.length === 0 ? (
                        <p className="text-xs text-muted">沒有已啟用的區域</p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm font-medium">未啟用（{inactiveRegions.length}）</p>
                      {inactiveRegions.map(r => (
                        <div key={r.region} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                          <span className="text-sm">{regionLabel(r.region)}</span>
                          <Button
                            size="sm"
                            variant="secondary"
                            isDisabled={enablingRegion !== null}
                            onPress={() => enableRegion(r.region)}
                          >
                            {enablingRegion === r.region ? <Loader2 aria-hidden size={14} className="mr-2 animate-spin" /> : null}
                            開通
                          </Button>
                        </div>
                      ))}
                      {inactiveRegions.length === 0 ? (
                        <p className="text-xs text-muted">所有區域皆已啟用</p>
                      ) : null}
                    </div>
                  </div>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setRegionOpen(false)}>
                  關閉
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* ─── OCI 新增／編輯對話框 ──────────────────────────── */}
      <Modal.Root isOpen={ociAccountOpen} onOpenChange={setOciAccountOpen}>
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{editingOciAccountId ? "編輯 OCI 帳號" : "新增 OCI 帳號"}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  於 OCI 主控台「User Settings → API Keys」產生 API Key；PEM 私鑰僅會加密寫入 D1，
                  不會讀回瀏覽器。
                </p>
                <div className="grid gap-4 py-2">
                  <div className="grid gap-2">
                    <label htmlFor="oci-account-name" className="text-sm font-medium">名稱</label>
                    <Input
                      id="oci-account-name"
                      value={ociAccountForm.name}
                      onChange={event => updateOciField("name", event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="oci-tenancy-ocid" className="text-sm font-medium">Tenancy OCID</label>
                    <Input
                      id="oci-tenancy-ocid"
                      className="font-mono text-xs"
                      autoComplete="off"
                      placeholder="ocid1.tenancy.oc1..aaaa…"
                      value={ociAccountForm.tenancyOcid}
                      onChange={event => updateOciField("tenancyOcid", event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="oci-user-ocid" className="text-sm font-medium">User OCID</label>
                    <Input
                      id="oci-user-ocid"
                      className="font-mono text-xs"
                      autoComplete="off"
                      placeholder="ocid1.user.oc1..aaaa…"
                      value={ociAccountForm.userOcid}
                      onChange={event => updateOciField("userOcid", event.target.value)}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <label htmlFor="oci-fingerprint" className="text-sm font-medium">Fingerprint</label>
                      <Input
                        id="oci-fingerprint"
                        className="font-mono text-xs"
                        autoComplete="off"
                        placeholder="aa:bb:cc:…:ff"
                        value={ociAccountForm.fingerprint}
                        onChange={event => updateOciField("fingerprint", event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <label htmlFor="oci-region" className="text-sm font-medium">Region（home region）</label>
                      <Input
                        id="oci-region"
                        autoComplete="off"
                        placeholder="ap-osaka-1"
                        value={ociAccountForm.region}
                        onChange={event => updateOciField("region", event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="oci-compartment-ocid" className="text-sm font-medium">Compartment OCID</label>
                    <Input
                      id="oci-compartment-ocid"
                      className="font-mono text-xs"
                      autoComplete="off"
                      placeholder="ocid1.compartment.oc1..aaaa…"
                      value={ociAccountForm.compartmentOcid}
                      onChange={event => updateOciField("compartmentOcid", event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="oci-private-key" className="text-sm font-medium">
                      PEM 私鑰{editingOciAccountId ? "（留空表示不替換）" : ""}
                    </label>
                    <textarea
                      id="oci-private-key"
                      className={`${inputClassName} min-h-32 font-mono text-xs`}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
                      value={ociAccountForm.privateKeyPem}
                      onChange={event => updateOciField("privateKeyPem", event.target.value)}
                    />
                  </div>
                  <div className="flex gap-6">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={ociAccountForm.enabled}
                        onChange={event => updateOciField("enabled", event.target.checked)}
                      />
                      啟用
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={ociAccountForm.isDefault}
                        onChange={event => updateOciField("isDefault", event.target.checked)}
                      />
                      設為預設
                    </label>
                  </div>
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setOciAccountOpen(false)}>
                  取消
                </Button>
                <Button
                  isDisabled={
                    savingOci
                    || !ociAccountForm.name
                    || !ociAccountForm.tenancyOcid
                    || !ociAccountForm.userOcid
                    || !ociAccountForm.fingerprint
                    || !ociAccountForm.region
                    || !ociAccountForm.compartmentOcid
                    || (!editingOciAccountId && !ociAccountForm.privateKeyPem.trim())
                  }
                  onPress={saveOciAccount}
                >
                  {savingOci ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                  儲存
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </div>
  );
}
