// D1 資料存取層：所有 SQL 集中於此，路由檔只呼叫這些函式，
// 使業務邏輯可在 node --test 以記憶體 D1 樁直接驗證。
// 慣例：每個函式的第一個參數都是 D1 binding（env.DB），
// 不在模組內持有任何連線狀態，以符合 Workers 每請求注入的模式。
import {
  decryptOidcClientSecret,
  decryptPendingOidcClientSecret,
  encryptOidcClientSecret,
  encryptPendingOidcClientSecret,
} from "./credential-crypto.js";

// ─── 機器清單 ───────────────────────────────────────────────

/**
 * 取得全部受管機器（依新增順序）。
 * @param {D1Database} db
 * @returns {Promise<Array<{id:number, awsAccountId:number|null, region:string, instanceId:string, name:string, isWavelength:boolean, createdAt:string}>>}
 */
export async function listMachines(db) {
  const { results } = await db
    .prepare("SELECT id, aws_account_id AS awsAccountId, region, instance_id AS instanceId, name, is_wavelength AS isWavelength, created_at AS createdAt FROM machines ORDER BY id")
    .all();
  // is_wavelength 以 0/1 儲存，統一在此轉為布林，避免各呼叫端重複轉換
  return results.map((row) => ({ ...row, isWavelength: Boolean(row.isWavelength) }));
}

/**
 * 新增機器；同一 (region, instanceId) 重複時回 null 而非拋錯，
 * 讓路由層能回應 409 語意而不需解析 SQLite 錯誤字串。
 * @returns {Promise<{id:number}|null>} null 表示已存在
 */
