// POST /api/machines/:id/action：對白名單內機器送出 start|stop。
// 目標以 D1 為準（取代舊版寫死 TARGETS），操作結果寫入操作日誌；
// 成功與失敗皆記錄，供 /logs 頁稽核。
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { performPowerAction } from "@/server/utils/power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

// 請求大小上限：本端點僅接受 { action } 一個欄位
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

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  const machine = Number.isInteger(id) && id > 0 ? await getMachineById(env.DB, id) : null;
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }

  const action = body.action;
  if (action !== "start" && action !== "stop" && action !== "reboot") {
    return errorResponse(400, "不支援的操作。");
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, machine.awsAccountId);
    await performPowerAction(awsEnv, machine, action);
  } catch (error) {
    try {
      await appendOperationLog(env.DB, {
        action,
        region: machine.region,
        instanceId: machine.instanceId,
        status: "failure",
        detail: error instanceof Error ? error.message : String(error),
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 日誌寫入失敗不影響錯誤回應
    }
    return errorResponse(500, "操作失敗。");
  }

  try {
    await appendOperationLog(env.DB, {
      action,
      region: machine.region,
      instanceId: machine.instanceId,
      status: "success",
      detail: null,
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // 日誌寫入失敗不影響成功回應
  }
  return jsonResponse({
    ok: true,
    message: action === "start" ? "已送出開機請求。" : "已送出關機請求。",
  });
}
