-- 執行個體自訂別名與備註
CREATE TABLE IF NOT EXISTS instance_aliases (
  instance_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 為 operation_log 增加 OCI 帳號關聯與 display_name 欄位
ALTER TABLE operation_log ADD COLUMN oci_account_id INTEGER
  REFERENCES oci_accounts(id) ON DELETE SET NULL;

ALTER TABLE operation_log ADD COLUMN display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_operation_log_oci_account_id
  ON operation_log (oci_account_id, id DESC);
