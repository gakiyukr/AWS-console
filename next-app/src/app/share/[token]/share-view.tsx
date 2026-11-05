'use client'

// 訪客分享頁：列出連結綁定機器的名稱、即時狀態與公網 IP，
// 每台機器一個「一鍵換 IP」按鈕，進度以 SSE 串流顯示。
// 換 IP 為 stop → start，約需 1–2 分鐘且期間服務中斷；冷卻由伺服端
// 按「連結×機器」強制，前端另以 cooldownUntil 倒數主動停用按鈕。
// 後台啟用人機驗證時，需先通過 Cap widget（PoW）才能觸發換 IP；
// 兌換憑證為一次性，每次更換後 widget 會重置待重新驗證。
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { toast } from "@heroui/react/toast";
import Script from "next/script";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Modal } from "@heroui/react/modal";
import { readDeploymentStream } from "@/lib/deployment-stream";
import { readError, readJson, toastDanger } from "@/lib/api-client";

// SSE stage 代碼 → 訪客可讀標籤（與後端 rotatePublicIp 的進度對齊）
const STAGE_LABELS: Record<string, string> = {
  pre_check: "確認執行個體狀態",
  stopping: "停止執行個體",
  waiting_stopped: "等待執行個體停止",
  starting: "啟動執行個體",
  started: "執行個體已重新啟動",
  waiting_ip: "等待新公網 IP",
  completed: "換 IP 完成",
};

// Cap widget 以 CDN 載入；內建翻譯不含 zh-TW，
// 以 11 個 data-cap-i18n-* 屬性明確指定介面文字。
const CAP_WIDGET_SRC = "https://cdn.jsdelivr.net/npm/cap-widget@latest";

const CAP_WIDGET_I18N: Record<string, string> = {
  "data-cap-i18n-initial-state": "確認你是真人",
  "data-cap-i18n-verifying-label": "正在驗證…",
  "data-cap-i18n-solved-label": "你是真人",
  "data-cap-i18n-error-label": "出錯了，請重試",
  "data-cap-i18n-troubleshooting-label": "疑難排解",
  "data-cap-i18n-wasm-disabled": "啟用 WASM 以大幅加快驗證速度",
  "data-cap-i18n-verify-aria-label": "點擊以驗證你是真人",
  "data-cap-i18n-verifying-aria-label": "正在驗證，請稍候",
  "data-cap-i18n-verified-aria-label": "已驗證",
  "data-cap-i18n-required-label": "請先驗證你是真人",
  "data-cap-i18n-error-aria-label": "發生錯誤，請重試",
};

interface CapWidgetBoxProps {
  endpoint: string
  siteKey: string
  onSolve: (token: string) => void
  onReset: () => void
}

// Cap widget 容器組件：掛載自訂元素，使用 stable ref 監聽事件，避免定時器刷新重置 widget
const CapWidgetBox = memo(function CapWidgetBox({
  endpoint,
  siteKey,
  onSolve,
  onReset,
}: CapWidgetBoxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onSolveRef = useRef(onSolve);
  const onResetRef = useRef(onReset);

  useEffect(() => {
    onSolveRef.current = onSolve;
    onResetRef.current = onReset;
  }, [onSolve, onReset]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    host.innerHTML = "";

    const widget = document.createElement("cap-widget");
    const normalizedEndpoint = endpoint.replace(/\/+$/, "");
    widget.setAttribute("endpoint", normalizedEndpoint);
    widget.setAttribute("site-key", siteKey);
    widget.setAttribute("sitekey", siteKey);
    widget.setAttribute("data-cap-api-endpoint", `${normalizedEndpoint}/${siteKey}/`);

    for (const [attribute, value] of Object.entries(CAP_WIDGET_I18N)) {
      widget.setAttribute(attribute, value);
    }
    const handleSolve = (event: Event) => {
      const token = (event as CustomEvent<{ token?: string }>).detail?.token;
      if (token) onSolveRef.current(token);
    };
    const handleReset = () => {
      onResetRef.current();
    };

    widget.addEventListener("solve", handleSolve);
    widget.addEventListener("reset", handleReset);
    widget.addEventListener("error", handleReset);
    host.appendChild(widget);

    return () => {
      widget.removeEventListener("solve", handleSolve);
      widget.removeEventListener("reset", handleReset);
      widget.removeEventListener("error", handleReset);
      widget.remove();
    };
  }, [endpoint, siteKey]);

  return <div ref={containerRef} className="flex min-h-[56px] items-center justify-center" />;
});

// 連結失效（被刪除或停用）時的畫面：與頁面 404 一致的文案
function LinkGone() {
  return (
    <div className="text-center">
      <p className="text-5xl font-bold tracking-tight">404</p>
      <p className="mt-3 text-sm text-muted">此分享連結不存在，或已被擁有者停用。</p>
    </div>
  );
}

