'use client'

// 設定：SSH 公鑰庫（部署登入用）、DDNS（Cloudflare）與人機驗證（Cap）。
import { useCallback, useEffect, useState } from "react";
import { Activity, Cloud, Eye, EyeOff, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { sshKeyTypeLabel, type SshPublicKeyOption } from "@/lib/ssh-keys";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CustomSelect } from "@/components/ui/select";

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

  // ── 人機驗證（多渠道備援：Cap、Turnstile、hCaptcha） ────
  interface CaptchaProviderState {
    provider: "cap" | "turnstile" | "hcaptcha"
    name: string
    enabled: boolean
    configured: boolean
    endpoint: string
    siteKey: string
    secretHint: string | null
    source: string | null
  }

  const [captchaGlobalEnabled, setCaptchaGlobalEnabled] = useState(false);
  const [captchaProviders, setCaptchaProviders] = useState<CaptchaProviderState[]>([]);
  const [activeCaptchaTab, setActiveCaptchaTab] = useState<"cap" | "turnstile" | "hcaptcha">("cap");
  const [providerForms, setProviderForms] = useState<Record<string, { endpoint: string; siteKey: string; secret: string; enabled: boolean }>>({
    cap: { endpoint: "", siteKey: "", secret: "", enabled: true },
    turnstile: { endpoint: "", siteKey: "", secret: "", enabled: true },
    hcaptcha: { endpoint: "", siteKey: "", secret: "", enabled: true },
  });
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [captchaToggling, setCaptchaToggling] = useState(false);
  const [captchaLoading, setCaptchaLoading] = useState(true);

  // ── API 出口代理（HTTP / HTTPS / SOCKS5） ────────────────
  interface ProxyFormState {
    enabled: boolean
    protocol: "http" | "https" | "socks5"
    host: string
    port: number | string
    username: string
    password: string
  }

  interface ProxyTestResult {
    ok: boolean
    latencyMs?: number
    exitIp?: string
    error?: string
  }

  const [proxyForm, setProxyForm] = useState<ProxyFormState>({
    enabled: false,
    protocol: "http",
    host: "",
    port: 7890,
    username: "",
    password: "",
  });
  const [proxyPasswordHint, setProxyPasswordHint] = useState<string | null>(null);
  const [proxyLoading, setProxyLoading] = useState(true);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const [showProxyPassword, setShowProxyPassword] = useState(false);

  const loadCaptcha = useCallback(async () => {
    try {
      const response = await fetch("/api/captcha-settings");
      if (!response.ok) return;
      const payload = await readJson<{
        enabled?: boolean
        providers?: CaptchaProviderState[]
      }>(response);
      setCaptchaGlobalEnabled(Boolean(payload.enabled));
      if (payload.providers) {
        setCaptchaProviders(payload.providers);
        setProviderForms(previous => {
          const next = { ...previous };
          for (const item of payload.providers || []) {
            next[item.provider] = {
              endpoint: item.endpoint || previous[item.provider]?.endpoint || "",
              siteKey: item.siteKey || previous[item.provider]?.siteKey || "",
              secret: "",
              enabled: Boolean(item.enabled),
            };
          }
          return next;
        });
      }
    } catch {
      // 讀取失敗不影響其他設定
    } finally {
      setCaptchaLoading(false);
    }
  }, []);

  async function saveProviderConfig(providerId: string) {
    const form = providerForms[providerId];
    if (!form) return;
    setSavingProvider(providerId);
    try {
      const response = await fetch("/api/captcha-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          enabled: form.enabled,
          endpoint: form.endpoint.trim(),
          siteKey: form.siteKey.trim(),
          secret: form.secret.trim(),
        }),
      });
      const payload = await readJson<{ message?: string }>(response);
      if (!response.ok) throw new Error(await readError(response));
      toast.success(payload.message || "設定已儲存");
      setProviderForms(previous => ({
        ...previous,
        [providerId]: { ...previous[providerId], secret: "" },
      }));
      await loadCaptcha();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "儲存設定失敗");
    } finally {
      setSavingProvider(null);
    }
  }

  async function removeProviderConfig(providerId: string) {
    if (!window.confirm(`確定移除 ${providerId} 設定？`)) return;
    setSavingProvider(providerId);
    try {
      const response = await fetch(`/api/captcha-settings?provider=${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("設定已移除");
      await loadCaptcha();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "移除設定失敗");
    } finally {
      setSavingProvider(null);
    }
  }

  async function toggleGlobalCaptcha() {
    if (captchaToggling) return;
    setCaptchaToggling(true);
    try {
      const response = await fetch("/api/share-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captchaEnabled: !captchaGlobalEnabled }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success(captchaGlobalEnabled ? "分享頁人機驗證已停用" : "分享頁人機驗證已啟用");
      await loadCaptcha();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更新人機驗證開關失敗");
    } finally {
      setCaptchaToggling(false);
    }
  }

  const loadDdns = useCallback(async () => {
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
  }, []);

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

  const loadData = useCallback(async () => {
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
  }, []);

  const loadProxy = useCallback(async () => {
    setProxyLoading(true);
    try {
      const response = await fetch("/api/proxy-settings");
      if (!response.ok) return;
      const data = await readJson<{
        configured: boolean
        enabled: boolean
        protocol: "http" | "https" | "socks5"
        host: string
        port: number
        username: string
        passwordHint: string | null
      }>(response);
      setProxyPasswordHint(data.passwordHint || null);
      setProxyForm({
        enabled: Boolean(data.enabled),
        protocol: data.protocol || "http",
        host: data.host || "",
        port: data.port || 7890,
        username: data.username || "",
        password: "",
      });
    } catch {
      // 讀取失敗不阻礙主流程
    } finally {
      setProxyLoading(false);
    }
  }, []);

  async function saveProxy() {
    setProxySaving(true);
    try {
      const portNum = Number(proxyForm.port);
      if (!proxyForm.host.trim()) {
        throw new Error("請輸入代理伺服器地址（Host）");
      }
      if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error("代理端口必須介於 1 到 65535 之間");
      }
      const response = await fetch("/api/proxy-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: proxyForm.enabled,
          protocol: proxyForm.protocol,
          host: proxyForm.host.trim(),
          port: portNum,
          username: proxyForm.username.trim(),
          password: proxyForm.password,
        }),
      });
      const payload = await readJson<{ message?: string }>(response);
      if (!response.ok) throw new Error(await readError(response));
      toast.success(payload.message || "代理設定已儲存");
      await loadProxy();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "儲存代理設定失敗");
    } finally {
      setProxySaving(false);
    }
  }

  async function testProxy() {
    setProxyTesting(true);
    setProxyTestResult(null);
    try {
      const portNum = Number(proxyForm.port);
      if (!proxyForm.host.trim()) {
        throw new Error("請輸入代理伺服器地址（Host）");
      }
      if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error("代理端口必須介於 1 到 65535 之間");
      }
      const response = await fetch("/api/proxy-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: proxyForm.protocol,
          host: proxyForm.host.trim(),
          port: portNum,
          username: proxyForm.username.trim(),
          password: proxyForm.password,
        }),
      });
      const data = await readJson<ProxyTestResult>(response);
      setProxyTestResult(data);
      if (data.ok) {
        toast.success(`連線成功！出口 IP: ${data.exitIp}${data.latencyMs != null ? ` (${data.latencyMs}ms)` : ""}`);
      } else {
        toastDanger(data.error || "連線測試失敗");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "代理測試出錯";
      setProxyTestResult({ ok: false, error: msg });
      toastDanger(msg);
    } finally {
      setProxyTesting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      await loadData();
      if (cancelled) return;
      await loadDdns();
      await loadCaptcha();
      await loadProxy();
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadData, loadDdns, loadCaptcha, loadProxy]);

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
              <Label htmlFor="ssh-key-value" className="text-sm font-medium">公鑰內容</Label>
              <Textarea
                id="ssh-key-value"
                className="min-h-28 font-mono text-xs"
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

      {/* 人機驗證（多渠道備援：Cap、Cloudflare Turnstile、hCaptcha） */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden size={20} />
          <h3 className="text-lg font-semibold">人機驗證（多渠道備援）</h3>
          <Chip variant={captchaGlobalEnabled ? "primary" : "soft"}>
            {captchaGlobalEnabled ? "已啟用" : "未啟用"}
          </Chip>
        </div>
        <Card>
          <Card.Content className="grid gap-4 p-6">
            <p className="text-sm text-muted">
              啟用後分享頁訪客須通過人機驗證才能換 IP。支援同時配置 Cap、Cloudflare Turnstile 與 hCaptcha 作為備援；若訪客端某服務異常，可於彈窗一鍵切換渠道。
            </p>

            {/* 全域開關操作列 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-divider bg-surface-subtle p-3">
              <div className="space-y-0.5">
                <Label htmlFor="captcha-global-switch" className="text-sm font-medium cursor-pointer">
                  分享頁人機驗證總閘門
                </Label>
                <p className="text-xs text-muted">
                  {captchaProviders.filter(p => p.configured && p.enabled).length > 0
                    ? `已啟用備援渠道（${captchaProviders.filter(p => p.configured && p.enabled).map(p => p.name).join("、")}）`
                    : "目前無已啟用且配置完成的渠道"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {captchaToggling ? <Loader2 aria-hidden size={16} className="animate-spin text-muted" /> : null}
                <Switch
                  id="captcha-global-switch"
                  checked={captchaGlobalEnabled}
                  disabled={captchaToggling || (!captchaGlobalEnabled && captchaProviders.filter(p => p.configured && p.enabled).length === 0)}
                  onCheckedChange={() => void toggleGlobalCaptcha()}
                />
              </div>
            </div>

            {/* 渠道切換分頁 */}
            <div className="flex flex-wrap items-center gap-2 border-b pb-3">
              {[
                { id: "cap", label: "Cap (trycap.dev)" },
                { id: "turnstile", label: "Cloudflare Turnstile" },
                { id: "hcaptcha", label: "hCaptcha" },
              ].map(tab => {
                const current = captchaProviders.find(p => p.provider === tab.id);
                const isSelected = activeCaptchaTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveCaptchaTab(tab.id as "cap" | "turnstile" | "hcaptcha")}
                    className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      isSelected
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "bg-surface-subtle hover:bg-surface text-muted hover:text-foreground"
                    }`}
                  >
                    <span>{tab.label}</span>
                    {current ? (
                      <span className={`inline-block h-2 w-2 rounded-full ${
                        current.configured && current.enabled
                          ? (isSelected ? "bg-white" : "bg-success")
                          : current.configured
                          ? (isSelected ? "bg-white/60" : "bg-warning")
                          : (isSelected ? "bg-white/40" : "bg-danger")
                      }`} />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* 當前選定渠道設定表單 */}
            {captchaLoading ? (
              <p className="text-sm text-muted">載入中…</p>
            ) : (() => {
              const current = captchaProviders.find(p => p.provider === activeCaptchaTab);
              const form = providerForms[activeCaptchaTab] || { endpoint: "", siteKey: "", secret: "", enabled: true };
              const isSaving = savingProvider === activeCaptchaTab;
              return (
                <div className="grid gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <Switch
                        id={`captcha-enable-${activeCaptchaTab}`}
                        checked={form.enabled}
                        onCheckedChange={checked => setProviderForms(prev => ({
                          ...prev,
                          [activeCaptchaTab]: { ...prev[activeCaptchaTab], enabled: checked }
                        }))}
                      />
                      <Label htmlFor={`captcha-enable-${activeCaptchaTab}`} className="text-sm font-medium cursor-pointer">
                        啟用 {current?.name || activeCaptchaTab} 渠道
                      </Label>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <span>狀態：</span>
                      <Chip variant={current?.configured ? "primary" : "soft"}>
                        {current?.configured ? (current.enabled ? "已配置且啟用" : "已配置但未啟用") : "未配置"}
                      </Chip>
                    </div>
                  </div>

                  {current?.configured ? (
                    <div className="grid gap-2 rounded-lg border bg-surface-subtle p-3 text-xs text-muted">
                      {activeCaptchaTab === "cap" && current.endpoint ? (
                        <div>實例網址：<span className="font-mono text-foreground">{current.endpoint}</span></div>
                      ) : null}
                      <div>Site Key：<span className="font-mono text-foreground">{current.siteKey}</span></div>
                      <div>Secret Key：<span className="font-mono text-foreground">{current.secretHint}</span> {current.source ? `（來源：${current.source === "db" ? "後臺設定" : "環境變量"}）` : ""}</div>
                    </div>
                  ) : null}

                  <div className="grid gap-3">
                    {activeCaptchaTab === "cap" ? (
                      <div className="grid gap-1.5">
                        <label className="text-xs font-medium">實例地址（Endpoint URL）</label>
                        <Input
                          type="url"
                          placeholder="例如：https://cap.example.com"
                          value={form.endpoint}
                          onChange={e => setProviderForms(prev => ({
                            ...prev,
                            cap: { ...prev.cap, endpoint: e.target.value }
                          }))}
                        />
                      </div>
                    ) : null}

                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium">站點公鑰（Site Key）</label>
                      <Input
                        placeholder={activeCaptchaTab === "turnstile" ? "例如：0x4AAAAAA..." : activeCaptchaTab === "hcaptcha" ? "例如：10000000-ffff-ffff-ffff-000000000001" : "例如：k_site_..."}
                        value={form.siteKey}
                        onChange={e => setProviderForms(prev => ({
                          ...prev,
                          [activeCaptchaTab]: { ...prev[activeCaptchaTab], siteKey: e.target.value }
                        }))}
                      />
                    </div>

                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium">
                        驗證私鑰（Secret Key）{current?.secretHint ? "（選填，留空即保留目前密鑰）" : ""}
                      </label>
                      <Input
                        type="password"
                        placeholder={current?.secretHint ? "留空即保留現有密鑰" : "Secret Key"}
                        value={form.secret}
                        onChange={e => setProviderForms(prev => ({
                          ...prev,
                          [activeCaptchaTab]: { ...prev[activeCaptchaTab], secret: e.target.value }
                        }))}
                      />
                    </div>
                  </div>

                  <div className="flex justify-between border-t pt-3">
                    {current?.source === "db" ? (
                      <Button
                        variant="danger"
                        isDisabled={isSaving}
                        onPress={() => removeProviderConfig(activeCaptchaTab)}
                      >
                        {isSaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : <Trash2 aria-hidden size={16} className="mr-2" />}
                        移除設定
                      </Button>
                    ) : <span />}

                    <Button
                      isDisabled={
                        isSaving ||
                        (activeCaptchaTab === "cap" && !form.endpoint) ||
                        !form.siteKey ||
                        (!form.secret && !current?.secretHint)
                      }
                      onPress={() => saveProviderConfig(activeCaptchaTab)}
                    >
                      {isSaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                      儲存 {current?.name || activeCaptchaTab} 設定
                    </Button>
                  </div>
                </div>
              );
            })()}
          </Card.Content>
        </Card>
      </section>

      {/* API 出口代理（HTTP / HTTPS / SOCKS5） */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Activity aria-hidden size={20} />
          <h3 className="text-lg font-semibold">API 出口代理（HTTP / SOCKS5）</h3>
          <Chip variant={proxyForm.enabled ? "primary" : "soft"}>
            {proxyForm.enabled ? "已啟用" : "未啟用"}
          </Chip>
        </div>
        <Card>
          <Card.Content className="grid gap-4 p-6">
            <p className="text-sm text-muted">
              配置外部 API 請求（AWS EC2 / Lightsail、Oracle Cloud OCI、Cloudflare DDNS、人機驗證）的統一出口代理。當伺服器無法直連雲端 API 或需固定對外 IP 時使用。
            </p>

            {/* 啟用開關 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-divider bg-surface-subtle p-3">
              <div className="space-y-0.5">
                <Label htmlFor="proxy-enabled-switch" className="text-sm font-medium cursor-pointer">
                  啟用 API 出口代理
                </Label>
                <p className="text-xs text-muted">
                  關閉時所有 API 呼叫均直連；開啟後將自動透過下方代理節點連線。
                </p>
              </div>
              <Switch
                id="proxy-enabled-switch"
                checked={proxyForm.enabled}
                onCheckedChange={checked => setProxyForm(prev => ({ ...prev, enabled: checked }))}
              />
            </div>

            {proxyLoading ? (
              <p className="text-sm text-muted">載入中…</p>
            ) : (
              <div className="grid gap-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium">通訊協定（Protocol）</label>
                    <CustomSelect
                      value={proxyForm.protocol}
                      onChange={val => setProxyForm(prev => ({ ...prev, protocol: val as "http" | "https" | "socks5" }))}
                      options={[
                        { value: "http", label: "HTTP" },
                        { value: "https", label: "HTTPS (CONNECT)" },
                        { value: "socks5", label: "SOCKS5" },
                      ]}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium">伺服器地址（Host / IP）</label>
                    <Input
                      placeholder="例如：127.0.0.1 或 proxy.example.com"
                      value={proxyForm.host}
                      onChange={e => setProxyForm(prev => ({ ...prev, host: e.target.value }))}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium">連接埠（Port）</label>
                    <Input
                      type="number"
                      placeholder="例如：7890"
                      value={String(proxyForm.port)}
                      onChange={e => setProxyForm(prev => ({ ...prev, port: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium">帳號（Username，選填）</label>
                    <Input
                      placeholder="無驗證可留空"
                      value={proxyForm.username}
                      onChange={e => setProxyForm(prev => ({ ...prev, username: e.target.value }))}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium">
                      密碼（Password，選填）{proxyPasswordHint ? `（已配置：${proxyPasswordHint}，留空則保留）` : ""}
                    </label>
                    <div className="relative">
                      <Input
                        type={showProxyPassword ? "text" : "password"}
                        placeholder={proxyPasswordHint ? "留空即保留目前密碼" : "無驗證可留空"}
                        value={proxyForm.password}
                        onChange={e => setProxyForm(prev => ({ ...prev, password: e.target.value }))}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        aria-label={showProxyPassword ? "隱藏密碼" : "顯示密碼"}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1 transition-colors"
                        onClick={() => setShowProxyPassword(prev => !prev)}
                      >
                        {showProxyPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 測試結果卡片 */}
                {proxyTestResult ? (
                  <div
                    className={`rounded-lg border p-3 text-sm flex items-start gap-2 ${
                      proxyTestResult.ok
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
                    }`}
                  >
                    <Activity size={18} className="shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <p className="font-semibold">
                        {proxyTestResult.ok ? "連線測試成功" : "連線測試失敗"}
                      </p>
                      {proxyTestResult.ok ? (
                        <p className="text-xs opacity-90">
                          出口 IP: <span className="font-mono font-bold">{proxyTestResult.exitIp}</span>
                          {proxyTestResult.latencyMs != null ? ` · 延遲: ${proxyTestResult.latencyMs} ms` : ""}
                        </p>
                      ) : (
                        <p className="text-xs opacity-90">
                          錯誤訊息：{proxyTestResult.error || "連線逾時或代理拒絕連線"}
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                  <Button
                    variant="secondary"
                    isDisabled={proxyTesting || !proxyForm.host}
                    onPress={testProxy}
                  >
                    {proxyTesting ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : <Activity aria-hidden size={16} className="mr-2" />}
                    測試代理連線
                  </Button>

                  <Button
                    isDisabled={proxySaving || !proxyForm.host}
                    onPress={saveProxy}
                  >
                    {proxySaving ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : null}
                    儲存代理設定
                  </Button>
                </div>
              </div>
            )}
          </Card.Content>
        </Card>
      </section>
    </div>
  );
}
