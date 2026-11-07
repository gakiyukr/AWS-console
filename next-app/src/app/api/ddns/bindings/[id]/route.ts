// DELETE /api/ddns/bindings/[id]：移除前綴綁定（Cloudflare 記錄保留不刪）。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { deleteDdnsBinding, listDdnsBindings } from "@/server/utils/ddns.js";
import { appendOperationLog } from "@/server/utils/db.js";

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
    return errorResponse(400, "綁定 ID 無效。");
  }
  const bindings = await listDdnsBindings(env.DB);
  const existing = bindings.find(binding => binding.id === id);
  if (!existing) {
    return errorResponse(404, "找不到指定的綁定。");
  }

  const deleted = await deleteDdnsBinding(env.DB, id);
  try {
    await appendOperationLog(env.DB, {
      action: "ddns-sync",
      region: null,
      instanceId: null,
      status: "success",
      detail: { fqdn: existing.fqdn, status: "binding-removed" },
    });
  } catch {
    // 日誌寫入失敗不影響回應
  }
  return jsonResponse({
    ok: true,
    deleted,
    message: `已移除綁定 ${existing.fqdn}（Cloudflare 記錄保留）。`,
  });
}