export async function createMachine(db, { awsAccountId = /** @type {number|null} */ (null), region, instanceId, name, isWavelength }) {
  try {
    const result = await db
      .prepare("INSERT INTO machines (aws_account_id, region, instance_id, name, is_wavelength) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(awsAccountId, region, instanceId, name, isWavelength ? 1 : 0)
      .run();
    return { id: result.meta.last_row_id };
  } catch (error) {
    // D1 的 UNIQUE 衝突訊息含 "UNIQUE constraint failed"
    if (String(error?.message || error).includes("UNIQUE")) {
      return null;
    }
    throw error;
  }
}

/** 依主鍵取得單一機器；不存在回 null。 */
export async function getMachineById(db, id) {
  const row = await db
    .prepare("SELECT id, aws_account_id AS awsAccountId, region, instance_id AS instanceId, name, is_wavelength AS isWavelength FROM machines WHERE id = ?1")
    .bind(id)
    .first();
  return row ? { ...row, isWavelength: Boolean(row.isWavelength) } : null;
}

/** 移除機器；回傳是否確實刪除任一列。 */
export async function deleteMachine(db, id) {
  const result = await db.prepare("DELETE FROM machines WHERE id = ?1").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// ─── SSH 公鑰庫 ─────────────────────────────────────────────

/**
 * 取得全部登入用 SSH 公鑰（依新增順序）。
 * @param {D1Database} db
 * @returns {Promise<Array<{id:number, label:string, publicKey:string, createdAt:string}>>}
 */
export async function listSshPublicKeys(db) {
  const { results } = await db
    .prepare("SELECT id, label, public_key AS publicKey, created_at AS createdAt FROM ssh_public_keys ORDER BY id")
    .all();
  return results;
}

/** 依主鍵取得單一公鑰；不存在回 null。部署流程解析 ssh_key_id 時使用。 */
export async function getSshPublicKeyById(db, id) {
  return await db
    .prepare("SELECT id, label, public_key AS publicKey FROM ssh_public_keys WHERE id = ?1")
    .bind(id)
    .first() ?? null;
}

/**
 * 新增公鑰；同一 public_key 重複時回 null 而非拋錯，
 * 讓路由層能回應 409 語意而不需解析 SQLite 錯誤字串。
 * @returns {Promise<{id:number}|null>} null 表示已存在
 */
export async function createSshPublicKey(db, { label, publicKey }) {
  try {
    const result = await db
      .prepare("INSERT INTO ssh_public_keys (label, public_key) VALUES (?1, ?2)")
      .bind(label, publicKey)
      .run();
    return { id: result.meta.last_row_id };
  } catch (error) {
    // D1 的 UNIQUE 衝突訊息含 "UNIQUE constraint failed"
    if (String(error?.message || error).includes("UNIQUE")) {
      return null;
    }
    throw error;
  }
}

/** 移除公鑰；回傳是否確實刪除任一列。 */
export async function deleteSshPublicKey(db, id) {
  const result = await db.prepare("DELETE FROM ssh_public_keys WHERE id = ?1").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// ─── 操作日誌 ───────────────────────────────────────────────

/**
 * @typedef {object} OperationLogEntry
 * @property {string} action
 * @property {string | null | undefined} [region]
 * @property {string | null | undefined} [instanceId]
 * @property {string} status
 * @property {unknown} [detail]
 * @property {number | null} [awsAccountId]
 */

/**
 * 寫入一筆操作日誌。detail 接受任意值：字串直接存入，
 * 其他型別序列化為 JSON；null/undefined 存 NULL。
 * 寫入失敗不應中斷主流程，由呼叫端決定是否另行處理，
 * 因此此函式僅在資料庫層拋錯時向上傳遞（呼叫端以 catch 吞掉）。
 * @param {any} db
 * @param {OperationLogEntry} entry
 */
export async function appendOperationLog(db, entry) {
  const {
    action,
    region = null,
    instanceId = null,
    status,
    detail = null,
    awsAccountId = null,
  } = entry;
  const serialized = detail === null || detail === undefined
    ? null
    : (typeof detail === "string" ? detail : JSON.stringify(detail));
  await db
    .prepare("INSERT INTO operation_log (aws_account_id, action, region, instance_id, status, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(awsAccountId, action, region, instanceId, status, serialized)
    .run();
}

/**
 * @typedef {object} OperationLogQuery
 * @property {string} [action]
 * @property {string} [status]
 * @property {number | string} [limit]
 * @property {number | string} [awsAccountId]
 */

/**
 * 查詢操作日誌（新→舊）。
 * @param {any} db
 * @param {OperationLogQuery} [options] 可選篩選條件
 */
export async function listOperationLogs(db, options = {}) {
  const { action, status, awsAccountId, limit = 200 } = options;
  const conditions = [];
  const bindings = [];
  if (action) {
    conditions.push("action = ?");
    bindings.push(action);
  }
  if (status) {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (awsAccountId) {
    conditions.push("aws_account_id = ?");
    bindings.push(Number(awsAccountId));
  }
  const whereSql = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const numericLimit = Number(limit);
  const safeLimit = Number.isFinite(numericLimit) && numericLimit >= 1
    ? Math.min(Math.trunc(numericLimit), 1000)
    : 200;
  bindings.push(safeLimit);
  const { results } = await db
    .prepare(`SELECT id, aws_account_id AS awsAccountId, created_at AS createdAt, action, region, instance_id AS instanceId, status, detail FROM operation_log${whereSql} ORDER BY id DESC LIMIT ?`)
    .bind(...bindings)
    .all();
  return results;
}

// ─── AWS 帳號 ───────────────────────────────────────────────────────────────

const ACCOUNT_COLUMNS = "id, name, credential_ciphertext AS credentialCiphertext, credential_iv AS credentialIv, access_key_hint AS accessKeyHint, encryption_key_version AS encryptionKeyVersion, enabled, is_default AS isDefault, last_verified_at AS lastVerifiedAt, created_at AS createdAt, updated_at AS updatedAt";

function normalizeAccount(row) {
  return row ? { ...row, enabled: Boolean(row.enabled), isDefault: Boolean(row.isDefault) } : null;
}

export async function listAwsAccounts(db) {
  const { results } = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts ORDER BY id`).all();
  return results.map(normalizeAccount);
}

export async function getAwsAccountById(db, id) {
  return normalizeAccount(await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts WHERE id = ?1`).bind(id).first());
}

export async function getDefaultAwsAccount(db) {
  return normalizeAccount(await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts WHERE is_default = 1`).first());
}

export async function createAwsAccount(db, account) {
  const existing = await listAwsAccounts(db);
  if (existing.length === 0 && account.enabled === false)
    throw new Error("第一個 AWS 帳號必須保持啟用");
  if (existing.some(item => item.name === account.name))
    return null;
  const isDefault = account.isDefault || existing.length === 0;
  if (isDefault)
    await db.prepare("UPDATE aws_accounts SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1").run();
  try {
    const result = await db.prepare(`INSERT INTO aws_accounts
      (name, credential_ciphertext, credential_iv, access_key_hint, encryption_key_version, enabled, is_default)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(account.name, account.credentialCiphertext, account.credentialIv, account.accessKeyHint, account.encryptionKeyVersion, account.enabled === false ? 0 : 1, isDefault ? 1 : 0)
      .run();
    const id = result.meta.last_row_id;
    if (existing.length === 0) {
      await db.prepare("UPDATE machines SET aws_account_id = ?1 WHERE aws_account_id IS NULL").bind(id).run();
    }
    return getAwsAccountById(db, id);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE"))
      return null;
    throw error;
  }
}

export async function updateAwsAccount(db, id, account) {
  const existing = await listAwsAccounts(db);
  if (existing.some(item => item.id !== id && item.name === account.name))
    return null;
  if (account.isDefault)
    await db.prepare("UPDATE aws_accounts SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1").run();
  const result = await db.prepare(`UPDATE aws_accounts SET
    name = ?2, credential_ciphertext = ?3, credential_iv = ?4, access_key_hint = ?5,
    encryption_key_version = ?6, enabled = ?7, is_default = ?8, updated_at = datetime('now')
    WHERE id = ?1`)
    .bind(id, account.name, account.credentialCiphertext, account.credentialIv, account.accessKeyHint, account.encryptionKeyVersion, account.enabled ? 1 : 0, account.isDefault ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0 ? getAwsAccountById(db, id) : null;
}

export async function markAwsAccountVerified(db, id) {
  await db.prepare("UPDATE aws_accounts SET last_verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1").bind(id).run();
}

export async function countMachinesForAwsAccount(db, id) {
  const { results } = await db.prepare("SELECT id FROM machines WHERE aws_account_id = ?1").bind(id).all();
  return results.length;
}

export async function deleteAwsAccount(db, id) {
  if (await countMachinesForAwsAccount(db, id))
    return { deleted: false, reason: "in_use" };
  const account = await getAwsAccountById(db, id);
  if (!account)
    return { deleted: false, reason: "not_found" };
  const result = await db.prepare("DELETE FROM aws_accounts WHERE id = ?1").bind(id).run();
  if (account.isDefault) {
    const next = (await listAwsAccounts(db)).find(item => item.enabled);
    if (next)
      await db.prepare("UPDATE aws_accounts SET is_default = 1, updated_at = datetime('now') WHERE id = ?1").bind(next.id).run();
  }
  return { deleted: (result.meta.changes ?? 0) > 0 };
}


// ─── SSO 設定（OOBE 初始設定） ──────────────────────────────

/**
 * 取得 D1 內的 SSO 設定；未設定時回 null。client secret 於此解密。
 * @param {D1Database} db
 * @param {string} encryptionKey CREDENTIAL_ENCRYPTION_KEY（Base64）
 * @returns {Promise<{issuer:string, authorizationEndpoint:string, tokenEndpoint:string, jwksUri:string, clientId:string, clientSecret:string, allowedEmail:string}|null>}
 */
export async function getSsoConfig(db, encryptionKey) {
  const row = await db
    .prepare(`SELECT issuer, authorization_endpoint AS authorizationEndpoint, token_endpoint AS tokenEndpoint,
      jwks_uri AS jwksUri, client_id AS clientId, client_secret_ciphertext AS clientSecretCiphertext,
      client_secret_iv AS clientSecretIv, allowed_email AS allowedEmail FROM sso_config WHERE id = 1`)
    .first();
  if (!row) {
    return null;
  }
  const clientSecret = await decryptOidcClientSecret(row, encryptionKey);
  return { ...row, clientSecret };
}

/**
 * 儲存 OOBE 完成 SSO 驗證後的設定（單列 upsert）；client secret 加密後寫入。
 */
export async function saveSsoConfig(db, config, encryptionKey) {
  const encrypted = await encryptOidcClientSecret(config.clientSecret, encryptionKey);
  const existing = await db.prepare("SELECT id FROM sso_config WHERE id = 1").first();
  if (existing) {
    await db.prepare(`UPDATE sso_config SET issuer = ?1, authorization_endpoint = ?2, token_endpoint = ?3,
      jwks_uri = ?4, client_id = ?5, client_secret_ciphertext = ?6, client_secret_iv = ?7,
      allowed_email = ?8, updated_at = datetime('now') WHERE id = 1`)
      .bind(config.issuer, config.authorizationEndpoint, config.tokenEndpoint, config.jwksUri, config.clientId, encrypted.clientSecretCiphertext, encrypted.clientSecretIv, config.allowedEmail)
      .run();
    return;
  }
  await db
    .prepare(`INSERT INTO sso_config (id, issuer, authorization_endpoint, token_endpoint, jwks_uri,
      client_id, client_secret_ciphertext, client_secret_iv, allowed_email)
      VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(config.issuer, config.authorizationEndpoint, config.tokenEndpoint, config.jwksUri, config.clientId, encrypted.clientSecretCiphertext, encrypted.clientSecretIv, config.allowedEmail)
    .run();
}

const PENDING_SSO_SETUP_TTL_MS = 10 * 60 * 1000;

/** 將 OOBE 設定暫存於 D1；Client Secret 只以 pending 專用 AAD 加密保存。 */
export async function savePendingSsoSetup(db, setup, encryptionKey, options = {}) {
  const id = String(options.id || crypto.randomUUID());
  const createdAt = Number.isFinite(options.createdAt) ? options.createdAt : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : PENDING_SSO_SETUP_TTL_MS;
  const expiresAt = createdAt + Math.max(1, ttlMs);
  const encrypted = await encryptPendingOidcClientSecret(setup.clientSecret, encryptionKey);
  await db.prepare(`INSERT INTO pending_sso_setup
    (id, issuer, authorization_endpoint, token_endpoint, jwks_uri, client_id,
     client_secret_ciphertext, client_secret_iv, allowed_email, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(
      id,
      setup.issuer,
      setup.authorizationEndpoint,
      setup.tokenEndpoint,
      setup.jwksUri,
      setup.clientId,
      encrypted.clientSecretCiphertext,
      encrypted.clientSecretIv,
      setup.allowedEmail,
      createdAt,
      expiresAt,
    )
    .run();
  return { id, createdAt, expiresAt };
}

/** 讀取尚未完成 OOBE 驗證的設定；過期資料會視為不存在並清理。 */
export async function getPendingSsoSetup(db, id, encryptionKey, now = Date.now()) {
  if (!id) {
    return null;
  }
  const row = await db.prepare(`SELECT id, issuer,
    authorization_endpoint AS authorizationEndpoint, token_endpoint AS tokenEndpoint,
    jwks_uri AS jwksUri, client_id AS clientId,
    client_secret_ciphertext AS clientSecretCiphertext, client_secret_iv AS clientSecretIv,
    allowed_email AS allowedEmail, created_at AS createdAt, expires_at AS expiresAt
    FROM pending_sso_setup WHERE id = ?1`).bind(id).first();
  if (!row) {
    return null;
  }
  if (Number(row.expiresAt) <= now) {
    await deletePendingSsoSetup(db, id);
    return null;
  }
  const clientSecret = await decryptPendingOidcClientSecret(row, encryptionKey);
  return { ...row, clientSecret };
}

/** 刪除指定的 pending OOBE 設定。 */
export async function deletePendingSsoSetup(db, id) {
  const result = await db.prepare("DELETE FROM pending_sso_setup WHERE id = ?1").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** 清理所有已過期的 pending OOBE 設定。 */
export async function deleteExpiredPendingSsoSetups(db, now = Date.now()) {
  const result = await db.prepare("DELETE FROM pending_sso_setup WHERE expires_at <= ?1").bind(now).run();
  return result.meta.changes ?? 0;
}

/**
 * 將已通過 OIDC 驗證的 pending 設定提升為正式設定。
 * INSERT 與 DELETE 放在同一批次，並依賴 sso_config 的單列主鍵避免並行 OOBE 互相覆蓋。
 */
export async function activatePendingSsoSetup(db, id, encryptionKey, now = Date.now()) {
  const pending = await getPendingSsoSetup(db, id, encryptionKey, now);
  if (!pending) {
    return { activated: false, reason: "not_found" };
  }
  const encrypted = await encryptOidcClientSecret(pending.clientSecret, encryptionKey);
  try {
    await db.batch([
      db.prepare(`INSERT INTO sso_config
        (id, issuer, authorization_endpoint, token_endpoint, jwks_uri, client_id,
         client_secret_ciphertext, client_secret_iv, allowed_email)
        VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(
          pending.issuer,
          pending.authorizationEndpoint,
          pending.tokenEndpoint,
          pending.jwksUri,
          pending.clientId,
          encrypted.clientSecretCiphertext,
          encrypted.clientSecretIv,
          pending.allowedEmail,
        ),
      db.prepare("DELETE FROM pending_sso_setup WHERE id = ?1").bind(id),
    ]);
    return { activated: true };
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      return { activated: false, reason: "already_configured" };
    }
    throw error;
  }
}
