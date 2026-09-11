'use client'

// SSO 登入頁：點擊後導向 /api/auth/login（302 至 IdP 授權端點）。
// callback 完成後帶 session 回到主控台；失敗則回到本頁並帶 error 代碼。
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CloudCog, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@heroui/react/button";

const ERROR_MESSAGES: Record<string, string> = {
  configuration: "伺服器尚未完成 SSO 設定。",
  idp_error: "登入流程被 IdP 中止，請再試一次。",
  state_mismatch: "登入流程已逾時或狀態不符，請重新登入。",
  email_not_allowed: "此帳號未獲授權使用本主控台。",
  verification_failed: "登入驗證失敗，請再試一次。",
};

function SignInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isRedirecting, setIsRedirecting] = useState(false);

  const code = searchParams.get("error") || "";
  const errorMessage = code ? (ERROR_MESSAGES[code] || "登入失敗，請再試一次。") : "";
  const needsSetup = code === "configuration";

  function startLogin() {
    if (isRedirecting) return;
    setIsRedirecting(true);
    // 必須整頁導向：/api/auth/login 會 302 至外部 IdP，router.push 不適用
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/api/auth/login";
  }

  function clearError() {
    router.replace("/login");
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* 左側品牌面板：與主控台側邊欄同一套外觀語彙 */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-zinc-950 p-10 text-white lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              "radial-gradient(48rem 24rem at 20% -10%, rgba(59,130,246,0.35), transparent 60%), radial-gradient(40rem 20rem at 110% 110%, rgba(16,185,129,0.25), transparent 60%)",
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-white/10 backdrop-blur">
            <CloudCog aria-hidden="true" size={22} />
          </span>
          <div>
            <p className="text-lg font-semibold">AWS 主控台</p>
            <p className="text-xs text-white/60">雲端基礎設施管理</p>
          </div>
        </div>
        <div className="relative z-10 grid gap-6">
          {[
            { title: "EC2 電源管理", detail: "機器總覽即時狀態，一鍵啟動／關閉受管執行個體" },
            { title: "Wavelength 部署", detail: "初始化 Zone 資源，部署 WL EC2 與 SSH forwarder" },
            { title: "憑證集中保管", detail: "AWS 帳號金鑰加密存放於 D1，部署時自動套用" },
          ].map(item => (
            <div key={item.title} className="flex gap-3">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-400" />
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-sm text-white/60">{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="relative z-10 text-xs text-white/40">部署、電源與憑證，集中在一個主控台。</p>
      </div>

      {/* 右側登入表單 */}
      <main className="grid place-items-center px-6 py-12">
        <div className="grid w-full max-w-sm gap-6">
          <div className="grid gap-2 text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-xl bg-accent text-accent-foreground lg:hidden">
              <CloudCog aria-hidden="true" size={24} />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">登入 AWS 主控台</h1>
            <p className="text-balance text-sm text-muted">透過 SSO 驗證身分以繼續</p>
          </div>
          {errorMessage ? (
            <button type="button" onClick={clearError} className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-left text-sm text-danger">
              {errorMessage}
            </button>
          ) : null}
          {needsSetup ? (
            <a href="/setup" className="text-center text-sm underline-offset-4 hover:underline">
              前往初始設定（OOBE）
            </a>
          ) : null}
          <Button className="w-full" size="lg" isDisabled={isRedirecting} onPress={startLogin}>
            {isRedirecting ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <LogIn aria-hidden size={16} />}
            使用 SSO 登入
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
            <ShieldCheck aria-hidden="true" size={14} />
            僅允許清單內的 email 登入
          </p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <SignInContent />
    </Suspense>
  );
}
