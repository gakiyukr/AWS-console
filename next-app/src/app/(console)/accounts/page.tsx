'use client'

// 帳號管理：維護 D1 中的 AWS 加密憑證（新增／編輯／測試／刪除），
// 並提供逐帳號的 Region opt-in 狀態檢視與開通請求。
import { useEffect, useState } from "react";
import { CheckCircle2, Globe, KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Modal } from "@heroui/react/modal";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { regionLabel } from "@/lib/regions";

interface AwsAccount {
  id: number
  name: string
  accessKeyHint: string
  enabled: boolean
  isDefault: boolean
  lastVerifiedAt: string | null
}

// DescribeRegions(AllRegions=true) 回傳的 opt-in 狀態：
// opt-in-not-required 為預設啟用區域，opted-in 為已開通的 opt-in 區域
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

// 僅 not-opted-in 視為未啟用；空值與其餘狀態一律視為可部署，與後端過濾一致
function isRegionActive(status: string) {
  return status !== "not-opted-in";
}



const EMPTY_FORM = {
  name: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  enabled: true,
  isDefault: false,
};

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [accountForm, setAccountForm] = useState(EMPTY_FORM);

  // 開通區域對話框：逐帳號列出全部 Region 與 opt-in 狀態，
  // 未啟用區域可逐個送出開通請求（EC2 EnableRegion）。
  const [regionOpen, setRegionOpen] = useState(false);
  const [regionAccount, setRegionAccount] = useState<AwsAccount | null>(null);
  const [accountRegions, setAccountRegions] = useState<AccountRegion[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [enablingRegion, setEnablingRegion] = useState<string | null>(null);
  const activeRegions = accountRegions.filter(r => isRegionActive(r.optInStatus));
  const inactiveRegions = accountRegions.filter(r => !isRegionActive(r.optInStatus));

  async function loadData() {
    setLoading(true);
    try {
      const response = await fetch("/api/accounts");
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ accounts: AwsAccount[] }>(response);
      setAccounts(payload.accounts);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入帳號資料失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      await loadData();
      if (cancelled) return;
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  function openNewAccount() {
    setEditingAccountId(null);
    setAccountForm({ ...EMPTY_FORM, isDefault: accounts.length === 0 });
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
      if (!editingAccountId || accountForm.accessKeyId || accountForm.secretAccessKey) {
        Object.assign(body, {
          accessKeyId: accountForm.accessKeyId,
          secretAccessKey: accountForm.secretAccessKey,
          sessionToken: accountForm.sessionToken,
        });
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
    // 刪除是不可逆操作，需先取得使用者明確確認。
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
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : `開通 ${region} 失敗`);
    } finally {
      setEnablingRegion(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">帳號管理</h2>
        <p className="text-sm text-muted">管理 D1 中的 AWS 加密憑證</p>
      </div>

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
                  <div className="flex justify-end gap-1 border-t pt-3">
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

      {/* 新增／編輯帳號 */}
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

      {/* 開通區域 */}
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
    </div>
  );
}
