-- 暫存尚未完成 OOBE 驗證的 SSO 設定；Client Secret 僅保存 AES-GCM 密文。
CREATE TABLE IF NOT EXISTS pending_sso_setup (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  jwks_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_iv TEXT NOT NULL,
  allowed_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_sso_setup_expires_at_idx
  ON pending_sso_setup (expires_at);
