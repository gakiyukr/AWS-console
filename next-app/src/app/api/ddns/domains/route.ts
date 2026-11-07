// /api/ddns/domains：DDNS 域名清單管理（多域名）。
// GET   → 列出已登錄域名（Token 僅 hint）
// POST  → 新增域名（先以 Cloudflare API 驗證 Token 可存取該 Zone）
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  createDdnsDomain,
  listDdnsDomains,
  verifyCloudflareToken,
} from "@/server/utils/ddns.js";
import { appendOperationLog } from "@/server/utils/db.js";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  return jsonResponse({ domains: await listDdnsDomains(env.DB) });
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  }

  const body = await readJsonBody(request);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const zoneName = typeof body?.zoneName === "string" ? body.zoneName.trim().toLowerCase() : "";
  if (!token || !zoneName || !zoneName.includes(".")) {
    return errorResponse(400, "請填寫 API Token 與 Zone 名稱。");
  }

  let zoneId;
  try {
    zoneId = await verifyCloudflareToken(token, zoneName);
  } catch {
    return errorResponse(502, "無法連線至 Cloudflare API，請稍後再試。");
  }
  if (!zoneId) {
    return errorResponse(400, "驗證失敗：Token 無效、缺少 Zone.DNS Edit 權限，或此帳號下沒有該 Zone。");
  }

  const created = await createDdnsDomain(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, { token, zoneId, zoneName });
  if (!created) {
    return errorResponse(409, "此域名已存在。");
  }

  try {
    await appendOperationLog(env.DB, {
      action: "ddns-domain-add",
      status: "success",
      detail: { zoneName },
    });
  } catch {
    // 日誌寫入失敗不影響結果
  }

  return jsonResponse({
    ok: true,
    domain: { id: created.id, zoneName, tokenHint: `····${token.slice(-4)}` },
    message: `域名已新增（Zone：${zoneName}）。`,
  }, { status: 201 });
}
