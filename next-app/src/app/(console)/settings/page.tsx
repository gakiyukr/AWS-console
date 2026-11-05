'use client'

// 設定：SSH 公鑰庫（部署登入用）、DDNS（Cloudflare）與人機驗證（Cap）。
import { useEffect, useState } from "react";
import { Cloud, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { readError, readJson, toastDanger } from "@/lib/api-client";
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



export default function SettingsPage() {
  const [keys, setKeys] = useState<SshPublicKeyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keyForm, setKeyForm] = useState({ label: "", publicKey: "" });

  // ── DDNS（Cloudflare） ──────────────────────────────────
  const [ddns, setDdns] = useState<{ configured: boolean; zoneName: string | null; tokenHint: string | null } | null>(null);
  const [ddnsForm, setDdnsForm] = useState({ token: "", zoneName: "" });
  const [ddnsSaving, setDdnsSaving] = useState(false);

  // ── 人機驗證（Cap） ─────────────────────────────────────
  const [cap, setCap] = useState<{
    configured: boolean
    source: string | null
    endpoint: string | null
    siteKey: string | null
    secretHint: string | null
    enabled: boolean
  } | null>(null);
  const [capForm, setCapForm] = useState({ endpoint: "", siteKey: "", secret: "" });
  const [capSaving, setCapSaving] = useState(false);
  const [capToggling, setCapToggling] = useState(false);

  async function loadCap() {
    try {
      const response = await fetch("/api/captcha-settings");
      if (!response.ok) return;
      const payload = await readJson<{
        configured?: boolean
        source?: string | null
        endpoint?: string | null
        siteKey?: string | null
        secretHint?: string | null
        enabled?: boolean
      }>(response);
      setCap({
        configured: Boolean(payload.configured),
        source: payload.source || null,
        endpoint: payload.endpoint || null,
        siteKey: payload.siteKey || null,
        secretHint: payload.secretHint || null,
        enabled: Boolean(payload.enabled),
      });
      if (payload.endpoint || payload.siteKey) {
        setCapForm(previous => ({
          ...previous,
          endpoint: payload.endpoint || previous.endpoint,
          siteKey: payload.siteKey || previous.siteKey,
        }));
      }
    } catch {
      // 讀取失敗不影響其他設定
    }
  }

  async function saveCap() {
    setCapSaving(true);
    try {
      const response = await fetch("/api/captcha-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: capForm.endpoint.trim(),
          siteKey: capForm.siteKey.trim(),
          secret: capForm.secret.trim(),
        }),
      });
      const payload = await readJson<{ message?: string }>(response);
      if (!response.ok) throw new Error(await readError(response));
      toast.success(payload.message || "人機驗證設定已儲存");
      setCapForm(previous => ({ ...previous, secret: "" }));
      await loadCap();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "儲存人機驗證設定失敗");
    } finally {
      setCapSaving(false);
    }
  }

  async function removeCap() {
    if (!window.confirm("確定移除人機驗證設定？人機驗證將同時停用。")) return;
    setCapSaving(true);
    try {
      const response = await fetch("/api/captcha-settings", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("人機驗證設定已移除，人機驗證已停用");
      setCapForm({ endpoint: "", siteKey: "", secret: "" });
      await loadCap();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "移除人機驗證設定失敗");
    } finally {
      setCapSaving(false);
    }
  }

  async function toggleCap() {
    if (!cap || capToggling) return;
    setCapToggling(true);
    try {
      const response = await fetch("/api/share-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captchaEnabled: !cap.enabled }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success(cap.enabled ? "人機驗證已停用" : "人機驗證已啟用");
      await loadCap();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更新人機驗證設定失敗");
    } finally {
      setCapToggling(false);
    }
  }

  async function loadDdns() {
    try {
      const response = await fetch("/api/ddns-settings");
      if (!response.ok) return;
      const payload = await readJson<{ configured?: boolean; zoneName?: string | null; tokenHint?: string | null }>(response);
      setDdns({
        configured: Boolean(payload.configured),
        zoneName: payload.zoneName || null,
        tokenHint: payload.tokenHint || null,
      });
    } catch {
      // 讀取失敗不影響其他設定
    }
  }

  async function saveDdns() {
    setDdnsSaving(true);
    try {
      const response = await fetch("/api/ddns-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ddnsForm.token.trim(), zoneName: ddnsForm.zoneName.trim() }),
      });
      const payload = await readJson<{ message?: string }>(response);
      if (!response.ok) throw new Error(await readError(response));
      toast.success(payload.message || "DDNS 已設定");
      setDdnsForm({ token: "", zoneName: "" });
      await loadDdns();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "DDNS 設定失敗");
    } finally {
      setDdnsSaving(false);
    }
  }

  async function removeDdns() {
    if (!window.confirm("確定移除 Cloudflare DDNS 設定？已綁定的機器主機名會保留，但不再自動同步。")) return;
    setDdnsSaving(true);
    try {
      const response = await fetch("/api/ddns-settings", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("DDNS 設定已移除");
      setDdns({ configured: false, zoneName: null, tokenHint: null });
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "移除 DDNS 設定失敗");
    } finally {
      setDdnsSaving(false);
    }
  }

  async function loadData() {
    setLoading(true);
    try {
      const response = await fetch("/api/ssh-keys");
      if (!response.ok) throw new Error("載入公鑰清單失敗");
      const payload = await readJson<{ keys?: SshPublicKeyOption[] }>(response);
      setKeys(payload.keys || []);
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
      await loadDdns();
      await loadCap();
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
        <p className="text-sm text-muted">管理 SSH 公鑰與 DDNS（Cloudflare）設定</p>
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
                    <Chip variant="secondary">{sshKeyTypeLabel(key.publicKey)}</Chip>
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

      {/* DDNS（Cloudflare） */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Cloud aria-hidden size={20} />
          <h3 className="text-lg font-semibold">DDNS（Cloudflare）</h3>
          {ddns ? (
            <Chip variant={ddns.configured ? "primary" : "soft"}>
              {ddns.configured ? "已設定" : "未設定"}
            </Chip>
          ) : null}
        </div>
        <Card>
          <Card.Content className="grid gap-4 p-6">
            <p className="text-sm text-muted">
              設定後可在 EC2 機器上綁定主機名；每次換 IP／開關機會自動檢查並更新 Cloudflare 的 DNS A 記錄。
              Token 需要 Zone.DNS Edit 權限（記錄一律 DNS-only，不走代理）。
            </p>
            {ddns?.configured ? (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span>Zone：<span className="font-medium">{ddns.zoneName}</span></span>
                  <span className="text-muted">Token ····{ddns.tokenHint}</span>
                </div>
                <div className="flex justify-end border-t pt-3">
                  <Button variant="danger" isDisabled={ddnsSaving} onPress={removeDdns}>
                    {ddnsSaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : <Trash2 aria-hidden size={16} className="mr-2" />}
                    移除設定
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <label htmlFor="ddns-token" className="text-sm font-medium">API Token</label>
                  <Input
                    id="ddns-token"
                    type="password"
                    placeholder="Cloudflare API Token（Zone.DNS Edit）"
                    value={ddnsForm.token}
                    onChange={event => setDdnsForm(previous => ({ ...previous, token: event.target.value }))}
                  />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="ddns-zone" className="text-sm font-medium">Zone 名稱</label>
                  <Input
                    id="ddns-zone"
                    placeholder="例如： example.com"
                    value={ddnsForm.zoneName}
                    onChange={event => setDdnsForm(previous => ({ ...previous, zoneName: event.target.value }))}
                  />
                </div>
                <div className="flex justify-end border-t pt-3">
                  <Button isDisabled={ddnsSaving || !ddnsForm.token || !ddnsForm.zoneName} onPress={saveDdns}>
                    {ddnsSaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                    驗證並儲存
                  </Button>
                </div>
              </div>
            )}
          </Card.Content>
        </Card>
      </section>

      {/* 人機驗證（Cap） */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden size={20} />
          <h3 className="text-lg font-semibold">人機驗證（Cap）</h3>
          {cap ? (
            <Chip variant={cap.enabled ? "primary" : "soft"}>
              {cap.enabled ? "已啟用" : "未啟用"}
            </Chip>
          ) : null}
        </div>
        <Card>
          <Card.Content className="grid gap-4 p-6">
            <p className="text-sm text-muted">
              啟用後分享頁的訪客須通過 Cap（工作量證明）才能一鍵換 IP。支援自建 Cap（
              <a
                href="https://trycap.dev/zh/guide/"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline hover:opacity-80"
              >
                trycap.dev
              </a>
              ）實例或託管服務。設定加密存於 D1，優先於環境變量。
            </p>
            {cap ? (
              <div className="grid gap-4">
                <div className="grid gap-3 rounded-lg border bg-surface-subtle p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-4">
                    <span>
                      實例地址（Endpoint）：
                      {cap.endpoint ? (
                        <span className="font-mono font-medium">{cap.endpoint}</span>
                      ) : (
                        <span className="text-danger">未配置</span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <span>
                      站點公鑰（Site Key）：
                      {cap.siteKey ? (
                        <span className="font-mono font-medium">{cap.siteKey}</span>
                      ) : (
                        <span className="text-danger">未配置</span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <span>
                      驗證私鑰（Secret Key）：
                      {cap.secretHint ? (
                        <>
                          <span className="font-mono">{cap.secretHint}</span>
                          <span className="text-muted">（來源：{cap.source === "db" ? "後臺設定" : "環境變量"}）</span>
                        </>
                      ) : (
                        <span className="text-danger">未配置</span>
                      )}
                    </span>
                  </div>
                </div>

                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <label htmlFor="cap-endpoint" className="text-sm font-medium">
                      實例地址（Endpoint URL）
                    </label>
                    <Input
                      id="cap-endpoint"
                      type="url"
                      placeholder="例如：https://cap.example.com"
                      value={capForm.endpoint}
                      onChange={event => setCapForm(previous => ({ ...previous, endpoint: event.target.value }))}
                    />
                  </div>

                  <div className="grid gap-2">
                    <label htmlFor="cap-site-key" className="text-sm font-medium">
                      站點公鑰（Site Key）
                    </label>
                    <Input
                      id="cap-site-key"
                      placeholder="例如：k_site_..."
                      value={capForm.siteKey}
                      onChange={event => setCapForm(previous => ({ ...previous, siteKey: event.target.value }))}
                    />
                  </div>

                  <div className="grid gap-2">
                    <label htmlFor="cap-secret" className="text-sm font-medium">
                      驗證私鑰（Secret Key）{cap.secretHint ? "（選填，留空即保留目前密鑰）" : ""}
                    </label>
                    <Input
                      id="cap-secret"
                      type="password"
                      placeholder={cap.secretHint ? "留空即保留現有密鑰" : "Cap 後台產生的 Secret Key"}
                      value={capForm.secret}
                      onChange={event => setCapForm(previous => ({ ...previous, secret: event.target.value }))}
                    />
                  </div>
                </div>

                <div className="flex justify-between border-t pt-3">
                  {cap.source === "db" ? (
                    <Button variant="danger" isDisabled={capSaving} onPress={removeCap}>
                      {capSaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : <Trash2 aria-hidden size={16} className="mr-2" />}
                      移除設定
                    </Button>
                  ) : <span />}
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      isDisabled={capToggling || (!cap.configured && !cap.enabled)}
                      onPress={toggleCap}
                    >
                      {capToggling ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                      {cap.enabled ? "停用人機驗證" : "啟用人機驗證"}
                    </Button>
                    <Button
                      isDisabled={capSaving || !capForm.endpoint || !capForm.siteKey || (!capForm.secret && !cap.secretHint)}
                      onPress={saveCap}
                    >
                      {capSaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                      儲存設定
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">載入中…</p>
            )}
          </Card.Content>
        </Card>
      </section>
    </div>
  );
}
