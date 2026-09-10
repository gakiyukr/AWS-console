// /api/ssh-keys：GET 列出設定頁管理的機器登入公鑰；
// POST 新增公鑰（金鑰內容以 validateSshPublicKeyText 驗證格式）。
// 公鑰本身為公開資料，完整回傳內容以利設定頁檢視與部署表單顯示。
import { createSshPublicKey, listSshPublicKeys } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { validateSshPublicKeyText } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

// 公鑰庫容量上限，避免無限成長
const MAX_SSH_KEYS = 50;

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  return jsonResponse({ keys: await listSshPublicKeys(env.DB) });
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const labelValidation = validateInput(label, undefined, "公鑰名稱");
  if (!labelValidation.valid) {
    return errorResponse(400, labelValidation.error);
  }

  let keys;
  try {
    keys = validateSshPublicKeyText(typeof body.publicKey === "string" ? body.publicKey : "");
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "SSH 公鑰格式無效");
  }

  const existing = await listSshPublicKeys(env.DB);
  if (existing.length >= MAX_SSH_KEYS) {
    return errorResponse(400, `公鑰數量已達上限（${MAX_SSH_KEYS} 把），請先刪除不使用的金鑰`);
  }

  const created = await createSshPublicKey(env.DB, { label, publicKey: keys.join("\n") });
  if (!created) {
    return errorResponse(409, "此 SSH 公鑰已存在");
  }
  return jsonResponse({ id: created.id }, { status: 201 });
}
