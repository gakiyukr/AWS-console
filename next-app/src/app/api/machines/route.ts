// GET /api/machines：合併 D1 機器清單與 DescribeInstances 即時狀態。
// 地區查詢失敗不影響整體回應（該地區列標示「查詢失敗」），
// 因此本端點在 AWS 異常時仍能回 200，讓前端可管理清單本身。
// POST /api/machines：新增機器至 D1 清單。全欄位正則驗證；
// (region, instanceId) 重複時回 409。
import { createMachine, getAwsAccountById, listMachines } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { mergeMachineStates } from "@/server/utils/power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const machines = await listMachines(env.DB);
  const groups = new Map<number | null, typeof machines>();
  for (const machine of machines) {
    const key = machine.awsAccountId || null;
    groups.set(key, [...(groups.get(key) || []), machine]);
  }
  const rows = new Map<number, Record<string, unknown>>();
  await Promise.all([...groups.entries()].map(async ([accountId, accountMachines]) => {
    try {
      const { account, awsEnv } = await resolveAwsAccount(env, accountId);
      for (const machine of await mergeMachineStates(awsEnv, accountMachines)) {
        rows.set(machine.id, { ...machine, awsAccountName: account.name });
      }
    } catch {
      for (const machine of accountMachines) {
        rows.set(machine.id, {
          ...machine,
          awsAccountName: null,
          state: "查詢失敗",
          publicDnsName: "查詢失敗",
          publicIpAddress: "查詢失敗",
        });
      }
    }
  }));
  return jsonResponse(machines.map(machine => rows.get(machine.id)));
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const region = validateInput(body.region, "region", "地區");
  if (!region.valid) {
    return errorResponse(400, region.error);
  }
  const instanceId = validateInput(body.instanceId, "instanceId", "執行個體 ID");
  if (!instanceId.valid) {
    return errorResponse(400, instanceId.error);
  }
  const name = validateInput(body.name, undefined, "顯示名稱");
  if (!name.valid) {
    return errorResponse(400, name.error);
  }
  const awsAccountId = Number(body.awsAccountId);
  if (!Number.isSafeInteger(awsAccountId) || awsAccountId <= 0 || !await getAwsAccountById(env.DB, awsAccountId)) {
    return errorResponse(400, "請選擇有效的 AWS 帳號");
  }

  const created = await createMachine(env.DB, {
    awsAccountId,
    region: body.region,
    instanceId: body.instanceId,
    name: body.name,
    isWavelength: Boolean(body.isWavelength),
  });
  if (!created) {
    return errorResponse(409, "此機器已在清單中。");
  }
  return jsonResponse({ ok: true, id: created.id }, { status: 201 });
}
