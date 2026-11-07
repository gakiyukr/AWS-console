// GET /api/machines：合併 D1 機器清單與即時狀態（EC2 走 DescribeInstances、
// Lightsail 走 GetInstances，兩者互不影響）。可用 ?platform=ec2|lightsail
// 篩選；省略時回傳全部（分享連結管理頁需要跨平台清單）。
// 地區查詢失敗不影響整體回應（該地區列標示「查詢失敗」），
// 因此本端點在 AWS 異常時仍能回 200，讓前端可管理清單本身。
// POST /api/machines：新增機器至 D1 清單。全欄位正則驗證；
// (region, instanceId) 重複時回 409。
import { createMachine, getAwsAccountById, getMachinesDdnsMap, listMachines } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { mergeLightsailStates } from "@/server/utils/lightsail-power.js";
import { mergeMachineStates } from "@/server/utils/power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MACHINE_PLATFORMS = ["ec2", "lightsail"] as const;

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const platformParam = new URL(request.url).searchParams.get("platform");
  if (platformParam && !(MACHINE_PLATFORMS as readonly string[]).includes(platformParam)) {
    return errorResponse(400, "平台參數無效。");
  }
  const platform = (platformParam as "ec2" | "lightsail" | null) || null;

  const machines = await listMachines(env.DB, platform);
  // 附加每台機器的 DDNS 綁定 FQDN 清單（多前綴）
  const ddnsMap = await getMachinesDdnsMap(env.DB);
  // 依帳號分組後，再依平台分流狀態查詢：Lightsail 名稱送進 EC2
  // DescribeInstances 會讓整個地區批次失敗，兩者必須分開。
  const groups = new Map<string, typeof machines>();
  for (const machine of machines) {
    const key = `${machine.awsAccountId || null}\u0000${machine.platform}`;
    groups.set(key, [...(groups.get(key) || []), machine]);
  }
  const rows = new Map<number, Record<string, unknown>>();
  await Promise.all([...groups.entries()].map(async ([key, groupMachines]) => {
    const [rawAccountId, groupPlatform] = key.split("\u0000");
    const accountId = rawAccountId === "null" ? null : Number(rawAccountId);
    try {
      const { account, awsEnv } = await resolveAwsAccount(env, accountId);
      const merged = groupPlatform === "lightsail"
        ? await mergeLightsailStates(awsEnv, groupMachines)
        : await mergeMachineStates(awsEnv, groupMachines);
      for (const machine of merged) {
        rows.set(machine.id, { ...machine, awsAccountName: account.name });
      }
    } catch {
      for (const machine of groupMachines) {
        rows.set(machine.id, {
          ...machine,
          awsAccountName: null,
          state: "查詢失敗",
          publicDnsName: "查詢失敗",
          publicIpAddress: "查詢失敗",
          ipv6Address: "查詢失敗",
        });
      }
    }
  }));
  return jsonResponse(machines.map(machine => ({
    ...rows.get(machine.id),
    ddnsHostnames: ddnsMap.get(machine.id) || [],
  })));
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

  // Lightsail 以執行個體名稱識別（非 i-… 格式），僅 EC2 套用 instanceId 正則。
  const platform = body.platform === "lightsail" ? "lightsail" : "ec2";
  if (platform === "lightsail") {
    const lightsailName = validateInput(body.instanceId, undefined, "Lightsail 執行個體名稱");
    if (!lightsailName.valid) {
      return errorResponse(400, lightsailName.error);
    }
  } else {
    const instanceId = validateInput(body.instanceId, "instanceId", "執行個體 ID");
    if (!instanceId.valid) {
      return errorResponse(400, instanceId.error);
    }
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
    platform,
  });
  if (!created) {
    return errorResponse(409, "此機器已在清單中。");
  }
  return jsonResponse({ ok: true, id: created.id }, { status: 201 });
}
