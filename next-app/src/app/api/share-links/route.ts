// GET /api/share-links：列出分享連結與各連結綁定的機器。
// POST /api/share-links：建立連結。token 於伺服端產生（URL 即憑證，
// 依需求明文儲存於 D1），machineIds 逐一比對機器清單以防幻影 id。
import {
  appendOperationLog,
  createShareLink,
  listMachines,
  listShareLinks,
  shareQuotaDay,
} from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;
const MAX_COOLDOWN_MINUTES = 1440;
const MAX_MACHINES_PER_LINK = 50;
const MAX_DAILY_LIMIT = 10000;

/** 24 位元組隨機值的 base64url（32 字元，192 bits 熵），作為網址中的憑證。 */
function generateShareToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  return jsonResponse({ links: await listShareLinks(env.DB, shareQuotaDay()) });
}

export async function POST(request: Request): Promise<Response> {
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

  const name = validateInput(body.name, undefined, "連結名稱");
  if (!name.valid) {
    return errorResponse(400, name.error);
  }
  const cooldownMinutes = Number(body.cooldownMinutes ?? 5);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > MAX_COOLDOWN_MINUTES) {
    return errorResponse(400, `冷卻分鐘數須為 0–${MAX_COOLDOWN_MINUTES} 的整數。`);
  }
  const dailyLimit = Number(body.dailyLimit ?? 0);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > MAX_DAILY_LIMIT) {
    return errorResponse(400, `每日上限須為 0–${MAX_DAILY_LIMIT} 的整數（0 表示不限）。`);
  }
  const rawMachineIds: unknown[] = Array.isArray(body.machineIds) ? body.machineIds : [];
  const machineIds = [...new Set(rawMachineIds.map(value => Number(value)))];
  if (machineIds.length === 0) {
    return errorResponse(400, "請至少選擇一台機器。");
  }
  if (machineIds.length > MAX_MACHINES_PER_LINK) {
    return errorResponse(400, `一條連結最多綁定 ${MAX_MACHINES_PER_LINK} 台機器。`);
  }
  if (machineIds.some(id => !Number.isInteger(id) || id <= 0)) {
    return errorResponse(400, "機器選擇無效。");
  }
  const knownIds = new Set<number>((await listMachines(env.DB)).map(machine => Number(machine.id)));
  const unknownIds = machineIds.filter(id => !knownIds.has(id));
  if (unknownIds.length > 0) {
    return errorResponse(400, "所選機器已不在清單內，請重新選擇。");
  }

  const token = generateShareToken();
  const created = await createShareLink(env.DB, { name: body.name, token, cooldownMinutes, machineIds, dailyLimit });
  if (!created) {
    return errorResponse(409, "連結建立失敗，請重試。");
  }

  try {
    await appendOperationLog(env.DB, {
      action: "share_link_create",
      status: "success",
      detail: { share_link_id: created.id, name: body.name, machines: machineIds.length },
    });
  } catch {
    // 日誌寫入失敗不影響建立結果
  }

  return jsonResponse({
    ok: true,
    link: {
      id: created.id,
      name: body.name,
      token,
      url: `/share/${token}`,
      cooldownMinutes,
      dailyLimit,
      machines: machineIds,
    },
  }, { status: 201 });
}
