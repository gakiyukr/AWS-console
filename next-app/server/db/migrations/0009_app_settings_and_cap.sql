-- 0009：後台全域設定與 Cap 人機驗證的伺服端狀態。
-- app_settings 為通用 KV 設定表（目前僅存分享頁人機驗證開關 share_captcha_enabled）。
-- cap_nonces 記錄已兌換的 PoW challenge JWT 簽章，防止同一解答重放（capjs-core
-- 的 consumeNonce 回呼落點）；cap_tokens 保存通過驗證後的一次性憑證
-- （tokenKey = id:sha256(vertoken)），換 IP 時以條件式 DELETE 原子單次消費。
-- 兩張 cap 表皆有 TTL，靠路由端 best-effort 清理過期列。
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cap_nonces (
  sig TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cap_nonces_expires_at_idx
  ON cap_nonces (expires_at);

CREATE TABLE IF NOT EXISTS cap_tokens (
  token_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cap_tokens_expires_at_idx
  ON cap_tokens (expires_at);
