'use client'

// OOBE 初始設定：填入 IdP 資訊與綁定 email → 測試連線 → 走一次真實
// SSO 驗證（回頭 email 必須與綁定 email 一致）→ 設定存入 D1 後直接
// 進入主控台。設定完成後本頁會被導回 /login，重新設定需清除 D1 的
// sso_config（見 README）。
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, PlugZap, ShieldCheck } from "lucide-react";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";

interface SetupForm {
  email: string
  issuer: string
  authorizationUrl: string
  tokenUrl: string
  jwksUrl: string
  clientId: string
  setupToken: string
  clientSecret: string
}

const INITIAL_FORM: SetupForm = {
  setupToken: "",
  email: "",
  issuer: "",
  authorizationUrl: "",
  tokenUrl: "",
  jwksUrl: "",
  clientId: "",
  clientSecret: "",
};

const CALLBACK_ERRORS: Record<string, string> = {
  email_mismatch: "SSO 回傳的 email 與綁定 email 不符，請確認登入的 IdP 帳號後再試。",
  save_failed: "SSO 驗證成功，但設定儲存失敗，請重試。",
  state_mismatch: "設定流程已逾時，請重新填寫並驗證。",
  idp_error: "IdP 端中止了驗證流程，請再試一次。",
  verification_failed: "SSO 驗證失敗，請檢查設定後再試。",
  configuration: "設定內容無效，請檢查後再試。",
};

function systemFailureReason(status: number, reason: unknown): string {
  return status === 503 && reason !== "setup_token_missing"
    ? (typeof reason === "string" ? reason : "authentication_unavailable")
    : "";
}

