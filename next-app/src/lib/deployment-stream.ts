// 部署 SSE 串流讀取（EC2 與 Wavelength 兩頁共用）：
// progress 事件送入進度列，result／error 為終態；串流結束仍未收到終態
// 事件即視為連線中斷，絕不可當成部署成功。

/**
 * 閒置逾時（毫秒）：部署流程本身可能持續數分鐘（等待狀態檢查、cloud-init），
 * 因此不能以總時長判斷逾時。改以「連續多久沒有任何事件」為準——後端在每個
 * 階段轉換都會推送 progress，只要連線仍活著就會持續有資料；靜默超過此值
 * 即判定連線已斷（中間代理悄悄切斷、Worker 被平台終止等情況都不會送出 FIN，
 * 沒有逾時的話 UI 會永遠停在「部署流程執行中」）。
 */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

export interface DeploymentStreamHandlers {
  /** 每個 progress 事件呼叫一次，message 為已翻譯的階段名稱 */
  onProgress: (message: string, details?: Record<string, unknown>) => void
  /** SSE 事件名稱 → 階段代碼的繁中標籤對照表 */
  stageLabels: Record<string, string>
}

/** 解析單一 SSE 事件區塊，回傳事件名稱與 JSON payload */
function parseEventBlock(block: string): {
  eventName: string
  payload: Record<string, unknown> & { stage?: string; error?: string; message?: string }
} {
  const lines = block.split("\n");
  const eventName = lines.find(line => line.startsWith("event: "))?.slice(7) || "message";
  const dataText = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n") || "{}";
  return {
    eventName,
    payload: JSON.parse(dataText) as Record<string, unknown> & { stage?: string; error?: string; message?: string },
  };
}

export async function readDeploymentStream(
  response: Response,
  { onProgress, stageLabels }: DeploymentStreamHandlers,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `請求失敗（HTTP ${response.status}）`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("部署事件串流不可用");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: Record<string, unknown> | null = null;
  let finalError = "";
  let timedOut = false;

  function processBlock(block: string) {
    const { eventName, payload } = parseEventBlock(block);
    if (eventName === "progress") {
      onProgress(stageLabels[payload.stage ?? ""] || payload.stage || "部署進度", payload);
    } else if (eventName === "result") {
      finalResult = payload;
    } else if (eventName === "error") {
      finalError = payload.error || payload.message || "部署失敗";
    }
  }

  // 逾時以計時器設定旗標並取消 reader，讓掛起的 read() 立刻以 rejection 結束；
  // 只要有任何資料進來就重置計時，故判定的是「閒置」而非總時長。
  async function readUntilEnd(
    source: ReadableStreamDefaultReader<Uint8Array>,
    onChunk: (text: string) => void,
  ): Promise<void> {
    let idleTimer: NodeJS.Timeout | number | undefined;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        void source.cancel().catch(() => {});
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    try {
      resetIdleTimer();
      while (true) {
        const { value, done } = await source.read();
        resetIdleTimer();
        onChunk(decoder.decode(value || new Uint8Array(), { stream: !done }));
        if (done) return;
      }
    } catch (error) {
      // source.cancel() 造成的 rejection 代表閒置逾時，其餘為真實的連線錯誤
      if (!timedOut) {
        throw error;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  await readUntilEnd(reader, chunk => {
    buffer += chunk.replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      processBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  });

  if (buffer.trim()) processBlock(buffer);
  if (finalError) throw new Error(finalError);
  if (timedOut) {
    throw new Error("部署連線閒置過久已中斷；請至操作日誌確認實際狀態。");
  }
  if (!finalResult) {
    throw new Error("部署連線中斷，未收到最終結果；請至操作日誌確認實際狀態。");
  }
  return finalResult;
}
