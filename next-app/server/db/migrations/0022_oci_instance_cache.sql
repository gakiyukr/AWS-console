-- 0022：OCI 執行個體清單快取。對應 AWS 的 machines 表模式：
-- 列表頁預設讀此表（不打 OCI API），只有手動「重新整理」或快取為空時
-- 才呼叫 ListInstances 並整批覆蓋。IP／狀態等欄位為同步當下的快照。
-- 電源操作後的即時狀態仍由單台查詢（/api/instances/[id]）取得。
CREATE TABLE IF NOT EXISTS oci_instance_cache (
  oci_account_id INTEGER NOT NULL REFERENCES oci_accounts(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT '',
  shape TEXT NOT NULL DEFAULT '',
  availability_domain TEXT NOT NULL DEFAULT '',
  time_created TEXT,
  public_ip TEXT,
  ipv6_address TEXT,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (oci_account_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_oci_instance_cache_lookup
  ON oci_instance_cache (oci_account_id, region);
