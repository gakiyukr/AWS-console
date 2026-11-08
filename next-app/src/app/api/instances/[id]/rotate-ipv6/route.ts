// POST /api/instances/[id]/rotate-ipv6：一鍵更換 IPv6 位址（SSE 進度）。
// 刪除 VNIC 現有 IPv6 物件 → 重新指派（Oracle 自子網 /64 選新址）。
// VNIC 尚無 IPv6 時自動走完整開通流程（VCN /56 → 子網 /64 → 路由 → 安全清單 → 指派）。
// 不需重開機。body: { accountId? }
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { getInstance } from "@/server/utils/oci-compute.js";
import {
  getPrimaryVnic,
  rotateInstanceIpv6,
} from "@/server/utils/oci-network.js";
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
  let vnic;
  try {
    const resolved = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance(resolved, id);
    displayName = String(instance?.displayName || "");
    const vnicInfo = await getPrimaryVnic(resolved, {
      instanceId: id,
      compartmentOcid: resolved.ociAccount.compartmentOcid,
    });
    if (!vnicInfo) {
      return errorResponse(409, "此執行個體沒有附加的 VNIC。");
    }
    vnicId = vnicInfo.vnicId;
    vnic = vnicInfo.vnic;
    ctx = resolved;
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  return sseResponse(async (emit) => {
    try {
      const result = await rotateInstanceIpv6(
        { account: ctx.ociAccount, privateKeyPem: ctx.privateKeyPem },
        { compartmentOcid: ctx.ociAccount.compartmentOcid, vnicId, vnic, emit },
      );
      emit("progress", { stage: "done", message: `新 IPv6 位址：${result.newIp}` });
      emit("result", {
        ok: true,
        ipv6Address: result.newIp,
        previousIp: result.previousIp,
        opened: result.opened,
        warnings: result.warnings,
        message: result.opened
          ? `已開通 IPv6：${result.newIp}`
          : `已更換 IPv6 位址：${result.previousIp} → ${result.newIp}`,
      });
      try {
        await appendOperationLog(env.DB, {
          action: "rotate-ipv6",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "success",
          detail: { previous_ip: result.previousIp, new_ip: result.newIp, opened: result.opened },
        });
      } catch {
        // 操作已成功時，稽核日誌失敗不影響結果事件
      }
    } catch (error) {
      const message = ociFailureMessage(error);
      emit("error", { error: message });
      try {
        await appendOperationLog(env.DB, {
          action: "rotate-ipv6",
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
