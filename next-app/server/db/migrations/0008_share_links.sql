-- 0008：對外分享的「一鍵換 IP」連結。訪客以 /share/<token> 開啟公開頁，
-- 觸發 stop → start 更換機器公網 IP。token 依需求以明文儲存（URL 即憑證），
-- cooldown_minutes 為訪客側觸發冷卻（0 = 不限）；綁定表按「連結×機器」
-- 記錄最後觸發時間（epoch 毫秒），多機頁面各機器的冷卻互不影響。
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  cooldown_minutes INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- 機器自清單移除或連結被刪除時，綁定關聯一併清理；
-- 主控台的 deleteMachine 亦以批次明確刪除，不單獨依賴 FK 行為。
CREATE TABLE IF NOT EXISTS share_link_machines (
  share_link_id INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  last_triggered_at INTEGER,
  PRIMARY KEY (share_link_id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_share_link_machines_machine
  ON share_link_machines (machine_id);
