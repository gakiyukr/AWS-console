// PATCH /api/share-links/:id：部分更新連結（名稱、冷卻分鐘數、啟用狀態、綁定機器）。
// DELETE /api/share-links/:id：刪除連結與其綁定關聯（機器本身不受影響）。
import {
  appendOperationLog,
  deleteShareLink,
  getShareLinkById,
  listMachines,
  updateShareLink,
} from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;
const MAX_COOLDOWN_MINUTES = 1440;

function parseId(rawId: string): number | null {
  const id = Number(rawId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (!id) {
    return errorResponse(400, "連結 ID 無效。");
  }

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }
  const updates: { name?: string; cooldownMinutes?: number; enabled?: boolean; machineIds?: number[] } = {};
  if (body.name !== undefined) {
    const name = validateInput(body.name, undefined, "連結名稱");
    if (!name.valid) {
      return errorResponse(400, name.error);
    }
    updates.name = body.name;
  }
  if (body.cooldownMinutes !== undefined) {
    const cooldownMinutes = Number(body.cooldownMinutes);
    if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > MAX_COOLDOWN_MINUTES) {
      return errorResponse(400, `冷卻分鐘數須為 0–${MAX_COOLDOWN_MINUTES} 的整數。`);
    }
    updates.cooldownMinutes = cooldownMinutes;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return errorResponse(400, "啟用狀態格式無效。");
    }
    updates.enabled = body.enabled;
  }
  if (body.machineIds !== undefined) {
    if (!Array.isArray(body.machineIds) || body.machineIds.length === 0) {
      return errorResponse(400, "請至少選擇一台要綁定的機器。");
    }
    const machineIds = body.machineIds.map((value: unknown) => Number(value));
    if (machineIds.some((value: number) => !Number.isInteger(value) || value <= 0)) {
      return errorResponse(400, "機器清單格式無效。");
    }
    const allMachines = await listMachines(env.DB);
    const validIds = new Set(allMachines.map((machine: { id: number }) => machine.id));
    if (machineIds.some((value: number) => !validIds.has(value))) {
      return errorResponse(400, "包含無效或不存在的機器。");
    }
    updates.machineIds = machineIds;
  }

  const updated = await updateShareLink(env.DB, id, updates);
  if (!updated) {
    return errorResponse(404, "找不到指定的分享連結。");
  }
  try {
    await appendOperationLog(env.DB, {
      action: "share_link_update",
      status: "success",
      detail: { share_link_id: id, ...updates },
    });
  } catch {
    // 日誌寫入失敗不影響更新結果
  }
  return jsonResponse({ ok: true, link: updated });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (!id) {
    return errorResponse(400, "連結 ID 無效。");
  }
  const existing = await getShareLinkById(env.DB, id);
  if (!existing) {
    return errorResponse(404, "找不到指定的分享連結。");
  }

  const deleted = await deleteShareLink(env.DB, id);
  if (!deleted) {
    return errorResponse(500, "刪除分享連結失敗。");
  }

  try {
    await appendOperationLog(env.DB, {
      action: "share_link_delete",
      status: "success",
      detail: { share_link_id: id, name: existing.name },
    });
  } catch {
    // 日誌寫入失敗不影響刪除結果
  }
  return jsonResponse({ ok: true });
}
