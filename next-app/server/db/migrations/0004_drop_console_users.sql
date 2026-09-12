-- 0004：登入改為 OIDC SSO 後，密碼使用者與登入限流不再使用，予以移除。
-- 操作日誌與 AWS 帳號皆不關聯 users 表，移除不影響既有資料。
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS login_rate_limit;
