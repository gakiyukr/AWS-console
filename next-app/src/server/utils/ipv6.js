// IPv6 開通編排：把 AWS 需要的多步操作收斂為「確保存取」語意。
// EC2 的 IPv6 需要三層 CIDR 串聯（VPC /56 → 子網 /64 → ENI 位址），
// 且 AssignIpv6Addresses 的 Ipv6AddressCount 是加法式、不冪等，因此每個
// 步驟都先 Describe 再決定是否寫入，重複執行安全。
// Wavelength Zone 不支援 IPv6（AWS 文件明文），由呼叫端排除。
import { ec2Query } from "./aws-query.js";
import {
  parseInstanceNicInfo,
  parseInternetGatewayId,
  parseRouteByDestination,
  parseRouteTableIdForSubnet,
  parseSubnetIpv6State,
  parseSubnetsIpv6Usage,
  parseVpcIpv6Info,
} from "./ec2-xml.js";
import { lightsailQuery } from "./aws-lightsail.js";

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 10;
const LIGHTSAIL_POLL_INTERVAL_MS = 4_000;
const LIGHTSAIL_POLL_MAX_ATTEMPTS = 15;

function delay(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 從 VPC 的 Amazon 提供 /56 推出一個未使用的 /64。
 * /56 的第 4 個 hextet 保留 256 個 /64 選擇空間（00–ff），
 * 取第一個未被任何子網使用的位置。純函式，方便驗證邊界。
 * @param {string} vpcIpv6Cidr 例如 2001:db8:1234:1a00::/56
 * @param {Set<string>} usedCidrs 已使用的小寫 /64 字串
 * @returns {string} 例如 2001:db8:1234:1a00::/64
 */
export function deriveSubnetIpv6Cidr(vpcIpv6Cidr, usedCidrs = new Set()) {
  const match = String(vpcIpv6Cidr || "").match(/^([0-9a-f:]+)::\/56$/i);
  if (!match) {
    throw new Error(`無法從 VPC IPv6 CIDR 推導子網範圍: ${vpcIpv6Cidr}`);
  }
  const prefix = match[1];
  const groups = prefix.split(":");
  if (groups.length !== 4) {
    throw new Error(`無法從 VPC IPv6 CIDR 推導子網範圍: ${vpcIpv6Cidr}`);
  }
  // /56 的第 4 個 hextet 後兩位為 00，256 個 /64 即把這兩位換成 00–ff
  // （例：1a00 → 1a00 … 1aff）。
  const fourth = groups[3].padStart(4, "0");
  const stem = fourth.slice(0, 2);
  for (let index = 0; index < 256; index += 1) {
    const candidate = `${groups[0]}:${groups[1]}:${groups[2]}:${stem}${index.toString(16).padStart(2, "0")}::/64`;
    if (!usedCidrs.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  throw new Error("VPC 的 IPv6 /56 已無可用的 /64 範圍");
}

/** 取 VPC 已關聯的 Amazon IPv6 /56；尚未關聯則發起關聯並輪詢。 */
export async function ensureVpcIpv6Cidr(env, region, vpcId, onProgress = () => {}) {
  const describe = async () => parseVpcIpv6Info(
    await ec2Query(region, env, "DescribeVpcs", { "VpcId.1": vpcId }),
  );

  const current = await describe();
  if (current.ipv6CidrBlock) {
    return current.ipv6CidrBlock;
  }
  if (current.associationState !== "associating") {
    await ec2Query(region, env, "AssociateVpcCidrBlock", {
      VpcId: vpcId,
      AmazonProvidedIpv6CidrBlock: "true",
    });
  }
  onProgress("waiting_vpc_ipv6");
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(POLL_INTERVAL_MS);
    const polled = await describe();
    if (polled.ipv6CidrBlock) {
      return polled.ipv6CidrBlock;
    }
  }
  throw new Error("等待 VPC 取得 IPv6 CIDR 逾時");
}

/** 確保子網有 IPv6 /64：已有則沿用，否則自 VPC /56 挑一個並關聯。 */
export async function ensureSubnetIpv6Cidr(env, region, vpcId, subnetId, vpcIpv6Cidr, onProgress = () => {}) {
  const describeState = async () => parseSubnetIpv6State(
    await ec2Query(region, env, "DescribeSubnets", { "SubnetId.1": subnetId }),
  );

  const current = await describeState();
  if (current.state === "associated" && current.ipv6CidrBlock) {
    return current.ipv6CidrBlock;
  }

  const usage = parseSubnetsIpv6Usage(
    await ec2Query(region, env, "DescribeSubnets", {
      "Filter.1.Name": "vpc-id",
      "Filter.1.Value.1": vpcId,
    }),
  );
  const usedCidrs = new Set(
    usage.flatMap(subnet => subnet.ipv6CidrBlocks.map(cidr => cidr.toLowerCase())),
  );

  if (current.state !== "associating") {
    const cidr = deriveSubnetIpv6Cidr(vpcIpv6Cidr, usedCidrs);
    await ec2Query(region, env, "AssociateSubnetCidrBlock", {
      SubnetId: subnetId,
      Ipv6CidrBlock: cidr,
    });
  }

  onProgress("waiting_subnet_ipv6");
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(POLL_INTERVAL_MS);
    const polled = await describeState();
    if (polled.state === "associated" && polled.ipv6CidrBlock) {
      return polled.ipv6CidrBlock;
    }
  }
  throw new Error("等待子網取得 IPv6 CIDR 逾時");
}

/**
 * 確保子網的 `::/0` 路由指向 Internet Gateway（完整開通）。
 * 沒有附加 IGW 的 VPC（私有子網）無法提供 IPv6 公網路由，回報略過而非失敗。
 * @returns {Promise<{ ensured: boolean, skipped?: boolean, reason?: string }>}
 */
export async function ensureIpv6RouteToIgw(env, region, vpcId, subnetId) {
  const gatewayId = parseInternetGatewayId(
    await ec2Query(region, env, "DescribeInternetGateways", {
      "Filter.1.Name": "attachment.vpc-id",
      "Filter.1.Value.1": vpcId,
    }),
  );
  if (!gatewayId) {
    return { ensured: false, skipped: true, reason: "VPC 沒有 Internet Gateway，略過 IPv6 公網路由" };
  }

  const routeTablesXml = await ec2Query(region, env, "DescribeRouteTables", {
    "Filter.1.Name": "association.subnet-id",
    "Filter.1.Value.1": subnetId,
  });
  let routeTableId = parseRouteTableIdForSubnet(routeTablesXml);
  if (!routeTableId) {
    // 子網未明確關聯路由表時使用 VPC 主路由表
    routeTableId = parseRouteTableIdForSubnet(
      await ec2Query(region, env, "DescribeRouteTables", {
        "Filter.1.Name": "vpc-id",
        "Filter.1.Value.1": vpcId,
        "Filter.2.Name": "association.main",
        "Filter.2.Value.1": "true",
      }),
    );
  }
  if (!routeTableId) {
    return { ensured: false, skipped: true, reason: "找不到子網所屬路由表，略過 IPv6 公網路由" };
  }

  const existing = parseRouteByDestination(
    await ec2Query(region, env, "DescribeRouteTables", { "RouteTableId.1": routeTableId }),
    "destinationIpv6CidrBlock",
    "::/0",
  );
  if (existing?.gatewayId === gatewayId) {
    return { ensured: true };
  }
  if (existing) {
    return { ensured: false, skipped: true, reason: `路由表已有指向 ${existing.gatewayId} 的 ::/0 路由，未變更` };
  }

  try {
    await ec2Query(region, env, "CreateRoute", {
      RouteTableId: routeTableId,
      DestinationIpv6CidrBlock: "::/0",
      GatewayId: gatewayId,
    });
    return { ensured: true };
  } catch (error) {
    if (String(error?.code || "").includes("RouteAlreadyExists")) {
      return { ensured: true };
    }
    return { ensured: false, skipped: true, reason: `建立 IPv6 路由失敗：${error?.message || error}` };
  }
}

/**
 * 對執行個體使用的安全群組放行 `::/0` 全流量，與本專案 IPv4 的全開策略一致。
 * 規則已存在（Duplicate）視為成功。
 */
export async function ensureEniIpv6SgRules(env, region, securityGroupIds) {
  const warnings = [];
  for (const securityGroupId of securityGroupIds) {
    try {
      await ec2Query(region, env, "AuthorizeSecurityGroupIngress", {
        "GroupId.1": securityGroupId,
        "IpPermissions.1.IpProtocol": "-1",
        "IpPermissions.1.Ipv6Ranges.1.CidrIpv6": "::/0",
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (!message.includes("Duplicate") && !message.includes("InvalidPermission.Duplicate")) {
        warnings.push(`安全群組 ${securityGroupId} 加入 IPv6 規則失敗：${message}`);
      }
    }
  }
  return warnings;
}

/**
 * 為既有 EC2 執行個體開通 IPv6（完整開通：CIDR 串聯＋路由＋安全群組＋指派）。
 * 已指派過位址時只補齊網路設定，不重複指派。
 * @returns {Promise<{ ipv6Address: string, alreadyAssigned: boolean, warnings: string[] }>}
 */
export async function enableEc2InstanceIpv6(env, machine, onProgress = () => {}) {
  const nic = parseInstanceNicInfo(
    await ec2Query(machine.region, env, "DescribeInstances", {
      "InstanceId.1": machine.instanceId,
    }),
  );
  if (!nic.instanceId) {
    throw new Error("找不到執行個體");
  }
  if (!nic.networkInterfaceId || !nic.subnetId || !nic.vpcId) {
    throw new Error("執行個體缺少主要網路介面資訊，無法開通 IPv6");
  }

  onProgress("ensure_vpc_ipv6", {});
  const vpcIpv6Cidr = await ensureVpcIpv6Cidr(env, machine.region, nic.vpcId, onProgress);

  onProgress("ensure_subnet_ipv6", {});
  await ensureSubnetIpv6Cidr(env, machine.region, nic.vpcId, nic.subnetId, vpcIpv6Cidr, onProgress);

  onProgress("ensure_ipv6_route", {});
  const route = await ensureIpv6RouteToIgw(env, machine.region, nic.vpcId, nic.subnetId);

  onProgress("ensure_ipv6_sg", {});
  const warnings = await ensureEniIpv6SgRules(env, machine.region, nic.securityGroupIds);
  if (route.skipped && route.reason) {
    warnings.push(route.reason);
  }

  if (nic.ipv6Addresses.length > 0) {
    return { ipv6Address: nic.ipv6Addresses[0], alreadyAssigned: true, warnings };
  }

  onProgress("assigning_ipv6", {});
  await ec2Query(machine.region, env, "AssignIpv6Addresses", {
    NetworkInterfaceId: nic.networkInterfaceId,
    Ipv6AddressCount: "1",
  });
  return { ipv6Address: "", alreadyAssigned: false, warnings };
}

/**
 * 為既有 Lightsail 執行個體開啟雙棧（SetIpAddressType 為非同步操作，
 * 以 GetInstance 的 ipv6Addresses 判定完成）。
 * @returns {Promise<{ ipv6Address: string, alreadyEnabled: boolean }>}
 */
export async function enableLightsailIpv6(awsEnv, region, instanceName) {
  const readInstance = async () => {
    const response = await lightsailQuery(region, awsEnv, "GetInstance", { instanceName });
    return response?.instance || {};
  };

  const instance = await readInstance();
  if (!instance?.name) {
    throw new Error("找不到執行個體");
  }
  const existing = Array.isArray(instance.ipv6Addresses) ? instance.ipv6Addresses : [];
  if (existing.length > 0) {
    return { ipv6Address: existing[0], alreadyEnabled: true };
  }

  await lightsailQuery(region, awsEnv, "SetIpAddressType", {
    resourceType: "Instance",
    resourceName: instanceName,
    ipAddressType: "dualstack",
  });

  for (let attempt = 1; attempt <= LIGHTSAIL_POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(LIGHTSAIL_POLL_INTERVAL_MS);
    const polled = await readInstance();
    const addresses = Array.isArray(polled.ipv6Addresses) ? polled.ipv6Addresses : [];
    if (addresses.length > 0) {
      return { ipv6Address: addresses[0], alreadyEnabled: false };
    }
  }
  throw new Error("等待 Lightsail 指派 IPv6 位址逾時");
}
