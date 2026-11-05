-- 0015：多渠道人機驗證支援（Cap、Cloudflare Turnstile、hCaptcha）
CREATE TABLE IF NOT EXISTS captcha_providers (
  provider TEXT PRIMARY KEY, -- 'cap', 'turnstile', 'hcaptcha'
  enabled INTEGER NOT NULL DEFAULT 0,
  endpoint TEXT NOT NULL DEFAULT '',
  site_key TEXT NOT NULL DEFAULT '',
  secret_ciphertext TEXT,
  secret_iv TEXT,
  secret_hint TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 自動將原有 captcha_settings (id=1) 遷移為 provider = 'cap'
INSERT OR IGNORE INTO captcha_providers (provider, enabled, endpoint, site_key, secret_ciphertext, secret_iv, secret_hint, updated_at)
SELECT 'cap', 1, endpoint, site_key, secret_ciphertext, secret_iv, secret_hint, updated_at
FROM captcha_settings
WHERE id = 1 AND secret_ciphertext IS NOT NULL;
