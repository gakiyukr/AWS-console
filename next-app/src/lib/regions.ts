// AWS Region 代碼對應繁體中文地名，供各頁面的 Region 下拉選單與
// 地區顯示共用。清單以 AWS 商用區域為準；未收錄的代碼（新區域、
// GovCloud、中國區等）由 regionLabel() 回退為純代碼顯示。
export const REGION_NAMES: Record<string, string> = {
  // 亞太
  'ap-northeast-1': '東京',
  'ap-northeast-2': '首爾',
  'ap-northeast-3': '大阪',
  'ap-south-1': '孟買',
  'ap-south-2': '海德拉巴',
  'ap-southeast-1': '新加坡',
  'ap-southeast-2': '雪梨',
  'ap-southeast-3': '雅加達',
  'ap-southeast-4': '墨爾本',
  'ap-southeast-5': '馬來西亞',
  'ap-southeast-6': '紐西蘭',
  'ap-southeast-7': '泰國',
  'ap-east-1': '香港',
  'ap-east-2': '台北',
  // 北美
  'us-east-1': '維吉尼亞北部',
  'us-east-2': '俄亥俄',
  'us-west-1': '加利福尼亞北部',
  'us-west-2': '奧勒岡',
  'ca-central-1': '加拿大中部',
  'ca-west-1': '加拿大西部',
  'mx-central-1': '墨西哥',
  // 歐洲
  'eu-west-1': '愛爾蘭',
  'eu-west-2': '倫敦',
  'eu-west-3': '巴黎',
  'eu-central-1': '法蘭克福',
  'eu-central-2': '蘇黎世',
  'eu-north-1': '斯德哥爾摩',
  'eu-south-1': '米蘭',
  'eu-south-2': '西班牙',
  // 南美
  'sa-east-1': '聖保羅',
  // 中東與非洲
  'me-south-1': '巴林',
  'me-central-1': '阿聯酋',
  'me-central-2': '沙烏地阿拉伯',
  'af-south-1': '開普敦',
  'il-central-1': '特拉維夫',
  // GovCloud 與中國區
  'us-gov-west-1': 'GovCloud 美西',
  'us-gov-east-1': 'GovCloud 美東',
  'cn-north-1': '北京',
  'cn-northwest-1': '寧夏',
}

/**
 * 組出「代碼 + 中文名稱」的顯示文字。
 * @param region AWS Region 代碼（例如 ap-northeast-1）
 * @returns 有對應時回傳「ap-northeast-1 東京」，否則回傳原代碼
 */
export function regionLabel(region: string): string {
  const name = REGION_NAMES[region]
  return name ? `${region} ${name}` : region
}
