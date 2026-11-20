// Oracle 官方區域清單快照（核對日期：2026-11-19），供區域選單使用。
// 來源：https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
// 僅支援使用 oraclecloud.com 的 OC1 商業區域；不包含政府雲、主權雲或其他 realm（如 OC20）。
// 此快照可能隨 Oracle 新增或調整區域而更新；帳號可用區域仍依實際訂閱與權限而定。

export interface OciRegionOption {
  value: string
  label: string
}

export const OCI_REGIONS: OciRegionOption[] = [
  { value: "af-casablanca-1", label: "摩洛哥 卡薩布蘭卡 (af-casablanca-1)" },
  { value: "af-johannesburg-1", label: "南非 約翰尼斯堡 (af-johannesburg-1)" },
  { value: "ap-batam-1", label: "印尼 巴淡島 (ap-batam-1)" },
  { value: "ap-chuncheon-1", label: "韓國 春川 (ap-chuncheon-1)" },
  { value: "ap-hyderabad-1", label: "印度 海德拉巴 (ap-hyderabad-1)" },
  { value: "ap-kulai-2", label: "馬來西亞 古來 2 (ap-kulai-2)" },
  { value: "ap-melbourne-1", label: "澳洲 墨爾本 (ap-melbourne-1)" },
  { value: "ap-mumbai-1", label: "印度 孟買 (ap-mumbai-1)" },
  { value: "ap-osaka-1", label: "日本 大阪 (ap-osaka-1)" },
  { value: "ap-seoul-1", label: "韓國 首爾 (ap-seoul-1)" },
  { value: "ap-singapore-1", label: "新加坡 (ap-singapore-1)" },
  { value: "ap-singapore-2", label: "新加坡 2 (ap-singapore-2)" },
  { value: "ap-sydney-1", label: "澳洲 雪梨 (ap-sydney-1)" },
  { value: "ap-tokyo-1", label: "日本 東京 (ap-tokyo-1)" },
  { value: "ca-montreal-1", label: "加拿大 蒙特婁 (ca-montreal-1)" },
  { value: "ca-toronto-1", label: "加拿大 多倫多 (ca-toronto-1)" },
  { value: "eu-amsterdam-1", label: "荷蘭 阿姆斯特丹 (eu-amsterdam-1)" },
  { value: "eu-frankfurt-1", label: "德國 法蘭克福 (eu-frankfurt-1)" },
  { value: "eu-madrid-1", label: "西班牙 馬德里 (eu-madrid-1)" },
  { value: "eu-madrid-3", label: "西班牙 馬德里 3 (eu-madrid-3)" },
  { value: "eu-marseille-1", label: "法國 馬賽 (eu-marseille-1)" },
  { value: "eu-milan-1", label: "義大利 米蘭 (eu-milan-1)" },
  { value: "eu-paris-1", label: "法國 巴黎 (eu-paris-1)" },
  { value: "eu-stockholm-1", label: "瑞典 斯德哥爾摩 (eu-stockholm-1)" },
  { value: "eu-turin-1", label: "義大利 杜林 (eu-turin-1)" },
  { value: "eu-zurich-1", label: "瑞士 蘇黎世 (eu-zurich-1)" },
  { value: "il-jerusalem-1", label: "以色列 耶路撒冷 (il-jerusalem-1)" },
  { value: "me-abudhabi-1", label: "阿聯 阿布達比 (me-abudhabi-1)" },
  { value: "me-dubai-1", label: "阿聯 杜拜 (me-dubai-1)" },
  { value: "me-jeddah-1", label: "沙烏地 吉達 (me-jeddah-1)" },
  { value: "me-riyadh-1", label: "沙烏地 利雅德 (me-riyadh-1)" },
  { value: "mx-monterrey-1", label: "墨西哥 蒙特雷 (mx-monterrey-1)" },
  { value: "mx-queretaro-1", label: "墨西哥 克雷塔羅 (mx-queretaro-1)" },
  { value: "sa-bogota-1", label: "哥倫比亞 波哥大 (sa-bogota-1)" },
  { value: "sa-santiago-1", label: "智利 聖地牙哥 (sa-santiago-1)" },
  { value: "sa-saopaulo-1", label: "巴西 聖保羅 (sa-saopaulo-1)" },
  { value: "sa-valparaiso-1", label: "智利 瓦爾帕萊索 (sa-valparaiso-1)" },
  { value: "sa-vinhedo-1", label: "巴西 文黑多 (sa-vinhedo-1)" },
  { value: "uk-cardiff-1", label: "英國 卡地夫 (uk-cardiff-1)" },
  { value: "uk-london-1", label: "英國 倫敦 (uk-london-1)" },
  { value: "us-ashburn-1", label: "美東 阿什本 (us-ashburn-1)" },
  { value: "us-chicago-1", label: "美中 芝加哥 (us-chicago-1)" },
  { value: "us-phoenix-1", label: "美西 鳳凰城 (us-phoenix-1)" },
  { value: "us-sanjose-1", label: "美西 聖荷西 (us-sanjose-1)" },
];

/** OCI 區域代碼 → 繁中顯示標籤的查詢表（來自上方清單）。 */
const OCI_REGION_LABELS: Record<string, string> = Object.fromEntries(
  OCI_REGIONS.map(option => [option.value, option.label]),
);

/**
 * 組出 OCI 區域的顯示文字；清單未收錄的區域（政府雲等）回退純代碼。
 * @param region OCI region identifier（如 eu-frankfurt-1）
 */
export function ociRegionLabel(region: string): string {
  return OCI_REGION_LABELS[region] || region;
}
