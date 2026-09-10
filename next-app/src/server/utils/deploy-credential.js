// 部署請求的憑證解析：把請求本體的 credential_type/ssh_key_id/root_password
// 轉為部署 util 使用的 credential 物件。公鑰模式自 D1 公鑰庫取回金鑰內容，
// 密碼模式僅沿用請求值（不落任何儲存）。格式與長度的深度驗證由
// wavelength.js 的 resolveDeployCredential 在部署流程內執行，
// 此處僅做能直接映射 400 的結構檢查。
import { getSshPublicKeyById } from "./db.js";

/**
 * @param {D1Database} db
 * @param {Record<string, unknown>} body 部署請求本體
 * @returns {Promise<{credential?: object, error?: string}>}
 */
export async function resolveRequestCredential(db, body) {
  if (body?.credential_type === "ssh_key") {
    const id = Number(body.ssh_key_id);
    if (!Number.isInteger(id) || id <= 0) {
      return { error: "SSH 公鑰 ID 無效。" };
    }
    const stored = db ? await getSshPublicKeyById(db, id) : null;
    if (!stored) {
      return { error: "找不到指定的 SSH 公鑰，請先在設定頁新增。" };
    }
    return { credential: { type: "ssh_key", keys: [stored.publicKey] } };
  }
  if (body?.credential_type === "password") {
    if (typeof body.root_password !== "string" || body.root_password.length === 0) {
      return { error: "缺少 root 密碼。" };
    }
    return { credential: { type: "password", password: body.root_password } };
  }
  return { error: "登入憑證類型無效，必須是 ssh_key 或 password。" };
}
