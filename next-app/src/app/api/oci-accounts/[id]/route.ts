// /api/oci-accounts/[id]：PUT 更新 OCI 帳號（PEM 留空表示不替換）；
// DELETE 刪除帳號。
import { encryptOciCredentials } from "@/server/utils/credential-crypto.js";
import { deleteOciAccount, getOciAccountById, replaceCachedOciRegions, updateOciAccount } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import {
  mergeOciCredentialFields,
  normalizeOciAccountInput,
  validateOciPrivateKeyPem,
} from "@/server/utils/oci-account-normalize.js";
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
  const normalized = normalizeOciAccountInput(body, { existing });
  if (!normalized.valid) {
    return errorResponse(400, normalized.error ?? "OCI 帳號資料無效");
  }
  const privateKey = body.privateKeyPem === undefined || body.privateKeyPem === null
    ? { valid: true as const, value: "" }
    : await validateOciPrivateKeyPem(body.privateKeyPem, { required: false });
  if (!privateKey.valid) {
    return errorResponse(400, privateKey.error ?? "PEM 私鑰格式無效");
  }
  const enabled = body.enabled ?? existing.enabled;
  const isDefault = body.isDefault ?? existing.isDefault;
  if (typeof enabled !== "boolean" || typeof isDefault !== "boolean") {
    return errorResponse(400, "啟用與預設狀態必須是布林值");
  }
  if (isDefault && !enabled) {
    return errorResponse(400, "預設 OCI 帳號必須保持啟用");
  }
  if (existing.isDefault && !isDefault) {
    return errorResponse(409, "請先將另一個 OCI 帳號設為預設");
  }
  // 出口代理綁定：proxyId 為 null/空字串表示解除綁定（回直連）
  let proxyId = existing.proxyId;
  if (body.proxyId !== undefined) {
    const parsed = body.proxyId === null || body.proxyId === "" ? null : Number(body.proxyId);
    if (parsed !== null && (!Number.isSafeInteger(parsed) || parsed <= 0)) {
      return errorResponse(400, "代理 ID 無效");
    }
    proxyId = parsed;
  }

  try {
    let encrypted = {
      keyCiphertext: existing.keyCiphertext,
      keyIv: existing.keyIv,
      encryptionKeyVersion: existing.encryptionKeyVersion,
    };
    if (privateKey.value) {
      if (!env.CREDENTIAL_ENCRYPTION_KEY) {
        return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
      }
      encrypted = await encryptOciCredentials({ privateKeyPem: privateKey.value }, env.CREDENTIAL_ENCRYPTION_KEY);
    }
    const { name, tenancyOcid, userOcid, fingerprint, region, compartmentOcid } = normalized.values;
    const account = await updateOciAccount(env.DB, id, {
      name,
      tenancyOcid,
      userOcid,
      fingerprint,
      region,
      compartmentOcid,
      ...mergeOciCredentialFields({ fingerprint, existing, encrypted }),
      enabled,
      isDefault,
      proxyId,
    });
    if (!account) {
      return errorResponse(409, "OCI 帳號名稱已存在");
    }
    if (tenancyOcid !== existing.tenancyOcid) {
      try {
        await replaceCachedOciRegions(env.DB, id, []);
      } catch {
        // 清快取失敗不阻擋更新結果
      }
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
