// GET /api/instances/[id]：單台執行個體狀態（前端電源操作後輪詢用）。
// DELETE /api/instances/[id]：終止（刪除）執行個體（Phase 2）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { getInstance, terminateInstance } from "@/server/utils/oci-compute.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  const validation = validateInput(id, "instanceOcid", "執行個體 OCID");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }
  const accountId = new URL(request.url).searchParams.get("account_id") ?? "";

  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance({ account: ociAccount, privateKeyPem }, id);
    return jsonResponse({
      instance: {
        id: String(instance?.id || id),
        displayName: String(instance?.displayName || ""),
        lifecycleState: String(instance?.lifecycleState || ""),
        shape: String(instance?.shape || ""),
        availabilityDomain: String(instance?.availabilityDomain || ""),
      },
      region: ociAccount.region,
    });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
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
  const validation = validateInput(id, "instanceOcid", "執行個體 OCID");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await readJsonBody(request)) ?? {};
  } catch {
    body = {};
  }

  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : (new URL(request.url).searchParams.get("account_id") ?? "");
  const preserveBootVolume = Boolean(body.preserveBootVolume);

  let ctx;
  let displayName = "";
  try {
    ctx = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance(ctx, id);
    displayName = String(instance?.displayName || "");
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  try {
    const response = await terminateInstance(ctx, id, { preserveBootVolume });
    if (!response.ok && response.status !== 204 && response.status !== 202) {
      const errJson = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(errJson?.message || `OCI 回應 HTTP ${response.status}`);
    }

    try {
      await appendOperationLog(env.DB, {
        action: "terminate",
        ociAccountId: ctx.account.id,
        instanceId: id,
        displayName,
        status: "success",
        detail: { preserve_boot_volume: preserveBootVolume },
      });
    } catch {
      // 日誌失敗不影響成功回應
    }

    return jsonResponse({
      ok: true,
      instanceId: id,
      targetStates: ["TERMINATING", "TERMINATED"],
      message: `執行個體終止請求已送出${preserveBootVolume ? "（已保留開機磁碟）" : "（未保留開機磁碟）"}。`,
    });
  } catch (error) {
    const message = ociFailureMessage(error);
    try {
      await appendOperationLog(env.DB, {
        action: "terminate",
        ociAccountId: ctx.account.id,
        instanceId: id,
        displayName,
        status: "failure",
        detail: message,
      });
    } catch {
      // ignore
    }
    return errorResponse(500, message);
  }
}
