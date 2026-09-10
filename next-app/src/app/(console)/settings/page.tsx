'use client'

// 設定：管理部署用的機器登入公鑰（新增／刪除）。
import { useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Badge } from "@heroui/react/badge";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { sshKeyTypeLabel, type SshPublicKeyOption } from "@/lib/ssh-keys";

// 尾段自由文字（email、主機名等）作為備註顯示
function keyComment(publicKey: string) {
  const parts = publicKey.trim().split(/\s+/);
  return parts.length > 2 ? parts.slice(2).join(" ") : "";
}

// D1 datetime('now') 為 UTC 且無時區標記，補成 ISO 格式再轉本地時間
function formatCreatedAt(value: string) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW");
}

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

export default function SettingsPage() {
  const [keys, setKeys] = useState<SshPublicKeyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keyForm, setKeyForm] = useState({ label: "", publicKey: "" });

  async function loadData() {
    setLoading(true);
    try {
      const response = await fetch("/api/ssh-keys");
      if (!response.ok) throw new Error("載入公鑰清單失敗");
      const payload = await response.json();
      setKeys(payload.keys);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入公鑰清單失敗");
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

  async function addKey() {
    setSaving(true);
    try {
      const response = await fetch("/api/ssh-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: keyForm.label, publicKey: keyForm.publicKey.trim() }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("SSH 公鑰已新增");
      setKeyForm({ label: "", publicKey: "" });
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "新增 SSH 公鑰失敗");
    } finally {
      setSaving(false);
    }
  }

  async function removeKey(key: SshPublicKeyOption) {
    // 刪除是不可逆操作，需先取得使用者明確確認。
    if (!window.confirm(`確定刪除公鑰「${key.label}」？已部署的執行個體不受影響。`)) {
      return;
    }
    try {
      const response = await fetch(`/api/ssh-keys/${key.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("SSH 公鑰已刪除");
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "刪除 SSH 公鑰失敗");
    }
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">設定</h2>
        <p className="text-sm text-muted">管理部署用的機器登入公鑰</p>
      </div>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound aria-hidden size={20} />
          <h3 className="text-lg font-semibold">機器登入公鑰</h3>
        </div>

        <Card>
          <Card.Content className="grid gap-4 p-6">
            <div>
              <h4 className="text-base font-semibold">新增公鑰</h4>
              <p className="text-sm text-muted">
                金鑰儲存於 D1 並可在部署時重複選用；部署後以 root 登入且停用密碼認證。
              </p>
            </div>
            <div className="grid gap-2">
              <label htmlFor="ssh-key-label" className="text-sm font-medium">名稱</label>
              <Input
                id="ssh-key-label"
                placeholder="例如： MacBook Pro"
                value={keyForm.label}
                onChange={event => setKeyForm(previous => ({ ...previous, label: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <label htmlFor="ssh-key-value" className="text-sm font-medium">公鑰內容</label>
              <textarea
                id="ssh-key-value"
                className="min-h-28 rounded-md border bg-background px-3 py-2 font-mono text-xs"
                placeholder="ssh-ed25519 AAAA... user@host"
                value={keyForm.publicKey}
                onChange={event => setKeyForm(previous => ({ ...previous, publicKey: event.target.value }))}
              />
              <p className="text-xs text-muted">支援 ssh-ed25519、ssh-rsa、ECDSA 與 FIDO2 金鑰，最多 10 行。</p>
            </div>
            <div className="flex justify-end border-t pt-4">
              <Button isDisabled={saving || !keyForm.label || !keyForm.publicKey} onPress={addKey}>
                {saving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : <Plus aria-hidden size={16} className="mr-2" />}
                新增
              </Button>
            </div>
          </Card.Content>
        </Card>

        {loading ? (
          <div className="flex py-8 text-sm text-muted">
            <Loader2 aria-hidden size={16} className="mr-2 animate-spin" />載入中...
          </div>
        ) : keys.length === 0 ? (
          <div className="border-y py-10 text-center text-sm text-muted">尚未新增任何公鑰</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {keys.map(key => (
              <Card key={key.id}>
                <Card.Content className="grid gap-3 p-6">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="text-base font-semibold">{key.label}</h4>
                      <p className="truncate font-mono text-xs text-muted">{key.publicKey}</p>
                    </div>
                    <Badge variant="secondary">{sshKeyTypeLabel(key.publicKey)}</Badge>
                  </div>
                  <div className="flex flex-col gap-1 text-xs text-muted">
                    {keyComment(key.publicKey) ? <span>備註：{keyComment(key.publicKey)}</span> : null}
                    <span>加入時間：{formatCreatedAt(key.createdAt)}</span>
                  </div>
                  <div className="flex justify-end border-t pt-3">
                    <Button variant="ghost" aria-label="刪除公鑰" onPress={() => removeKey(key)}>
                      <Trash2 aria-hidden size={16} />
                    </Button>
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
