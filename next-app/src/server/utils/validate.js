// 輸入驗證器：合併兩個主控台的正則全集，供 machines CRUD 與
// wavelength 部署端點共用。全部回傳 { valid, error } 而非拋錯，
// 讓路由層能直接映射為 400 回應。

const INPUT_VALIDATORS = {
  region: /^[a-z]{2}(-[a-z]+)*-\d{1}$/,
  // Wavelength Zone 命名為 <region>-wl<N>-<機場代碼>-wlz-<序號>，例如
  // ap-northeast-1-wl1-kix-wlz-1；region 段本身可能含多組字母段落（us-gov-west-1）。
  zone: /^[a-z]{2}(-[a-z]+)*-\d+-wl\d+-[a-z]{3}-wlz-?\d+$/,
  // 測試與本機環境常用短 ID（vpc-123），正式 AWS ID 為 17 位十六進位。
  vpcId: /^vpc-[0-9a-f]{1,17}$/,
  instanceType: /^[a-z][0-9][a-z]?\.[a-z0-9]+$/,
  // 測試與本機環境常用短 ID（i-123、i-wl-existing），正式 AWS ID 為 17 位十六進位。
  instanceId: /^i-[0-9a-z-]{1,17}$/,
  os: /^[a-z0-9_-]+$/,
  // subnet 與 SG ID 同為 8 字元前綴 + 十七位十六進位的 AWS ID 形態
  subnetId: /^subnet-[0-9a-f]{1,17}$/,
  securityGroupId: /^sg-[0-9a-f]{1,17}$/,
};

const MAX_STRING_LENGTH = 256;

/**
 * 驗證字串輸入。
 * @param {unknown} value 待驗證值
 * @param {(keyof typeof INPUT_VALIDATORS) | undefined} type 驗證類別（無對應正則時僅檢查基本條件）
 * @param {string} fieldName 錯誤訊息中的欄位名稱（繁體中文）
 */
export function validateInput(value, type, fieldName) {
  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} 必須是字串` };
  }

  if (value.length === 0) {
    return { valid: false, error: `${fieldName} 不能為空` };
  }

  if (value.length > MAX_STRING_LENGTH) {
    return { valid: false, error: `${fieldName} 長度超過限制` };
  }

  const pattern = INPUT_VALIDATORS[type];
  if (pattern && !pattern.test(value)) {
    return { valid: false, error: `${fieldName} 格式無效` };
  }

  return { valid: true, error: "" };
}
