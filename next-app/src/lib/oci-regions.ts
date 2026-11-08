// Oracle Cloud 官方商業區域清單（region identifier → 顯示名稱）。
// 依 Oracle 官方文件整理；政府雲（us-gov-*／uk-gov-*）與專用區域未列入，
// 如需使用請改以帳號編輯流程的資料庫路徑補值。
// region identifier 由 Oracle 固定指派、不隨租用戶變動，可安全寫死。

export interface OciRegionOption {
  value: string
  label: string
}

export const OCI_REGIONS: OciRegionOption[] = [
  { value: "ap-chuncheon-1", label: "韓國 春川 (ap-chuncheon-1)" },
  { value: "ap-chuncheon-2", label: "韓國 春川 2 (ap-chuncheon-2)" },
  { value: "ap-hyderabad-1", label: "印度 海德拉巴 (ap-hyderabad-1)" },
  { value: "ap-melbourne-1", label: "澳洲 墨爾本 (ap-melbourne-1)" },
  { value: "ap-mumbai-1", label: "印度 孟買 (ap-mumbai-1)" },
  { value: "ap-osaka-1", label: "日本 大阪 (ap-osaka-1)" },
  { value: "ap-seoul-1", label: "韓國 首爾 (ap-seoul-1)" },
  { value: "ap-seoul-2", label: "韓國 首爾 2 (ap-seoul-2)" },
  { value: "ap-singapore-1", label: "新加坡 (ap-singapore-1)" },
  { value: "ap-singapore-2", label: "新加坡 2 (ap-singapore-2)" },
  { value: "ap-sydney-1", label: "澳洲 雪梨 (ap-sydney-1)" },
  { value: "ap-tokyo-1", label: "日本 東京 (ap-tokyo-1)" },
  { value: "ca-toronto-1", label: "加拿大 多倫多 (ca-toronto-1)" },
  { value: "ca-toronto-2", label: "加拿大 多倫多 2 (ca-toronto-2)" },
  { value: "eu-amsterdam-1", label: "荷蘭 阿姆斯特丹 (eu-amsterdam-1)" },
  { value: "eu-frankfurt-1", label: "德國 法蘭克福 (eu-frankfurt-1)" },
  { value: "eu-frankfurt-2", label: "德國 法蘭克福 2 (eu-frankfurt-2)" },
  { value: "eu-madrid-1", label: "西班牙 馬德里 (eu-madrid-1)" },
  { value: "eu-marseille-1", label: "法國 馬賽 (eu-marseille-1)" },
  { value: "eu-milan-1", label: "義大利 米蘭 (eu-milan-1)" },
  { value: "eu-paris-1", label: "法國 巴黎 (eu-paris-1)" },
  { value: "eu-stockholm-1", label: "瑞典 斯德哥爾摩 (eu-stockholm-1)" },
  { value: "eu-zurich-1", label: "瑞士 蘇黎世 (eu-zurich-1)" },
  { value: "il-jerusalem-1", label: "以色列 耶路撒冷 (il-jerusalem-1)" },
  { value: "me-abudhabi-1", label: "阿聯 阿布達比 (me-abudhabi-1)" },
  { value: "me-dubai-1", label: "阿聯 杜拜 (me-dubai-1)" },
  { value: "me-jeddah-1", label: "沙烏地 吉達 (me-jeddah-1)" },
  { value: "mx-queretaro-1", label: "墨西哥 克雷塔羅 (mx-queretaro-1)" },
  { value: "sa-bogota-1", label: "哥倫比亞 波哥大 (sa-bogota-1)" },
  { value: "sa-santiago-1", label: "智利 聖地牙哥 (sa-santiago-1)" },
  { value: "sa-saopaulo-1", label: "巴西 聖保羅 (sa-saopaulo-1)" },
  { value: "sa-saopaulo-2", label: "巴西 聖保羅 2 (sa-saopaulo-2)" },
  { value: "sa-valparaiso-1", label: "智利 瓦爾帕萊索 (sa-valparaiso-1)" },
  { value: "sa-vinhedo-1", label: "巴西 文黑多 (sa-vinhedo-1)" },
  { value: "uk-cardiff-1", label: "英國 卡地夫 (uk-cardiff-1)" },
  { value: "uk-london-1", label: "英國 倫敦 (uk-london-1)" },
  { value: "us-ashburn-1", label: "美東 阿什本 (us-ashburn-1)" },
  { value: "us-chicago-1", label: "美中 芝加哥 (us-chicago-1)" },
  { value: "us-phoenix-1", label: "美西 鳳凰城 (us-phoenix-1)" },
  { value: "us-sanjose-1", label: "美西 聖荷西 (us-sanjose-1)" },
];
