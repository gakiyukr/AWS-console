const KEY_VERSION = 1;
const AAD = new TextEncoder().encode(`aws-console-credentials:v${KEY_VERSION}`);

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  try {
    const binary = atob(String(value || ""));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error("憑證加密主金鑰格式無效");
  }
}

async function importEncryptionKey(base64Key) {
  const keyBytes = base64ToBytes(base64Key);
  if (keyBytes.byteLength !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY 必須是 32 位元組的 Base64 值");
  }
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 將 AWS 憑證加密為可寫入 D1 的欄位；回傳值不包含明文。 */
export async function encryptAwsCredentials(credentials, base64Key) {
  const payload = {
    accessKeyId: String(credentials.accessKeyId || "").trim(),
    secretAccessKey: String(credentials.secretAccessKey || ""),
    sessionToken: String(credentials.sessionToken || ""),
  };
  if (!payload.accessKeyId || !payload.secretAccessKey) {
    throw new Error("Access Key ID 與 Secret Access Key 為必填");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(base64Key);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    credentialCiphertext: bytesToBase64(new Uint8Array(encrypted)),
    credentialIv: bytesToBase64(iv),
    accessKeyHint: payload.accessKeyId.slice(-4),
    encryptionKeyVersion: KEY_VERSION,
  };
}

/** 解密 D1 帳號資料；只有伺服器端 AWS 呼叫可使用此函式。 */
export async function decryptAwsCredentials(account, base64Key) {
  if (Number(account.encryptionKeyVersion) !== KEY_VERSION) {
    throw new Error("不支援此 AWS 憑證的加密版本");
  }
  try {
    const key = await importEncryptionKey(base64Key);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(account.credentialIv),
        additionalData: AAD,
        tagLength: 128,
      },
      key,
      base64ToBytes(account.credentialCiphertext),
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (error) {
    if (String(error?.message || "").includes("CREDENTIAL_ENCRYPTION_KEY"))
      throw error;
    throw new Error("AWS 憑證解密失敗，請確認加密主金鑰未被更換");
  }
}

export function generateCredentialEncryptionKey() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

// OIDC client secret 使用獨立 AAD 網域，與 AWS 憑證密文隔離
const OIDC_SECRET_AAD = new TextEncoder().encode(`aws-console-oidc-secret:v${KEY_VERSION}`);
const PENDING_OIDC_SECRET_AAD = new TextEncoder().encode(`aws-console-pending-oidc-secret:v${KEY_VERSION}`);

/** 將 OIDC client secret 加密為可寫入 D1 的欄位；回傳值不包含明文。 */
export async function encryptOidcClientSecret(secret, base64Key) {
  if (typeof secret !== "string" || !secret) {
    throw new Error("client secret 為必填");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(base64Key);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: OIDC_SECRET_AAD, tagLength: 128 },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    clientSecretCiphertext: bytesToBase64(new Uint8Array(encrypted)),
    clientSecretIv: bytesToBase64(iv),
  };
}

/** 解密 D1 內的 OIDC client secret；只有伺服器端登入流程可使用。 */
export async function decryptOidcClientSecret(record, base64Key) {
  try {
    const key = await importEncryptionKey(base64Key);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(record.clientSecretIv),
        additionalData: OIDC_SECRET_AAD,
        tagLength: 128,
      },
      key,
      base64ToBytes(record.clientSecretCiphertext),
    );
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    if (String(error?.message || "").includes("CREDENTIAL_ENCRYPTION_KEY"))
      throw error;
    throw new Error("OIDC client secret 解密失敗，請確認加密主金鑰未被更換");
  }
}

/** 將尚未完成驗證的 OIDC Client Secret 加密，供 pending_sso_setup 使用。 */
export async function encryptPendingOidcClientSecret(secret, base64Key) {
  if (typeof secret !== "string" || !secret) {
    throw new Error("Client Secret 必須填寫");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(base64Key);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: PENDING_OIDC_SECRET_AAD, tagLength: 128 },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    clientSecretCiphertext: bytesToBase64(new Uint8Array(encrypted)),
    clientSecretIv: bytesToBase64(iv),
  };
}

/** 解密 pending_sso_setup 中的 OIDC Client Secret。 */
export async function decryptPendingOidcClientSecret(record, base64Key) {
  try {
    const key = await importEncryptionKey(base64Key);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(record.clientSecretIv),
        additionalData: PENDING_OIDC_SECRET_AAD,
        tagLength: 128,
      },
      key,
      base64ToBytes(record.clientSecretCiphertext),
    );
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    if (String(error?.message || "").includes("CREDENTIAL_ENCRYPTION_KEY"))
      throw error;
    throw new Error("暫存 OIDC Client Secret 解密失敗，請確認加密主金鑰未被更換");
  }
}
