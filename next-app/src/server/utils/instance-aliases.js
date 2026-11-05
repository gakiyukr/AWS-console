// 執行個體別名與備註資料存取（instance_aliases 表）。
/**
 * 取得所有執行個體別名映射表：{ [instanceId]: { alias, notes, updatedAt } }。
 * @param {D1Database} db
 */
export async function getAllInstanceAliases(db) {
  try {
    const { results } = await db
      .prepare("SELECT instance_id, alias, notes, updated_at FROM instance_aliases")
      .all();
    const map = {};
    for (const row of results || []) {
      map[String(row.instance_id)] = {
        alias: String(row.alias || ""),
        notes: String(row.notes || ""),
        updatedAt: String(row.updated_at || ""),
      };
    }
    return map;
  } catch {
    // 表尚未遷移時回傳空物件
    return {};
  }
}

/**
 * 取得單一執行個體別名。
 * @param {D1Database} db
 * @param {string} instanceId
 */
export async function getInstanceAlias(db, instanceId) {
  try {
    const row = await db
      .prepare("SELECT instance_id, alias, notes, updated_at FROM instance_aliases WHERE instance_id = ?")
      .bind(instanceId)
      .first();
    if (!row) return null;
    return {
      instanceId: String(row.instance_id),
      alias: String(row.alias || ""),
      notes: String(row.notes || ""),
      updatedAt: String(row.updated_at || ""),
    };
  } catch {
    return null;
  }
}

/**
 * 設定（或更新）執行個體別名與備註。
 * @param {D1Database} db
 * @param {string} instanceId
 * @param {string} alias
 * @param {string} [notes]
 */
export async function setInstanceAlias(db, instanceId, alias, notes = "") {
  await db
    .prepare(
      `INSERT INTO instance_aliases (instance_id, alias, notes, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(instance_id) DO UPDATE SET
         alias = excluded.alias,
         notes = excluded.notes,
         updated_at = datetime('now')`,
    )
    .bind(instanceId, alias.trim(), (notes || "").trim())
    .run();
}

/**
 * 刪除執行個體別名。
 * @param {D1Database} db
 * @param {string} instanceId
 */
export async function deleteInstanceAlias(db, instanceId) {
  await db
    .prepare("DELETE FROM instance_aliases WHERE instance_id = ?")
    .bind(instanceId)
    .run();
}
