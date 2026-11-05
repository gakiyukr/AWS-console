-- 0013：人機驗證（Cap）設定入後臺。Cap 簽章密鑰原為環境變量 CAP_SECRET，
-- 改為設定頁配置並以 AES-256-GCM 加密存此表（獨立 AAD 網域）；
-- 環境變量保留為遷移期 fallback（D1 未配置時仍可用，不需重填）。
CREATE TABLE IF NOT EXISTS captcha_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_hint TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
