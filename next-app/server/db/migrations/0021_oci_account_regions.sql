-- 0021：OCI 帳號已訂閱區域快取。來源為 ListRegionSubscriptions API
-- （tenancy 級，任一已訂閱 region 的 endpoint 皆可查）。
-- region 存 identifier（如 eu-frankfurt-1）、region_key 存 OCID 內段（如 FRA），
-- 供「從執行個體 OCID 反推 region」的對映使用（新舊 region 的 OCID 段並存）。
-- home_region 恆為帳號 home region；訂閱新區域需在 OCI 主控台操作，本表僅唯讀快取。
CREATE TABLE IF NOT EXISTS oci_account_regions (
  oci_account_id INTEGER NOT NULL REFERENCES oci_accounts(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  region_key TEXT NOT NULL,
  is_home_region INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'READY',
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (oci_account_id, region)
);

CREATE INDEX IF NOT EXISTS idx_oci_account_regions_lookup
  ON oci_account_regions (oci_account_id);
