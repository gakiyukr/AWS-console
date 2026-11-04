-- 0011：帳號區域快取。新增帳號時抓取該帳號已開通的區域（EC2=opt-in 已啟用、
-- Lightsail=完整區域清單）存入此表，開機器的區域下拉只讀快取，
-- 避免每次即時呼叫 AWS，也讓清單可控。更新點：建立帳號自動抓取、
-- 「開通區域」成功後併入、帳號頁手動重新整理；讀取時快取為空則自動回填。
CREATE TABLE IF NOT EXISTS account_regions (
  aws_account_id INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  region TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (aws_account_id, platform, region)
);

CREATE INDEX IF NOT EXISTS idx_account_regions_lookup
  ON account_regions (aws_account_id, platform);
