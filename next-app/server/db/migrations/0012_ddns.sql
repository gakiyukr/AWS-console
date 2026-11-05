-- 0012：DDNS（Cloudflare）整合。
-- ddns_settings 單列表存 CF API Token（AES-256-GCM 加密，主金鑰為 Worker
-- secret CREDENTIAL_ENCRYPTION_KEY、獨立 AAD 網域）與目標 zone；
-- machines 加 ddns_hostname（NULL = 未啟用 DDNS）與 ddns_record_id
-- （快取 CF 的記錄 id，同步時免重查）。
-- 換 IP／開關機成功後自動檢查 A 記錄並修正；僅 EC2（非 Wavelength）。
CREATE TABLE IF NOT EXISTS ddns_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE machines ADD COLUMN ddns_hostname TEXT;
ALTER TABLE machines ADD COLUMN ddns_record_id TEXT;
