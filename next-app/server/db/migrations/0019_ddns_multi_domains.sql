-- 0019：DDNS 重構為多域名＋「前綴 → 機器」集中綁定。
-- 舊架構：ddns_settings 單列（一個 zone）＋ machines.ddns_hostname（一機一 FQDN）。
-- 新架構：ddns_domains 可掛多個 zone（各自 Token 加密）；ddns_bindings 以
-- 「前綴 → 機器」綁定（FQDN = prefix + "." + zone_name），一機可綁多前綴、
-- 同 (domain, prefix) 唯一（一個 A 記錄只能指向一台機器）。
-- 舊資料自動遷移：單列設定 → ddns_domains；舊 FQDN 綁定 → 拆出 prefix。

CREATE TABLE IF NOT EXISTS ddns_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_name TEXT NOT NULL UNIQUE,
  zone_id TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ddns_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES ddns_domains(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  record_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain_id, prefix)
);

-- 遷移舊單列設定（若有）
INSERT OR IGNORE INTO ddns_domains (zone_name, zone_id, token_ciphertext, token_iv, token_hint)
SELECT zone_name, zone_id, token_ciphertext, token_iv, token_hint
FROM ddns_settings
WHERE id = 1;

-- 遷移舊 FQDN 綁定：hostname 去掉 zone 尾即為 prefix
-- （hostname 不符 zone 尾者整列略過——不屬於任何已登錄 zone）
INSERT OR IGNORE INTO ddns_bindings (domain_id, prefix, machine_id, record_id)
SELECT d.id,
       CASE WHEN lower(m.ddns_hostname) = lower(d.zone_name)
            THEN ''
            WHEN lower(m.ddns_hostname) LIKE '%.' || lower(d.zone_name)
            THEN substr(m.ddns_hostname, 1, length(m.ddns_hostname) - length(d.zone_name) - 1)
            ELSE NULL END,
       m.id,
       m.ddns_record_id
FROM machines m
JOIN ddns_domains d
  ON lower(m.ddns_hostname) = lower(d.zone_name)
  OR lower(m.ddns_hostname) LIKE '%.' || lower(d.zone_name)
WHERE m.ddns_hostname IS NOT NULL;

-- 舊欄位與舊表移除
ALTER TABLE machines DROP COLUMN ddns_hostname;
ALTER TABLE machines DROP COLUMN ddns_record_id;
DROP TABLE ddns_settings;
