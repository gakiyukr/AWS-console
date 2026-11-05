-- OCI 帳號憑證：API 簽章金鑰組（Tenancy OCID + User OCID + Fingerprint + PEM）。
-- PEM 私鑰僅以 AES-256-GCM 密文保存；解密主金鑰必須由 Worker Secret
-- （CREDENTIAL_ENCRYPTION_KEY）提供，不落庫。
CREATE TABLE IF NOT EXISTS oci_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tenancy_ocid TEXT NOT NULL,
  user_ocid TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  region TEXT NOT NULL,
  compartment_ocid TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  -- PEM 私鑰不回傳瀏覽器，UI 僅顯示指紋尾碼供辨識
  key_hint TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oci_accounts_default
  ON oci_accounts (is_default) WHERE is_default = 1;
