// DELETE /api/ssh-keys/[id]：自公鑰庫移除 SSH 公鑰。
// 已被部署使用的金鑰不影響既有執行個體，僅影響後續部署的選項。
import { deleteSshPublicKey } from "@/server/utils/db.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse(400, "公鑰 ID 無效。");
  }
  const deleted = await deleteSshPublicKey(env.DB, id);
  if (!deleted) {
    return errorResponse(404, "公鑰不存在。");
  }
  return jsonResponse({ ok: true });
}