// 狀態標籤配色：運行中強調、已停止中性、其餘（含查詢失敗）柔和
function stateBadgeVariant(state: string | null) {
  if (state === "running") return "primary" as const;
  if (state === "stopped" || state === "stopping") return "secondary" as const;
  return "soft" as const;
}

function stateLabel(state: string | null) {
  const labels: Record<string, string> = {
    running: "運行中",
    stopped: "已停止",
    pending: "啟動中",
    stopping: "停止中",
    "shutting-down": "關閉中",
    terminated: "已終止",
  };
  return state ? labels[state] || state : "未知";
}

function formatRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface ShareMachine {
  id: number
  name: string
  state: string | null
  publicIpAddress: string | null
  cooldownUntil: number | null
}

interface CaptchaConfig {
  endpoint: string
  siteKey: string
}

interface ProgressEntry {
  time: string
  message: string
}

export default function ShareView({ token, linkName }: { token: string; linkName: string }) {
  const [machines, setMachines] = useState<ShareMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [pendingMachineId, setPendingMachineId] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  // 機器 ID → 冷卻結束時間（epoch ms）；以每秒更新時鐘驅動倒數顯示
  const [cooldowns, setCooldowns] = useState<Record<number, number | null>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 人機驗證：後台開關 + 配置 + widget 產出的一次回傳憑證
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [captchaConfig, setCaptchaConfig] = useState<CaptchaConfig | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  // 換 IP 確認彈窗選取的目標機器；null 表示彈窗關閉
  const [confirmTarget, setConfirmTarget] = useState<ShareMachine | null>(null);

  const base = `/api/share/${encodeURIComponent(token)}`;

  const loadMachines = useCallback(async () => {
    const response = await fetch(`${base}/machines`);
    if (response.status === 404) {
      setGone(true);
      return;
    }
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const payload = await readJson<{
      machines?: ShareMachine[];
      captchaEnabled?: boolean;
      captcha?: CaptchaConfig | null;
    }>(response);
    const rows = payload.machines || [];
    setMachines(rows);
    setCaptchaEnabled(Boolean(payload.captchaEnabled && payload.captcha));
    setCaptchaConfig(payload.captcha || null);
    setCooldowns(Object.fromEntries(rows.map(machine => [machine.id, machine.cooldownUntil])));
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadMachines();
      } catch {
        if (!cancelled) toastDanger("載入機器狀態失敗，請重新整理頁面");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMachines]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /** 清空憑證狀態。 */
  const resetWidget = useCallback(() => {
    setCaptchaToken(null);
  }, []);

  async function refresh() {
    try {
      await loadMachines();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入機器狀態失敗");
    }
  }

  function appendProgress(message: string) {
    setProgress(previous => [
      ...previous,
      { time: new Date().toLocaleTimeString("zh-TW"), message },
    ]);
  }

  async function rotateMachine(machine: ShareMachine, token?: string | null) {
    if (pendingMachineId !== null) return;
    if (captchaEnabled && !token) {
      toastDanger("請先完成人機驗證");
      return;
    }
    setPendingMachineId(machine.id);
    setProgress([]);
    try {
      const response = await fetch(`${base}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: machine.id,
          ...(captchaEnabled && token ? { captchaToken: token } : {}),
        }),
      });
      if (response.status === 429) {
        // 冷卻中：伺服端未消費憑證，保留現有驗證結果以便冷卻後重試
        throw new Error(await readError(response));
      }
      if (!response.ok) {
        // 憑證無效或已使用等錯誤：狀態不明，重置 widget 以策安全
        resetWidget();
        throw new Error(await readError(response));
      }
      // 終態：result 為成功、error 為失敗；串流中斷或逾時一律視為失敗
      const result = await readDeploymentStream(response, {
        onProgress: appendProgress,
        stageLabels: STAGE_LABELS,
      });
      toast.success(String(result.message || "公網 IP 已更換"));
      if (typeof result.cooldownUntil === "number") {
        setCooldowns(previous => ({ ...previous, [machine.id]: result.cooldownUntil as number }));
      }
      await loadMachines();
      resetWidget();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更換 IP 失敗");
    } finally {
      setPendingMachineId(null);
    }
  }

  if (gone) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 py-12">
        <LinkGone />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      {captchaEnabled ? (
        <Script src={CAP_WIDGET_SRC} type="module" strategy="afterInteractive" />
      ) : null}

      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{linkName}</h1>
        <p className="mt-2 text-sm text-muted">
          更換公網 IP 會將機器關機再開機，約需 1–2 分鐘，期間服務會短暫中斷。
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted">
          <Loader2 aria-hidden size={20} className="mr-2 animate-spin" />
          載入中…
        </div>
      ) : machines.length === 0 ? (
        <p className="py-16 text-center text-muted">此連結尚未綁定任何機器。</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {machines.map(machine => {
            const cooldownUntil = cooldowns[machine.id] || null;
            const remainingMs = cooldownUntil ? cooldownUntil - nowMs : 0;
            const cooling = remainingMs > 0;
            const running = machine.state === "running";
            const busy = pendingMachineId !== null;
            return (
              <Card key={machine.id} className="min-w-0">
                <Card.Content className="grid grid-cols-1 gap-3 p-6">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="min-w-0 truncate text-base font-semibold" title={machine.name}>
                      {machine.name}
                    </h2>
                    <Chip variant={stateBadgeVariant(machine.state)} size="sm">
                      {stateLabel(machine.state)}
                    </Chip>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted">公網 IP</span>
                    {machine.publicIpAddress ? (
                      <button
                        type="button"
                        title="點擊複製"
                        className="font-mono text-xs underline-offset-4 hover:underline"
                        onClick={() => {
                          void navigator.clipboard?.writeText(machine.publicIpAddress!);
                          toast.success("已複製公網 IP");
                        }}
                      >
                        {machine.publicIpAddress}
                      </button>
                    ) : (
                      <span className="font-mono text-xs text-muted">—</span>
                    )}
                  </div>
                  <div className="border-t pt-3">
                    <Button
                      className="w-full"
                      isDisabled={!running || busy || cooling}
                      onPress={() => {
                        setCaptchaToken(null);
                        setConfirmTarget(machine);
                      }}
                    >
                      {pendingMachineId === machine.id ? (
                        <>
                          <Loader2 aria-hidden size={16} className="mr-2 animate-spin" />
                          換 IP 執行中…
                        </>
                      ) : cooling ? (
                        `冷卻中 ${formatRemaining(remainingMs)}`
                      ) : (
                        <>
                          <Zap aria-hidden size={16} className="mr-2" />
                          一鍵換 IP
                        </>
                      )}
                    </Button>
                    {!running && !cooling ? (
                      <p className="mt-2 text-center text-xs text-muted">
                        機器須處於運行中狀態才能更換 IP
                      </p>
                    ) : null}
                  </div>
                </Card.Content>
              </Card>
            );
          })}
        </div>
      )}

      {pendingMachineId !== null || progress.length > 0 ? (
        <Card className="mt-6">
          <Card.Content className="grid grid-cols-1 gap-3 p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">執行進度</h3>
              <Button variant="ghost" size="sm" aria-label="重新整理狀態" isDisabled={pendingMachineId !== null} onPress={refresh}>
                <RefreshCw aria-hidden size={14} className="mr-1" />
                重新整理
              </Button>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border divide-y text-xs">
              {progress.length === 0 ? (
                <p className="px-3 py-2 text-muted">正在建立連線…</p>
              ) : (
                progress.map((entry, index) => (
                  <div key={index} className="flex gap-3 px-3 py-2">
                    <span className="shrink-0 text-muted tabular-nums">{entry.time}</span>
                    <span>{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </Card.Content>
        </Card>
      ) : null}

      {/* 換 IP 確認與人機驗證彈窗 */}
      <Modal.Root
        isOpen={confirmTarget !== null}
        onOpenChange={open => {
          if (!open) {
            setConfirmTarget(null);
            setCaptchaToken(null);
          }
        }}
      >
        <Modal.Backdrop>
          <Modal.Container size="md" placement="center">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>確認更換公網 IP</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="grid gap-3">
                <p className="text-sm">
                  確定要為機器{" "}
                  <span className="font-semibold text-foreground">
                    {confirmTarget?.name}
                  </span>{" "}
                  更換公網 IP 嗎？
                </p>
                <p className="text-xs text-muted">
                  更換公網 IP 會將機器關機後重新開機，約需 1–2 分鐘，期間連線將會短暫中斷。
                </p>
                {captchaEnabled && captchaConfig ? (
                  <div className="mt-2 rounded-lg border bg-surface-subtle p-4">
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <ShieldCheck aria-hidden size={16} className="text-primary" />
                      <span>請先完成下方的人機驗證以啟用更換：</span>
                    </div>
                    <CapWidgetBox
                      endpoint={captchaConfig.endpoint}
                      siteKey={captchaConfig.siteKey}
                      onSolve={setCaptchaToken}
                      onReset={resetWidget}
                    />
                  </div>
                ) : null}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setConfirmTarget(null);
                    setCaptchaToken(null);
                  }}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  isDisabled={captchaEnabled && !captchaToken}
                  onPress={() => {
                    if (captchaEnabled && !captchaToken) return;
                    const target = confirmTarget;
                    const token = captchaToken;
                    setConfirmTarget(null);
                    setCaptchaToken(null);
                    if (target) {
                      void rotateMachine(target, token);
                    }
                  }}
                >
                  <Zap aria-hidden size={16} className="mr-2" />
                  確定更換
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </main>
  );
}
