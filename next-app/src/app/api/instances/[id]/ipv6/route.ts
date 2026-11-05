// POST /api/instances/[id]/ipv6：一鍵加 IPv6（M4，SSE 進度）。
// 完整開通：VCN /56 → 子網 /64 → IGW ::/0 路由 → 安全清單（§6.4 合併）→
// VNIC 指派。冪等；IPv6 於 VCN／子網層級開通後無法關閉（前端須明示）。
// body: { accountId? }
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { getInstance } from "@/server/utils/oci-compute.js";
import { enableInstanceIpv6, getPrimaryVnic } from "@/server/utils/oci-network.js";
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
  let vnicInfo;
  try {
    const resolved = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance(resolved, id);
    displayName = String(instance?.displayName || "");
    vnicInfo = await getPrimaryVnic(resolved, {
      instanceId: id,
      compartmentOcid: resolved.ociAccount.compartmentOcid,
    });
    if (!vnicInfo) {
      return errorResponse(409, "此執行個體沒有附加的 VNIC。");
    }
    ctx = resolved;
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  return sseResponse(async (emit) => {
    try {
      const result = await enableInstanceIpv6(
        { account: ctx.ociAccount, privateKeyPem: ctx.privateKeyPem },
        {
          compartmentOcid: ctx.ociAccount.compartmentOcid,
          vnicId: vnicInfo.vnicId,
          vnic: vnicInfo.vnic,
          emit: ({ stage, message }: { stage: string, message: string }) => emit("progress", { stage, message }),
        },
      );
      emit("progress", { stage: "done", message: result.ipv6Address ? `IPv6 位址：${result.ipv6Address}` : "開通完成" });
      emit("result", {
        ok: true,
        ipv6Address: result.ipv6Address,
        warnings: result.warnings,
        message: result.ipv6Address
          ? `IPv6 已開通：${result.ipv6Address}`
          : "IPv6 已指派，位址稍後重新整理即可查看。",
      });
      try {
        await appendOperationLog(env.DB, {
          action: "enable-ipv6",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "success",
          detail: { ipv6_address: result.ipv6Address, warnings: result.warnings },
        });
      } catch {
        // 操作已成功時，稽核日誌失敗不影響結果事件
      }
    } catch (error) {
      const message = ociFailureMessage(error);
      emit("error", { error: message });
      try {
        await appendOperationLog(env.DB, {
          action: "enable-ipv6",
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
