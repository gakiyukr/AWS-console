// HTTP 回應工具：統一 JSON 格式、錯誤格式與 SSE 事件封裝。
// 所有 API 路由共用，確保前端能以單一慣例解析成功與錯誤。

/** 成功回應：JSON 序列化並附帶正確 Content-Type。 */
export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

/**
 * 錯誤回應：一律 `{ error: 訊息 }` 格式。
 * @param {number} status HTTP 狀態碼
 * @param {string} message 繁體中文錯誤訊息（可直接顯示於 UI）
 */
export function errorResponse(status, message) {
  return jsonResponse({ error: message }, { status });
}

/**
 * 同時讀取 Workers Headers 與 Nitro Node 型標頭物件。
 * Cloudflare Worker 預設使用 Headers，但 Nitro 路由的 event.node.req.headers
 * 是小寫鍵名的普通物件；統一在此轉換可避免認證流程依執行期而失效。
 */
export function getHeaderValue(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value === undefined ? "" : String(value);
}

/**
 * 建立 SSE 回應。onStart 接收一個 emit(event, data) 函式，
 * 以 event: progress|result|error + data: {JSON} 的格式推送，
 * 事件間以空行分隔（SSE 標準）。
 * Workers 執行期等待 I/O 不計 CPU 時間，長時間部署流程可安全使用。
 * @param {(emit: (event: string, data: unknown) => void) => Promise<void>} onStart
 */
export function sseResponse(onStart) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit = (event, data) => {
        if (closed) {
          return;
        }
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        await onStart(emit);
        if (!closed) {
          controller.close();
          closed = true;
        }
      } catch (error) {
        // 串流中未預期的例外仍以 error 事件送達前端後再關閉
        emit("error", { message: error?.message || String(error) });
        if (!closed) {
          controller.close();
          closed = true;
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

/**
 * 解析用戶端真實 IP，作為登入限流的鍵。
 * Cloudflare 環境以 CF-Connecting-IP 為準（不可偽造）；
 * 本機開發依序退回 X-Forwarded-For / X-Real-IP / unknown。
 */
export function getClientIp(headers) {
  const forwardedFor = getHeaderValue(headers, "x-forwarded-for");
  return (
    getHeaderValue(headers, "cf-connecting-ip")
    || forwardedFor.split(",")[0]?.trim()
    || getHeaderValue(headers, "x-real-ip")
    || "unknown"
  );
}

/**
 * 解析 JSON 請求內容；格式錯誤回 null，由呼叫端決定錯誤語意。
 * Next.js Route Handler 與測試呼叫端皆傳入 Fetch Request。
 */
export async function readJsonBody(request) {
  try {
    if (typeof request?.json === "function") {
      return await request.json();
    }
    return null;
  } catch {
    return null;
  }
}
