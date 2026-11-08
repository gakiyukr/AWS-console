-- 0020：分享連結每日配額。每條連結一天最多更換 N 次 IP（跨綁定機器合計），
-- daily_limit = 0 表示不限。計數表以 (share_link_id, day) 為主鍵自然隔離，
-- day 為 UTC+8 日期字串（'YYYY-MM-DD'，台灣時間的「一天」）。
ALTER TABLE share_links ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS share_link_daily_usage (
  share_link_id INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_link_id, day)
);
