// POST /api/instances/[id]/action：電源操作（M2）。
// body: { action: "start"|"stop"|"force-stop"|"reboot"|"force-reboot", accountId? }
// 映射：start→START、stop→SOFTSTOP（優雅）、force-stop→STOP（強制）、
// reboot→SOFTRESET、force-reboot→RESET。回應為過渡態；前端輪詢
// GET /api/instances/[id] 直到目標態（RUNNING/STOPPED）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { getInstance, instanceAction } from "@/server/utils/oci-compute.js";
import { OciApiError, ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;

// UI 動作 → OCI InstanceAction 名稱與輪詢目標態
const ACTION_MAP = {
  start: { ociAction: "START", targetStates: ["RUNNING"] },
  stop: { ociAction: "SOFTSTOP", targetStates: ["STOPPED"] },
  "force-stop": { ociAction: "STOP", targetStates: ["STOPPED"] },
  reboot: { ociAction: "SOFTRESET", targetStates: ["RUNNING"] },
  "force-reboot": { ociAction: "RESET", targetStates: ["RUNNING"] },
} as const;

const ACTION_LABELS: Record<string, string> = {
  start: "啟動執行個體",
  stop: "關機（優雅）",
  "force-stop": "關機（強制）",
  reboot: "重啟（優雅）",
  "force-reboot": "重啟（強制）",
};

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
  const actionKey = String(body.action || "");
  const actionSpec = ACTION_MAP[actionKey as keyof typeof ACTION_MAP];
  if (!actionSpec) {
    return errorResponse(400, "action 參數無效");
  }
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";

  try {
    const { account, ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance({ account: ociAccount, privateKeyPem }, id);
    const displayName = String(instance?.displayName || "");
    const currentState = String(instance?.lifecycleState || "");
    if (currentState === "TERMINATED" || currentState === "TERMINATING") {
      return errorResponse(409, "此執行個體已終止，無法執行電源操作。");
    }

    await instanceAction({ account: ociAccount, privateKeyPem }, id, actionSpec.ociAction);

    try {
      await appendOperationLog(env.DB, {
        action: actionKey,
        ociAccountId: account.id,
        instanceId: id,
        displayName,
        status: "success",
        detail: { oci_action: actionSpec.ociAction, previous_state: currentState },
      });
    } catch {
      // OCI 操作已成功時，稽核日誌失敗不應回報操作失敗。
    }

    return jsonResponse({
      ok: true,
      message: `${ACTION_LABELS[actionKey]}已送出，等待狀態更新。`,
      ociAction: actionSpec.ociAction,
      targetStates: actionSpec.targetStates,
      displayName,
    });
  } catch (error) {
    if (error instanceof OciApiError) {
      try {
        await appendOperationLog(env.DB, {
          action: actionKey,
          ociAccountId: null,
          instanceId: id,
          displayName: null,
          status: "failure",
          detail: ociFailureMessage(error),
        });
      } catch {
        // 日誌寫入失敗不影響錯誤回應
      }
      return errorResponse(error.statusCode, ociFailureMessage(error));
    }
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
