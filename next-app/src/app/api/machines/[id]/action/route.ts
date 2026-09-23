// POST /api/machines/:id/action：對白名單內機器送出 start|stop|reboot|terminate。
// 目標以 D1 為準，操作結果寫入操作日誌；成功與失敗皆記錄，供 /logs 頁稽核。
// terminate 為不可逆操作：成功後該執行個體將被 AWS 永久刪除，同時移除 D1 清單記錄。
import { appendOperationLog, deleteMachine, getMachineById } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { performPowerAction } from "@/server/utils/power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

// 請求大小上限：本端點僅接受 { action } 一個欄位
const MAX_BODY_BYTES = 10240;
type PowerAction = "start" | "stop" | "reboot" | "terminate";
const POWER_ACTIONS: Record<PowerAction, true> = { start: true, stop: true, reboot: true, terminate: true };

const ACTION_MESSAGES = {
  start: "已送出開機請求。",
  stop: "已送出關機請求。",
  reboot: "已送出重啟請求。",
  terminate: "已終止執行個體，並自清單移除。",
};

const ACTION_LABELS = {
  start: "開機",
  stop: "關機",
  reboot: "重啟",
  terminate: "終止",
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

  const action = typeof body.action === "string" ? body.action : "";
  if (!(action in POWER_ACTIONS)) {
    return errorResponse(400, "不支援的操作。");
  }
  const powerAction = action as keyof typeof POWER_ACTIONS;

  try {
    const { awsEnv } = await resolveAwsAccount(env, machine.awsAccountId);
    await performPowerAction(awsEnv, machine, powerAction);
  } catch (error) {
    try {
      await appendOperationLog(env.DB, {
        action: powerAction,
        region: machine.region,
        instanceId: machine.instanceId,
        status: "failure",
        detail: error instanceof Error ? error.message : String(error),
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 日誌寫入失敗不影響錯誤回應
    }
    return errorResponse(500, `${ACTION_LABELS[powerAction]}操作失敗。`);
  }

  try {
    await appendOperationLog(env.DB, {
      action: powerAction,
      region: machine.region,
      instanceId: machine.instanceId,
      status: "success",
      detail: null,
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // 日誌寫入失敗不影響成功回應
  }

  // 終止後執行個體不復存在，同步移除清單記錄；記錄刪除失敗不影響回應，
  // 下次清單合併時該機器會顯示「未找到」，仍可手動移除。
  if (powerAction === "terminate") {
    try {
      await deleteMachine(env.DB, id);
    } catch {
      // 清單刪除失敗不影響終止結果
    }
  }

  return jsonResponse({
    ok: true,
    message: ACTION_MESSAGES[powerAction],
  });
}
