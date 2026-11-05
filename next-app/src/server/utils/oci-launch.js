// OCI 執行個體建立（Phase 2）：建機選項查詢與 LaunchInstance。
// 選項（AD／shape／VCN／子網）一次聚合回傳；映像按 shape 過濾、
// TIMECREATED DESC，由前端依 OS 分組選擇（不對 OS 名稱寫死，避免
// OCI 命名差異：Ubuntu 在清單中的作業系統欄位並非永遠同一拼法）。
import { ociRequestJson } from "./oci-request.js";

function request(ctx) {
  return (options) => ociRequestJson({ ...options, account: ctx.account, privateKeyPem: ctx.privateKeyPem });
}

/**
 * 聚合建機選項：AD、shape、VCN＋子網。
 * 子請求數：AD(1) + shapes(1) + VCN(1) + 每 VCN 子網(1)，個人 compartment 規模遠低於上限。
 * @returns {Promise<{
 *   availabilityDomains: Array<{ name: string }>,
 *   shapes: Array<{ shape: string, isFlex: boolean, defaultOcpus: number, defaultMemoryInGBs: number }>,
 *   networks: Array<{ vcnId: string, vcnName: string, cidrBlock: string, subnets: Array<{
 *     id: string, displayName: string, cidrBlock: string, prohibitPublicIpOnLaunch: boolean }>,
 *   }>>,
 * }>}
 */
export async function listCreateOptions(ctx) {
  const api = request(ctx);
  const compartmentId = ctx.account.compartmentOcid;

  const [domains, shapes, vcns] = await Promise.all([
    api({ method: "GET", path: "/20160918/availabilityDomains", query: { compartmentId } }),
    api({ method: "GET", path: "/20160918/shapes", query: { compartmentId } }),
    api({ method: "GET", path: "/20160918/vcns", query: { compartmentId } }),
  ]);

  const availableVcns = (Array.isArray(vcns) ? vcns : [])
    .filter(vcn => vcn?.lifecycleState === "AVAILABLE" && vcn?.id)
    .slice(0, 10);
  const networks = await Promise.all(availableVcns.map(async (vcn) => {
    const subnets = await api({
      method: "GET",
      path: "/20160918/subnets",
      query: { compartmentId, vcnId: vcn.id },
    });
    return {
      vcnId: vcn.id,
      vcnName: String(vcn.displayName || vcn.id),
      cidrBlock: String(vcn.cidrBlock || ""),
      subnets: (Array.isArray(subnets) ? subnets : [])
        .filter(subnet => subnet?.lifecycleState === "AVAILABLE" && subnet?.id)
        .map(subnet => ({
          id: subnet.id,
          displayName: String(subnet.displayName || subnet.id),
          cidrBlock: String(subnet.cidrBlock || ""),
          prohibitPublicIpOnLaunch: Boolean(subnet.prohibitPublicIpOnLaunch),
        })),
    };
  }));

  return {
    availabilityDomains: (Array.isArray(domains) ? domains : [])
      .filter(domain => domain?.name)
      .map(domain => ({ name: String(domain.name) })),
    shapes: (Array.isArray(shapes) ? shapes : [])
      .filter(item => item?.shape)
      .map(item => ({
        shape: String(item.shape),
        isFlex: String(item.shape).endsWith(".Flex"),
        defaultOcpus: Number(item.ocpus) || 1,
        defaultMemoryInGBs: Number(item.memoryInGBs) || 1,
      })),
    networks,
  };
}

/**
 * 列出指定 shape 相容的映像（TIMECREATED DESC）。
 * @returns {Promise<Array<{ id: string, displayName: string, os: string, osVersion: string,
 *   sizeInGBs: number, timeCreated: string | null }>>}
 */
export async function listImages(ctx, { shape }) {
  const images = await request(ctx)({
    method: "GET",
    path: "/20160918/images",
    query: {
      compartmentId: ctx.account.compartmentOcid,
      shape,
      sortBy: "TIMECREATED",
      sortOrder: "DESC",
    },
  });
  return (Array.isArray(images) ? images : [])
    .filter(image => image?.id)
    .map(image => ({
      id: String(image.id),
      displayName: String(image.displayName || image.id),
      os: String(image.operatingSystem || ""),
      osVersion: String(image.operatingSystemVersion || ""),
      sizeInGBs: Math.ceil(Number(image.sizeInMBs || 0) / 1024) || 0,
      timeCreated: image.timeCreated ? String(image.timeCreated) : null,
    }));
}

/**
 * LaunchInstance：POST /20160918/instances。
 * details 為 LaunchInstanceDetails（路由層已組好並驗證）；
 * 回應為 PROVISIONING 過渡態的執行個體物件。
 */
export async function launchInstance(ctx, details) {
  return request(ctx)({
    method: "POST",
    path: "/20160918/instances",
    body: details,
  });
}
