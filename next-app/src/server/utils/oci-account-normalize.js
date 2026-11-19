// OCI 帳號輸入共用正規化與驗證；POST、PUT 必須對同一組欄位套用相同規則。
import { importSigningKey, MAX_OCI_PRIVATE_KEY_LENGTH, normalizePrivateKeyPem } from "./oci-request.js";
import { validateInput } from "./validate.js";

const OCI_REQUIRED_FIELDS = [
  ["tenancyOcid", "tenancyOcid", "Tenancy OCID"],
  ["userOcid", "userOcid", "User OCID"],
  ["region", "region", "Region"],
  ["fingerprint", "fingerprint", "Fingerprint"],
];

/**
 * 正規化並驗證 OCI 帳號的非密鑰欄位。
 * PUT 的 input 會先以 existing 補上省略欄位；POST 沒有 existing 時則視為必填。
 * @param {Record<string, unknown>} input
 * @param {{ existing?: Record<string, unknown> | null }} [options]
 * @returns {{ valid: true, values: { name: string, tenancyOcid: string, userOcid: string, region: string, fingerprint: string, compartmentOcid: string } } | { valid: false, error: string }}
 */
export function normalizeOciAccountInput(input, { existing = null } = {}) {
  const source = input || {};
  const nameValue = source.name !== undefined ? source.name : existing?.name;
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  if (!name || name.length > 80) {
    return { valid: false, error: "帳號名稱必須為 1 至 80 個字元" };
  }

  const values = { name, tenancyOcid: "", userOcid: "", region: "", fingerprint: "", compartmentOcid: "" };
  for (const [field, type, label] of OCI_REQUIRED_FIELDS) {
    const raw = source[field] !== undefined ? source[field] : existing?.[field];
    const normalized = typeof raw === "string" ? raw.trim() : raw;
    // 指紋是唯一需要轉小寫的 OCI 欄位；OCID 僅去除首尾空白並保留原大小寫。
    values[field] = field === "fingerprint" && typeof normalized === "string"
      ? normalized.toLowerCase()
      : normalized;
    const validation = validateInput(values[field], type, label);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }
  }

  const rawCompartment = source.compartmentOcid !== undefined
    ? source.compartmentOcid
    : (existing?.compartmentOcid ?? "");
  if (rawCompartment !== null && rawCompartment !== undefined && typeof rawCompartment !== "string") {
    return { valid: false, error: "Compartment OCID 必須是字串" };
  }
  const compartmentOcid = typeof rawCompartment === "string" ? rawCompartment.trim() : "";
  // Tenancy OCID 同時就是 OCI 根 compartment；以空字串儲存並由解析層回退。
  values.compartmentOcid = compartmentOcid === values.tenancyOcid ? "" : compartmentOcid;
  if (values.compartmentOcid) {
    const validation = validateInput(values.compartmentOcid, "compartmentOcid", "Compartment OCID");
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }
  }

  return { valid: true, values };
}

/**
 * 合併私鑰欄位並在 spread 後以正規化 fingerprint 重算 keyHint。
 * @param {{ fingerprint: string, existing?: Record<string, unknown> | null, encrypted?: Record<string, unknown> | null }} options
 * @returns {Record<string, unknown>}
 */
export function mergeOciCredentialFields({ fingerprint, existing = null, encrypted = null }) {
  const keyFields = encrypted || {
    keyCiphertext: existing?.keyCiphertext,
    keyIv: existing?.keyIv,
    encryptionKeyVersion: existing?.encryptionKeyVersion,
  };
  return { ...keyFields, keyHint: fingerprint.slice(-5) };
}

/** 驗證並回傳可交給加密層的私鑰文字；不回傳 CryptoKey。 */
export async function validateOciPrivateKeyPem(value, { required = true } = {}) {
  if (typeof value !== "string") {
    return required
      ? { valid: false, error: "PEM 私鑰為必填" }
      : { valid: false, error: "PEM 私鑰必須是字串" };
  }
  if (value.length > MAX_OCI_PRIVATE_KEY_LENGTH) {
    return { valid: false, error: "PEM 私鑰內容過大" };
  }
  const pem = value.trim();
  if (!pem) {
    return required
      ? { valid: false, error: "PEM 私鑰為必填" }
      : { valid: true, value: "" };
  }
  let normalized;
  try {
    normalized = normalizePrivateKeyPem(pem);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "PEM 私鑰格式無效" };
  }
  try {
    await importSigningKey(normalized);
    return { valid: true, value: normalized };
  } catch {
    return { valid: false, error: "PEM 私鑰不是有效的 RSA 私鑰。" };
  }
}
