// GET & PUT /api/instances/[id]/alias：執行個體自訂別名與備註（Phase 2）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { getInstanceAlias, setInstanceAlias, deleteInstanceAlias } from "@/server/utils/instance-aliases.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env?.DB) return errorResponse(503, "資料庫不可用");

  const { id } = await params;
  const validation = validateInput(id, "instanceOcid", "執行個體 OCID");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  const alias = await getInstanceAlias(env.DB, id);
  return jsonResponse({ alias });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env?.DB) return errorResponse(503, "資料庫不可用");

  const { id } = await params;
  const validation = validateInput(id, "instanceOcid", "執行個體 OCID");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  const body = (await readJsonBody(request)) ?? {};
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";

  if (!alias) {
    await deleteInstanceAlias(env.DB, id);
    return jsonResponse({ ok: true, alias: null });
  }

  if (alias.length > 50) {
    return errorResponse(400, "別名長度不可超過 50 個字元");
  }

  await setInstanceAlias(env.DB, id, alias, notes);
  return jsonResponse({ ok: true, alias: { instanceId: id, alias, notes } });
}
