// /api/accounts/[id]：PUT 更新 AWS 帳號（憑證留空表示不替換）；
// DELETE 刪除帳號（有受管機器時拒絕）。
import { encryptAwsCredentials } from "@/server/utils/credential-crypto.js";
import { deleteAwsAccount, getAwsAccountById, updateAwsAccount } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

function publicAccount(account: Record<string, unknown>) {
  const safe = { ...account };
  delete safe.credentialCiphertext;
  delete safe.credentialIv;
  return safe;
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id: rawId } = await params;
  const id = Number(rawId);
  const existing = Number.isSafeInteger(id) && id > 0 ? await getAwsAccountById(env.DB, id) : null;
  if (!existing) {
    return errorResponse(404, "AWS 帳號不存在");
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : existing.name;
  if (!name || name.length > 80) {
    return errorResponse(400, "帳號名稱必須為 1 至 80 個字元");
  }
  const enabled = body.enabled ?? existing.enabled;
  const isDefault = body.isDefault ?? existing.isDefault;
  if (isDefault && !enabled) {
    return errorResponse(400, "預設 AWS 帳號必須保持啟用");
  }
  if (existing.isDefault && !isDefault) {
    return errorResponse(409, "請先將另一個 AWS 帳號設為預設");
  }

  try {
    const encrypted = body.accessKeyId || body.secretAccessKey
      ? await encryptAwsCredentials({
          accessKeyId: body.accessKeyId,
          secretAccessKey: body.secretAccessKey,
          sessionToken: body.sessionToken,
        }, env.CREDENTIAL_ENCRYPTION_KEY)
      : {
          credentialCiphertext: existing.credentialCiphertext,
          credentialIv: existing.credentialIv,
          accessKeyHint: existing.accessKeyHint,
          encryptionKeyVersion: existing.encryptionKeyVersion,
        };
    const account = await updateAwsAccount(env.DB, id, {
      name,
      ...encrypted,
      enabled,
      isDefault,
    });
    if (!account) {
      return errorResponse(409, "AWS 帳號名稱已存在");
    }
    return jsonResponse({ account: publicAccount(account) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AWS 帳號更新失敗";
    return errorResponse(
      message.includes("UNIQUE") ? 409 : 400,
      message.includes("UNIQUE") ? "AWS 帳號名稱已存在" : message,
    );
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return errorResponse(400, "AWS 帳號 ID 無效");
  }
  const result = await deleteAwsAccount(env.DB, id);
  if (result.reason === "not_found") {
    return errorResponse(404, "AWS 帳號不存在");
  }
  if (result.reason === "in_use") {
    return errorResponse(409, "此帳號仍有受管機器，請先移除或轉移機器");
  }
  return jsonResponse({ ok: true });
}
