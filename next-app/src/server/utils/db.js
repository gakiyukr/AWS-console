// D1 資料存取層：所有 SQL 集中於此，路由檔只呼叫這些函式。
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
 * 取得受管機器（依新增順序）。可依平台篩選（"ec2" | "lightsail"），
 * 省略時回傳全部——分享連結管理頁需要跨平台清單。
 * @param {D1Database} db
 * @param {"ec2" | "lightsail" | null} [platform]
 * @returns {Promise<Array<{id:number, awsAccountId:number|null, region:string, instanceId:string, name:string, platform:string, isWavelength:boolean, createdAt:string}>>}
 */
export async function listMachines(db, platform = null) {
  const base = "SELECT id, aws_account_id AS awsAccountId, region, instance_id AS instanceId, name, platform, is_wavelength AS isWavelength, created_at AS createdAt FROM machines";
  const statement = platform
    ? db.prepare(`${base} WHERE platform = ?1 ORDER BY id`).bind(platform)
    : db.prepare(`${base} ORDER BY id`);
  const { results } = await statement.all();
  // is_wavelength 以 0/1 儲存，統一在此轉為布林，避免各呼叫端重複轉換
  return results.map((row) => ({ ...row, isWavelength: Boolean(row.isWavelength) }));
}

/**
 * 新增機器；同一 (region, instanceId) 重複時回 null 而非拋錯，
 * 讓路由層能回應 409 語意而不需解析 SQLite 錯誤字串。
 * @returns {Promise<{id:number}|null>} null 表示已存在
 */
