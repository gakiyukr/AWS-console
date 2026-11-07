// PUT  /api/ddns/domains/[id]：更新域名的 API Token（zone 不變；留空＝不更換）。
// DELETE：刪除域名，其前綴綁定一併清除（CF 記錄保留不刪）。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  deleteDdnsDomain,
  listDdnsDomains,
  updateDdnsDomainToken,
  verifyCloudflareToken,
} from "@/server/utils/ddns.js";
import { appendOperationLog } from "@/server/utils/db.js";

function parseId(rawId: string): number | null {
  const id = Number(rawId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }

  const { id: rawId } = await params;
  const id = parseId(rawId);
  const domains = await listDdnsDomains(env.DB);
  const existing = domains.find(domain => domain.id === id);
  if (!existing) {
    return errorResponse(404, "找不到指定的域名。");
  }

  const body = await readJsonBody(request);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return errorResponse(400, "請填寫新的 API Token。");
  }

  let zoneId;
  try {
    zoneId = await verifyCloudflareToken(token, existing.zoneName);
  } catch {
    return errorResponse(502, "無法連線至 Cloudflare API，請稍後再試。");
  }
  if (!zoneId) {
    return errorResponse(400, "驗證失敗：Token 無效、缺少 Zone.DNS Edit 權限，或此帳號下沒有該 Zone。");
  }

  await updateDdnsDomainToken(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, id, token);
  try {
    await appendOperationLog(env.DB, {
      action: "ddns-domain-update",
      status: "success",
      detail: { zoneName: existing.zoneName },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }
  return jsonResponse({ ok: true, message: `域名 ${existing.zoneName} 的 Token 已更新。` });
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
    return errorResponse(400, "域名 ID 無效。");
  }
  const domains = await listDdnsDomains(env.DB);
  const existing = domains.find(domain => domain.id === id);
  if (!existing) {
    return errorResponse(404, "找不到指定的域名。");
  }

  const deleted = await deleteDdnsDomain(env.DB, id);
  try {
    await appendOperationLog(env.DB, {
      action: "ddns-domain-remove",
      status: "success",
      detail: { zoneName: existing.zoneName },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }
  return jsonResponse({
    ok: true,
    deleted,
    message: `域名 ${existing.zoneName} 已移除，其前綴綁定一併清除（Cloudflare 記錄保留）。`,
  });
}
