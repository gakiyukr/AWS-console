// POST /api/instances/[id]/host-firewall：主機層 iptables 自動化清理（Phase 2，SSE 進度）。
// 透過 OCI Instance Agent（Run Command API）在機器內部自動註解掉
// Ubuntu (/etc/iptables/rules.v4 & rules.v6) 或 Oracle Linux 預設的 REJECT 規則，
// 並即時套用變更。
// body: { accountId? }
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { getInstance } from "@/server/utils/oci-compute.js";
import { cleanHostIptables } from "@/server/utils/oci-agent.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const { id } = await params;
  const idValidation = validateInput(id, "instanceOcid", "執行個體 OCID");
  if (!idValidation.valid) {
    return errorResponse(400, idValidation.error);
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";

  let ctx;
  let displayName = "";
  try {
    const resolved = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance(resolved, id);
    displayName = String(instance?.displayName || "");
    const lifecycleState = String(instance?.lifecycleState || "").toUpperCase();
    if (lifecycleState !== "RUNNING") {
      return errorResponse(409, `執行個體目前狀態為 ${lifecycleState}，必須在 RUNNING（開機）狀態下方能執行 Cloud Agent 指令。`);
    }
    ctx = resolved;
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  return sseResponse(async (emit) => {
    try {
      const result = await cleanHostIptables(
        { account: ctx.ociAccount, privateKeyPem: ctx.privateKeyPem },
        {
          instanceId: id,
          compartmentOcid: ctx.ociAccount.compartmentOcid,
          emit: ({ stage, message }: { stage: string, message: string }) => emit("progress", { stage, message }),
        },
      );

      emit("progress", { stage: "done", message: "主機端防火牆清理完成" });
      emit("result", {
        ok: true,
        commandId: result.commandId,
        output: result.output,
        message: "主機端 iptables REJECT 規則已成功清理！所有埠已直接由雲層安全清單控管。",
      });

      try {
        await appendOperationLog(env.DB, {
          action: "clean-host-firewall",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "success",
          detail: { command_id: result.commandId, output: result.output },
        });
      } catch {
        // 操作已成功時，稽核日誌失敗不影響結果事件
      }
    } catch (error) {
      const message = ociFailureMessage(error);
      emit("error", { error: message });
      try {
        await appendOperationLog(env.DB, {
          action: "clean-host-firewall",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "failure",
          detail: message,
        });
      } catch {
        // 日誌寫入失敗不影響錯誤事件
      }
    }
  });
}