export async function createMachine(db, { awsAccountId = /** @type {number|null} */ (null), region, instanceId, name, isWavelength, platform = "ec2" }) {
  try {
    const result = await db
      .prepare("INSERT INTO machines (aws_account_id, region, instance_id, name, is_wavelength, platform) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(awsAccountId, region, instanceId, name, isWavelength ? 1 : 0, platform)
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
    .prepare("SELECT id, aws_account_id AS awsAccountId, region, instance_id AS instanceId, name, platform, is_wavelength AS isWavelength FROM machines WHERE id = ?1")
    .bind(id)
    .first();
  return row ? { ...row, isWavelength: Boolean(row.isWavelength) } : null;
}

/** 移除機器；同時清理分享連結的綁定關聯，回傳是否確實刪除任一列。 */
export async function deleteMachine(db, id) {
  const results = await db.batch([
    db.prepare("DELETE FROM share_link_machines WHERE machine_id = ?1").bind(id),
    db.prepare("DELETE FROM machines WHERE id = ?1").bind(id),
  ]);
  return (results[1].meta.changes ?? 0) > 0;
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

async function countMachinesForAwsAccount(db, id) {
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


// ─── 分享連結（對外一鍵換 IP） ─────────────────────────────

const SHARE_LINK_COLUMNS = "id, name, token, cooldown_minutes AS cooldownMinutes, enabled, created_at AS createdAt, updated_at AS updatedAt, last_used_at AS lastUsedAt";

function normalizeShareLink(row) {
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

/** 依主鍵取得單一連結（不含綁定機器）；不存在回 null。 */
export async function getShareLinkById(db, id) {
  return normalizeShareLink(await db
    .prepare(`SELECT ${SHARE_LINK_COLUMNS} FROM share_links WHERE id = ?1`)
    .bind(id)
    .first());
}

/**
 * 依 token 取得連結與其綁定機器（含各機器的最後觸發時間）。
 * token 是 URL 即憑證，以明文比對 UNIQUE 索引；不存在回 null。
 * @returns {Promise<{id:number, name:string, token:string, cooldownMinutes:number,
 *   enabled:boolean, createdAt:string, updatedAt:string, lastUsedAt:string|null,
 *   machines:Array<{id:number, name:string, region:string, lastTriggeredAt:number|null}>}|null>}
 */
export async function getShareLinkByToken(db, token) {
  if (!token) {
    return null;
  }
  const row = await db
    .prepare(`SELECT ${SHARE_LINK_COLUMNS} FROM share_links WHERE token = ?1`)
    .bind(token)
    .first();
  if (!row) {
    return null;
  }
  const link = normalizeShareLink(row);
  const { results } = await db
    .prepare(`SELECT sm.machine_id AS id, m.name, m.region, sm.last_triggered_at AS lastTriggeredAt
      FROM share_link_machines sm
      JOIN machines m ON m.id = sm.machine_id
      WHERE sm.share_link_id = ?1
      ORDER BY sm.machine_id`)
    .bind(link.id)
    .all();
  return { ...link, machines: results };
}

/**
 * 取得全部分享連結，每條附帶綁定機器的名稱與地區（管理頁顯示用）。
 */
export async function listShareLinks(db) {
  const { results } = await db
    .prepare(`SELECT ${SHARE_LINK_COLUMNS} FROM share_links ORDER BY id`)
    .all();
  const { results: bindings } = await db
    .prepare(`SELECT share_link_id AS shareLinkId, sm.machine_id AS id, m.name, m.region
      FROM share_link_machines sm
      JOIN machines m ON m.id = sm.machine_id
      ORDER BY sm.machine_id`)
    .all();
  return results.map((link) => ({
    ...normalizeShareLink(link),
    machines: bindings
      .filter(binding => binding.shareLinkId === link.id)
      .map(({ id, name, region }) => ({ id, name, region })),
  }));
}

/** 寫入連結與機器的綁定關聯（呼叫端已確保機器存在）。 */
async function bindShareLinkMachines(db, shareLinkId, machineIds) {
  if (machineIds.length === 0) {
    return;
  }
  await db.batch(machineIds.map(machineId =>
    db.prepare("INSERT INTO share_link_machines (share_link_id, machine_id) VALUES (?1, ?2)")
      .bind(shareLinkId, machineId)));
}

/**
 * 建立連結；token 撞 UNIQUE 時回 null（呼叫端回 409/500 語意）。
 * @returns {Promise<{id:number}|null>}
 */
export async function createShareLink(db, { name, token, cooldownMinutes, machineIds }) {
  try {
    const result = await db
      .prepare("INSERT INTO share_links (name, token, cooldown_minutes) VALUES (?1, ?2, ?3)")
      .bind(name, token, cooldownMinutes)
      .run();
    const id = result.meta.last_row_id;
    await bindShareLinkMachines(db, id, machineIds);
    return { id };
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      return null;
    }
    throw error;
  }
}

/**
 * 部分更新連結；僅更新有提供的欄位。回傳更新後的連結，不存在回 null。
 * @param {{ name?: string, cooldownMinutes?: number, enabled?: boolean }} updates
 */
export async function updateShareLink(db, id, updates) {
  const sets = [];
  const bindings = [];
  if (updates.name !== undefined) {
    sets.push("name = ?");
    bindings.push(updates.name);
  }
  if (updates.cooldownMinutes !== undefined) {
    sets.push("cooldown_minutes = ?");
    bindings.push(updates.cooldownMinutes);
  }
  if (updates.enabled !== undefined) {
    sets.push("enabled = ?");
    bindings.push(updates.enabled ? 1 : 0);
  }
  if (sets.length === 0) {
    return getShareLinkById(db, id);
  }
  sets.push("updated_at = datetime('now')");
  const result = await db
    .prepare(`UPDATE share_links SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...bindings, id)
    .run();
  return (result.meta.changes ?? 0) > 0 ? getShareLinkById(db, id) : null;
}

/** 刪除連結與其綁定關聯；回傳是否確實刪除任一列。 */
export async function deleteShareLink(db, id) {
  const results = await db.batch([
    db.prepare("DELETE FROM share_link_machines WHERE share_link_id = ?1").bind(id),
    db.prepare("DELETE FROM share_links WHERE id = ?1").bind(id),
  ]);
  return (results[1].meta.changes ?? 0) > 0;
}

/**
 * 以條件式 UPDATE 原子搶取「連結×機器」的換 IP 觸發權：
 * cooldownMs 為 0（不限）或 last_triggered_at 已超過冷卻期時才會更新成功。
 * 回傳 false 表示綁定不存在、冷卻中，或已被併發請求搶走。
 */
export async function claimShareRotation(db, shareLinkId, machineId, now, cooldownMs) {
  const result = await db
    .prepare(`UPDATE share_link_machines SET last_triggered_at = ?3
      WHERE share_link_id = ?1 AND machine_id = ?2
        AND (?4 <= 0 OR last_triggered_at IS NULL OR last_triggered_at <= ?3 - ?4)`)
    .bind(shareLinkId, machineId, now, cooldownMs)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 讀取單一綁定關聯（搶鎖失敗時計算剩餘冷卻用）；不存在回 null。 */
export async function getShareLinkMachineBinding(db, shareLinkId, machineId) {
  return await db
    .prepare("SELECT share_link_id AS shareLinkId, machine_id AS machineId, last_triggered_at AS lastTriggeredAt FROM share_link_machines WHERE share_link_id = ?1 AND machine_id = ?2")
    .bind(shareLinkId, machineId)
    .first() ?? null;
}

/** 觸發換 IP 後更新連結的最後使用時間。 */
export async function touchShareLinkUsed(db, id) {
  await db.prepare("UPDATE share_links SET last_used_at = datetime('now') WHERE id = ?1").bind(id).run();
}

// ─── 全域設定（KV） ────────────────────────────────────────

/** 讀取單一設定值；不存在回 null。 */
export async function getAppSetting(db, key) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?1").bind(key).first();
  return row?.value ?? null;
}

/** 寫入（upsert）單一設定值。 */
export async function setAppSetting(db, key, value) {
  await db
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`)
    .bind(key, value)
    .run();
}

// ─── Cap 人機驗證狀態 ──────────────────────────────────────

/**
 * 消費 PoW challenge 的重放防護：簽章插入即成功，UNIQUE 衝突代表重放。
 * 對應 capjs-core 的 consumeNonce(sigHex, ttlMs) 回呼。
 */
export async function consumeCapNonce(db, sig, ttlMs) {
  try {
    await db.prepare("INSERT INTO cap_nonces (sig, expires_at) VALUES (?1, ?2)")
      .bind(sig, Date.now() + Math.max(1, Math.trunc(ttlMs)))
      .run();
    return true;
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      return false;
    }
    throw error;
  }
}

/** 保存通過人機驗證的一次性憑證（tokenKey → 到期時間，epoch ms）。 */
export async function storeCapToken(db, tokenKey, expiresAt) {
  await db.prepare("INSERT INTO cap_tokens (token_key, expires_at) VALUES (?1, ?2)")
    .bind(tokenKey, expiresAt)
    .run();
}

/** 讀取人機驗證憑證的到期時間（epoch ms）；不存在回 null。查驗用，不消費。 */
export async function getCapTokenExpiry(db, tokenKey) {
  const row = await db.prepare("SELECT expires_at AS expiresAt FROM cap_tokens WHERE token_key = ?1")
    .bind(tokenKey)
    .first();
  return row ? Number(row.expiresAt) : null;
}

/**
 * 單次消費人機驗證憑證：條件式 DELETE 同時判定存在與未過期，
 * 回傳 false 表示不存在、已過期或已被併發請求使用。
 */
export async function consumeCapToken(db, tokenKey, now = Date.now()) {
  const result = await db.prepare("DELETE FROM cap_tokens WHERE token_key = ?1 AND expires_at > ?2")
    .bind(tokenKey, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 清理過期的 cap 重放記錄與憑證；由路由端 best-effort 呼叫。 */
export async function deleteExpiredCapRows(db, now = Date.now()) {
  await db.batch([
    db.prepare("DELETE FROM cap_nonces WHERE expires_at <= ?1").bind(now),
    db.prepare("DELETE FROM cap_tokens WHERE expires_at <= ?1").bind(now),
  ]);
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
async function deletePendingSsoSetup(db, id) {
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
