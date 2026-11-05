// PUT & DELETE /api/reserved-ips/[id]：綁定、解綁與釋放保留公網 IP（Phase 2）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { updateReservedPublicIp, deleteReservedPublicIp } from "@/server/utils/oci-network.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  const validation = validateInput(id, undefined, "保留公網 IP OCID");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  const body = (await readJsonBody(request)) ?? {};
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";
  // privateIpId: 傳入目標 private IP OCID 進行指派；傳入空字串或 null 表示解綁（Unassign）
  const privateIpId = typeof body.privateIpId === "string" ? body.privateIpId.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : undefined;

  let ctx;
  try {
    ctx = await resolveOciAccount(env, accountId || undefined);
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  try {
    const updated = await updateReservedPublicIp(ctx, id, {
      privateIpId,
      displayName,
    });

    const isAssign = Boolean(privateIpId);
    try {
      await appendOperationLog(env.DB, {
        action: isAssign ? "assign-reserved-ip" : "unassign-reserved-ip",
        ociAccountId: ctx.account.id,
        instanceId: null,
        displayName: updated?.ipAddress || id,
        status: "success",
        detail: { public_ip_id: id, private_ip_id: privateIpId },
      });
    } catch {
      // ignore
    }

    return jsonResponse({
      ok: true,
      reservedIp: updated,
      message: isAssign ? "已成功綁定保留 IP" : "已成功解綁保留 IP",
    });
  } catch (error) {
    const message = ociFailureMessage(error);
    return errorResponse(500, message);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  const validation = validateInput(id, undefined, "保留公網 IP OCID");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";

  let ctx;
  try {
    ctx = await resolveOciAccount(env, accountId || undefined);
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  try {
    await deleteReservedPublicIp(ctx, id);

    try {
      await appendOperationLog(env.DB, {
        action: "delete-reserved-ip",
        ociAccountId: ctx.account.id,
        instanceId: null,
        displayName: id,
        status: "success",
        detail: { public_ip_id: id },
      });
    } catch {
      // ignore
    }

    return jsonResponse({ ok: true, message: "保留公網 IP 已成功釋放。" });
  } catch (error) {
    const message = ociFailureMessage(error);
    return errorResponse(500, message);
  }
}
