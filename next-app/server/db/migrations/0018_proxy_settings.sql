-- 0018：API 出口代理（HTTP / HTTPS / SOCKS5）設定。
CREATE TABLE IF NOT EXISTS proxy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  protocol TEXT NOT NULL DEFAULT 'http', -- 'http' | 'https' | 'socks5'
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 8080,
  username TEXT,
  password_ciphertext TEXT,
  password_iv TEXT,
  password_hint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
