-- AWS 憑證僅以 AES-GCM 密文保存；解密主金鑰必須由 Worker Secret 提供。
CREATE TABLE IF NOT EXISTS aws_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  access_key_hint TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aws_accounts_default
  ON aws_accounts (is_default) WHERE is_default = 1;

-- 重建機器表，讓不同 AWS 帳號可管理相同 Region 與 Instance ID 組合。
CREATE TABLE machines_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aws_account_id INTEGER REFERENCES aws_accounts(id) ON DELETE RESTRICT,
  region TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_wavelength INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(aws_account_id, region, instance_id)
);

INSERT INTO machines_v2 (id, region, instance_id, name, is_wavelength, created_at)
SELECT id, region, instance_id, name, is_wavelength, created_at FROM machines;

DROP TABLE machines;
ALTER TABLE machines_v2 RENAME TO machines;

ALTER TABLE operation_log ADD COLUMN aws_account_id INTEGER
  REFERENCES aws_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operation_log_aws_account_id
  ON operation_log (aws_account_id, id DESC);

-- 密碼只保存 PBKDF2 衍生值與隨機鹽；auth_version 用於立即撤銷既有 session。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
