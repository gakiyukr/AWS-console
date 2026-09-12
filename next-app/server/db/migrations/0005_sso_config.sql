-- 0005：OOBE 初始設定用的 SSO 設定表（單列，id 恆為 1）。
-- client secret 以 CREDENTIAL_ENCRYPTION_KEY（AES-256-GCM）加密後儲存。
CREATE TABLE IF NOT EXISTS sso_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issuer TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL DEFAULT '',
  token_endpoint TEXT NOT NULL DEFAULT '',
  jwks_uri TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_iv TEXT NOT NULL,
  allowed_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
