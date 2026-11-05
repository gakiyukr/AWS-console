-- 0014：人機驗證（Cap trycap.dev）增加實例地址（endpoint）與站點公鑰（site_key）
ALTER TABLE captcha_settings ADD COLUMN endpoint TEXT NOT NULL DEFAULT '';
ALTER TABLE captcha_settings ADD COLUMN site_key TEXT NOT NULL DEFAULT '';
