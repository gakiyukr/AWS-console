'use client'

// SSO 登入頁：點擊後導向 /api/auth/login（302 至 IdP 授權端點）。
// callback 完成後帶 session 回到主控台；失敗則回到本頁並帶 error 代碼。
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
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
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="grid w-full max-w-sm gap-6">
        <div className="grid gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">AWS 主控台</h1>
          <p className="text-balance text-sm text-muted">透過 SSO 驗證身分以繼續</p>
        </div>
        {errorMessage ? (
          <button type="button" onClick={clearError} className="text-left text-sm text-danger">
            {errorMessage}
          </button>
        ) : null}
        {needsSetup ? (
          <a href="/setup" className="text-center text-sm underline-offset-4 hover:underline">
            前往初始設定（OOBE）
          </a>
        ) : null}
        <Button className="w-full" isDisabled={isRedirecting} onPress={startLogin}>
          {isRedirecting ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <LogIn aria-hidden size={16} />}
          使用 SSO 登入
        </Button>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <SignInContent />
    </Suspense>
  );
}
