// DELETE /api/machines/:id：自 D1 清單移除機器並寫入操作日誌。
// 僅移除清單記錄，不對 AWS 執行個體做任何操作。
import { appendOperationLog, deleteMachine, getMachineById } from "@/server/utils/db.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse(400, "機器 ID 無效。");
  }

  const machine = await getMachineById(env.DB, id);
  if (!machine) {
    return errorResponse(404, "機器不存在。");
  }

  await deleteMachine(env.DB, id);
  try {
    await appendOperationLog(env.DB, {
      action: "machine_remove",
      region: machine.region,
      instanceId: machine.instanceId,
      status: "success",
      detail: `已移除機器「${machine.name}」`,
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // 日誌寫入失敗不影響移除結果
  }
  return jsonResponse({ ok: true });
}