function SetupContent() {
  const router = useRouter();
  // callback 的錯誤訊息由 URL 參數推導，不在 effect 內以 setState 回填
  const searchParams = useSearchParams();
  const callbackCode = searchParams.get("error") || "";
  const callbackError = callbackCode
    ? (CALLBACK_ERRORS[callbackCode] || "設定失敗，請再試一次。")
    : "";
  const [form, setForm] = useState<SetupForm>(INITIAL_FORM);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean, message: string } | null>(null);
  const [testedOk, setTestedOk] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 表單任何欄位變更後，測試連線結果即失效，須重測
  function updateField<K extends keyof SetupForm>(key: K, value: string) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setTestedOk(false);
    setTestResult(null);
  }

  const canSubmit = Boolean(
    form.email && form.setupToken && form.clientId && form.clientSecret
    && (form.issuer || (form.authorizationUrl && form.tokenUrl && form.jwksUrl)),
  );

  async function testConnection() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const { setupToken, ...setupConfig } = form;
      const response = await fetch("/api/setup/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Setup-Token": setupToken,
        },
        body: JSON.stringify(setupConfig),
      });
      const body = await response.json() as {
        ok?: boolean
        reason?: string
        issuer?: string
        error?: string
      };
      if (systemFailureReason(response.status, body.reason)) {
        router.push(`/503?reason=${encodeURIComponent(body.reason ?? "")}`);
        return;
      }
      setTestResult(
        body.ok
          ? { ok: true, message: `連線成功，IdP：${body.issuer}` }
          : { ok: false, message: body.error || "連線失敗" },
      );
      setTestedOk(Boolean(body.ok));
    } catch {
      setTestResult({ ok: false, message: "連線失敗" });
      setTestedOk(false);
    } finally {
      setTesting(false);
    }
  }

  async function startVerification() {
    if (starting || !testedOk) return;
    setStarting(true);
    try {
      const { setupToken, ...setupConfig } = form;
      const response = await fetch("/api/setup/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Setup-Token": setupToken,
        },
        body: JSON.stringify(setupConfig),
      });
      const body = await response.json() as {
        reason?: string
        error?: string
        redirectUrl?: string
      };
      if (systemFailureReason(response.status, body.reason)) {
        router.push(`/503?reason=${encodeURIComponent(body.reason ?? "")}`);
        return;
      }
      if (!response.ok) {
        throw new Error(body.error || "無法啟動 SSO 驗證");
      }
      window.location.href = body.redirectUrl ?? "/";
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "無法啟動 SSO 驗證");
      setStarting(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="grid w-full max-w-lg gap-6">
        <div className="grid gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">歡迎使用 AWS 主控台</h1>
          <p className="text-balance text-sm text-muted">
            首次執行初始設定：綁定你的 SSO 帳號，完成後即可進入主控台
          </p>
        </div>

        <Card>
          <Card.Content className="grid gap-4 p-6">
            <div className="grid gap-2">
              <label htmlFor="setup-access-token" className="text-sm font-medium">Setup Token</label>
              <Input
                id="setup-access-token"
                type="password"
                placeholder="Worker 的 SETUP_TOKEN"
                autoComplete="off"
                disabled={testing || starting}
                value={form.setupToken}
                onChange={(event) => updateField("setupToken", event.target.value)}
              />
              <p className="text-xs text-muted">
                部署時設定於 Worker secrets；至少 32 bytes，僅用於授權首次設定，不會寫入 D1。
              </p>
            </div>

            <div className="grid gap-2">
              <label htmlFor="setup-email" className="text-sm font-medium">綁定 email</label>
              <Input
                id="setup-email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                disabled={starting}
                value={form.email}
                onChange={(event) => updateField("email", event.target.value)}
              />
              <p className="text-xs text-muted">
                完成驗證後，僅此 email 能登入主控台；需與 IdP 回傳的 email 一致。
              </p>
            </div>

            <div className="grid gap-2">
              <label htmlFor="setup-issuer" className="text-sm font-medium">IdP Issuer URL</label>
              <Input
                id="setup-issuer"
                placeholder="https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<AUD>"
                autoComplete="off"
                disabled={starting}
                value={form.issuer}
                onChange={(event) => updateField("issuer", event.target.value)}
              />
              <p className="text-xs text-muted">
                IdP 頁面顯示的 Issuer / Discovery URL。Cloudflare Access 的最後一段是
                <span className="font-mono"> AUD</span>，不是 Client ID。
              </p>
              <button
                type="button"
                className="text-left text-xs text-muted underline-offset-4 hover:underline"
                onClick={() => setShowAdvanced((value) => !value)}
              >
                {showAdvanced ? "收起明確端點設定" : "discovery 無效？改填 IdP 提供的三個明確端點"}
              </button>
            </div>

            {showAdvanced ? (
              <div className="grid gap-2 rounded-md border p-3">
                <p className="text-xs text-muted">
                  Cloudflare Access 的 SaaS 應用程式頁面會直接列出這三個端點；填齊後跳過 discovery（Issuer 仍須填寫）。
                </p>
                <div className="grid gap-2">
                  <label htmlFor="setup-authz" className="text-sm font-medium">授權端點</label>
                  <Input id="setup-authz" placeholder="https://.../authorization" autoComplete="off" disabled={starting} value={form.authorizationUrl} onChange={(event) => updateField("authorizationUrl", event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="setup-token" className="text-sm font-medium">Token 端點</label>
                  <Input id="setup-token" placeholder="https://.../token" autoComplete="off" disabled={starting} value={form.tokenUrl} onChange={(event) => updateField("tokenUrl", event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="setup-jwks" className="text-sm font-medium">JWKS URL</label>
                  <Input id="setup-jwks" placeholder="https://.../jwks" autoComplete="off" disabled={starting} value={form.jwksUrl} onChange={(event) => updateField("jwksUrl", event.target.value)} />
                </div>
              </div>
            ) : null}

            <div className="grid gap-2">
              <label htmlFor="setup-client-id" className="text-sm font-medium">Client ID</label>
              <Input id="setup-client-id" autoComplete="off" disabled={starting} value={form.clientId} onChange={(event) => updateField("clientId", event.target.value)} />
            </div>
            <div className="grid gap-2">
              <label htmlFor="setup-client-secret" className="text-sm font-medium">Client Secret</label>
              <Input
                id="setup-client-secret"
                type="password"
                placeholder="IdP 提供的 Client Secret"
                autoComplete="new-password"
                disabled={starting}
                value={form.clientSecret}
                onChange={(event) => updateField("clientSecret", event.target.value)}
              />
            </div>

            {callbackError ? <p className="text-sm text-danger">{callbackError}</p> : null}
            {testResult ? (
              <p className={testResult.ok ? "text-sm text-success" : "text-sm text-danger"}>
                {testResult.message}
              </p>
            ) : null}

            <div className="grid gap-2">
              <Button variant="secondary" isDisabled={testing || starting || !canSubmit} onPress={testConnection}>
                {testing ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <PlugZap aria-hidden size={16} />}
                測試連線
              </Button>
              <Button
                isDisabled={testing || starting || !testedOk}
                onPress={startVerification}
              >
                {starting ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <ShieldCheck aria-hidden size={16} />}
                開始 SSO 驗證
              </Button>
              <p className="text-xs text-muted">
                需先通過測試連線；將導向 IdP 完成一次登入，回頭的 email 與綁定 email 一致時設定才會生效。
              </p>
            </div>
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}

export default function SetupPage() {
  return (
    <Suspense>
      <SetupContent />
    </Suspense>
  );
}
