-- 0010：機器平台區分。EC2 與 Lightsail 原本共用一張表且無平台欄位，
-- 導致 Lightsail 名稱被送進 EC2 DescribeInstances（整區批次失敗）且
-- 電源操作一律走 EC2 API。加入 platform 後，列表、狀態合併與電源操作
-- 皆可依平台分流；分享連結與稽核日誌以 machines.id 關聯，不受影響。
ALTER TABLE machines ADD COLUMN platform TEXT NOT NULL DEFAULT 'ec2';

-- 既有資料回填：EC2 執行個體 ID 固定以 i- 開頭，其餘視為 Lightsail 名稱。
UPDATE machines SET platform = 'lightsail'
  WHERE instance_id NOT LIKE 'i-%';

CREATE INDEX IF NOT EXISTS idx_machines_platform
  ON machines (platform, id);
