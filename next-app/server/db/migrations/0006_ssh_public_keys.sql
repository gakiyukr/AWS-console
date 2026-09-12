-- 0006：機器登入用 SSH 公鑰庫。公鑰為公開資料以明文儲存，
-- label 僅供設定頁與部署表單辨識；UNIQUE 避免同一把金鑰重複登錄。
CREATE TABLE IF NOT EXISTS ssh_public_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
