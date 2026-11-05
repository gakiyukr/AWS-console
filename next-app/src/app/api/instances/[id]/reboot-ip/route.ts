// POST /api/instances/[id]/reboot-ip：換 IP（M3，SSE 進度）。
// 刪除臨時公網 IP → 重建（同 private IP）。Reserved Public IP 一律提示不動作；
// stop 不會換 IP（OCI 臨時 IP 綁 private IP），故為獨立操作。
// body: { accountId? }
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { getInstance } from "@/server/utils/oci-compute.js";
import { getPrimaryVnic, rotateEphemeralPublicIp } from "@/server/utils/oci-network.js";
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

  // 操作前置（憑證、VNIC）在建立串流前完成，錯誤以一般 JSON 回應
  let ctx;
  let displayName = "";
  let vnicId = "";
  try {
    const resolved = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance(resolved, id);
    displayName = String(instance?.displayName || "");
    if (String(instance?.lifecycleState || "") !== "RUNNING") {
      return errorResponse(409, "執行個體不在 Running 狀態，無法更換公網 IP。");
    }
    const vnicInfo = await getPrimaryVnic(resolved, {
      instanceId: id,
      compartmentOcid: resolved.ociAccount.compartmentOcid,
    });
    if (!vnicInfo) {
      return errorResponse(409, "此執行個體沒有附加的 VNIC。");
    }
    vnicId = vnicInfo.vnicId;
    ctx = resolved;
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  return sseResponse(async (emit) => {
    try {
      const result = await rotateEphemeralPublicIp(
        { account: ctx.ociAccount, privateKeyPem: ctx.privateKeyPem },
        { compartmentOcid: ctx.ociAccount.compartmentOcid, vnicId, emit },
      );
      emit("progress", { stage: "done", message: `新公網 IP：${result.newIp}` });
      emit("result", {
        ok: true,
        ipAddress: result.newIp,
        previousIp: result.previousIp,
        message: `已更換公網 IP：${result.previousIp || "（無）"} → ${result.newIp}`,
      });
      try {
        await appendOperationLog(env.DB, {
          action: "reboot-ip",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "success",
          detail: { previous_ip: result.previousIp, new_ip: result.newIp },
        });
      } catch {
        // 操作已成功時，稽核日誌失敗不影響結果事件
      }
    } catch (error) {
      const message = ociFailureMessage(error);
      emit("error", { error: message });
      try {
        await appendOperationLog(env.DB, {
          action: "reboot-ip",
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
