'use client'

// /503 診斷頁：依 ?reason= 顯示可執行的修正建議。
// reason 只包含伺服器端產生的診斷代碼，不含機密資訊。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { StatusPage } from "@/components/status-page";

const REASON_MESSAGES: Record<string, string> = {
  d1_binding_missing: "Worker 缺少 DB binding，請檢查 Cloudflare 部署設定。",
  credential_encryption_key_missing: "Worker 缺少 CREDENTIAL_ENCRYPTION_KEY secret。",
  credential_encryption_key_invalid: "CREDENTIAL_ENCRYPTION_KEY 必須是 32 位元組的 Base64 值。",
  session_secret_missing: "Worker 缺少 SESSION_SECRET secret。",
  sso_schema_missing: "D1 尚未套用 SSO 設定資料表 migration。",
  sso_config_decryption_failed: "SSO 設定無法解密，請確認加密主金鑰未被更換。",
  sso_config_invalid: "D1 內的 SSO 設定格式無效。",
  sso_config_save_failed: "SSO 設定無法寫入 D1。",
  sso_config_already_exists: "SSO 已由另一個設定流程完成，請重新登入。",
  pending_sso_setup_missing: "SSO 暫存設定已過期，請重新開始設定。",
  oidc_environment_invalid: "OIDC 環境變數格式無效。",
  d1_unavailable: "目前無法讀取 D1，請稍後再試。",
  authentication_unavailable: "目前無法確認認證服務狀態。",
};

function ServiceUnavailableContent() {
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason") || "";
  const detail = REASON_MESSAGES[reason] || "認證服務目前無法使用，請稍後再試。";

  return (
    <StatusPage
      code="503"
      title="服務暫時無法使用"
      description={detail}
      showRetry
    />
  );
}

export default function ServiceUnavailablePage() {
  return (
    <Suspense>
      <ServiceUnavailableContent />
    </Suspense>
  );
}
