-- 合併版初始 schema：機器清單、操作日誌、登入限流三張表。
-- 機器清單取代舊電源主控台寫死的 TARGETS 常數；UNIQUE 約束防止同一
-- (region, instance_id) 重複登記。
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_wavelength INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(region, instance_id)
);

-- 操作日誌：電源操作與部署流程的成功／失敗皆記錄一筆，
-- detail 存錯誤訊息或結果 JSON 摘要，供 /logs 頁稽核。
CREATE TABLE IF NOT EXISTS operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  region TEXT,
  instance_id TEXT,
  status TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_log_created_at
  ON operation_log (created_at DESC);

-- 登入限流：以用戶端 IP 為鍵的滑動視窗計數 + 封鎖期限。
-- 時間戳以 epoch 毫秒儲存（INTEGER），寫入一律走原子 upsert，
-- 避免跨 isolate 的讀改寫競態。
CREATE TABLE IF NOT EXISTS login_rate_limit (
  ip TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);
