// POST /api/instances/network/init：一鍵初始化網路（SSE 進度）。
// 建立 VCN（10.0.0.0/16）→ Internet Gateway → 路由表（0.0.0.0/0 預設路由）
// → 安全清單（22/80/443 入站）→ 公開子網（10.0.0.0/24）。
// 既有可用 VCN／公開子網會直接沿用（冪等），不會重複建立資源。
// body: { accountId?, region? }
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { initializeNetwork } from "@/server/utils/oci-network.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";
  const region = typeof body.region === "string" ? body.region.trim() : "";

  // 憑證解析在建立串流前完成，錯誤以一般 JSON 回應
  let resolved;
  try {
    resolved = await resolveOciAccount(env, accountId || undefined, { region: region || undefined });
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  return sseResponse(async (emit) => {
    try {
      const result = await initializeNetwork(
        { account: resolved.ociAccount, privateKeyPem: resolved.privateKeyPem },
        {
          compartmentOcid: resolved.ociAccount.compartmentOcid,
          emit: ({ stage, message }) => emit("progress", { stage, message }),
        },
      );
      emit("result", {
        ok: true,
        ...result,
        message: result.warnings.length > 0
          ? `網路初始化完成（${result.warnings.join("；")}）`
          : "網路初始化完成，可直接建立執行個體。",
      });
      try {
        await appendOperationLog(env.DB, {
          action: "init-network",
          ociAccountId: Number(resolved.account.id),
          instanceId: null,
          displayName: null,
          status: "success",
          detail: { vcn_id: result.vcnId, subnet_id: result.subnetId, region: resolved.ociAccount.region },
        });
      } catch {
        // 操作已成功時，稽核日誌失敗不影響結果
      }
    } catch (error) {
      const message = ociFailureMessage(error);
      emit("error", { error: message });
      try {
        await appendOperationLog(env.DB, {
          action: "init-network",
          ociAccountId: Number(resolved.account.id),
          instanceId: null,
          displayName: null,
          status: "failure",
          detail: message,
        });
      } catch {
        // 日誌寫入失敗不影響錯誤事件
      }
    }
  });
}
