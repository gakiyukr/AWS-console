// /api/oci-accounts/[id]：PUT 更新 OCI 帳號（PEM 留空表示不替換）；
// DELETE 刪除帳號。
import { encryptOciCredentials } from "@/server/utils/credential-crypto.js";
import { deleteOciAccount, getOciAccountById, updateOciAccount } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

function publicAccount(account: Record<string, unknown>) {
  const safe = { ...account };
  delete safe.keyCiphertext;
  delete safe.keyIv;
  return safe;
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id: rawId } = await params;
  const id = Number(rawId);
  const existing = Number.isSafeInteger(id) && id > 0 ? await getOciAccountById(env.DB, id) : null;
  if (!existing) {
    return errorResponse(404, "OCI 帳號不存在");
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : existing.name;
  if (!name || name.length > 80) {
    return errorResponse(400, "帳號名稱必須為 1 至 80 個字元");
  }
  for (const [field, type, label] of [
    ["tenancyOcid", "tenancyOcid", "Tenancy OCID"],
    ["userOcid", "userOcid", "User OCID"],
    ["compartmentOcid", "compartmentOcid", "Compartment OCID"],
    ["region", "region", "Region"],
    ["fingerprint", "fingerprint", "Fingerprint"],
  ] as const) {
    const validation = validateInput(body[field], type, label);
    if (!validation.valid) {
      return errorResponse(400, validation.error);
    }
  }
  const enabled = body.enabled ?? existing.enabled;
  const isDefault = body.isDefault ?? existing.isDefault;
  if (isDefault && !enabled) {
    return errorResponse(400, "預設 OCI 帳號必須保持啟用");
  }
  if (existing.isDefault && !isDefault) {
    return errorResponse(409, "請先將另一個 OCI 帳號設為預設");
  }

  try {
    const encrypted = typeof body.privateKeyPem === "string" && body.privateKeyPem.trim()
      ? await encryptOciCredentials({ privateKeyPem: body.privateKeyPem }, env.CREDENTIAL_ENCRYPTION_KEY)
      : {
          keyCiphertext: existing.keyCiphertext,
          keyIv: existing.keyIv,
          keyHint: existing.keyHint,
          encryptionKeyVersion: existing.encryptionKeyVersion,
        };
    const account = await updateOciAccount(env.DB, id, {
      name,
      tenancyOcid: String(body.tenancyOcid).trim(),
      userOcid: String(body.userOcid).trim(),
      fingerprint: String(body.fingerprint).trim(),
      region: String(body.region).trim(),
      compartmentOcid: String(body.compartmentOcid).trim(),
      ...encrypted,
      enabled,
      isDefault,
    });
    if (!account) {
      return errorResponse(409, "OCI 帳號名稱已存在");
    }
    return jsonResponse({ account: publicAccount(account) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCI 帳號更新失敗";
    return errorResponse(
      message.includes("UNIQUE") ? 409 : 400,
      message.includes("UNIQUE") ? "OCI 帳號名稱已存在" : message,
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
    return errorResponse(400, "OCI 帳號 ID 無效");
  }
  const result = await deleteOciAccount(env.DB, id);
  if (result.reason === "not_found") {
    return errorResponse(404, "OCI 帳號不存在");
  }
  return jsonResponse({ ok: true });
}
