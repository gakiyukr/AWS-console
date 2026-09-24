// AWS EC2 Query API XML 回應解析器：把 EC2 API 的 XML 轉為業務層使用的
// 純物件。與 aws-query.js 的 SigV4 簽章、wavelength.js 的部署流程無關，
// 僅依賴 xml.js 的 DOM 解析工具，因此獨立成模組以利測試與重用。
//
// 命名慣例：parseXxxItems / parseXxxXml 回傳陣列；parseCreatedXxx 回傳
// 建立資源後取得的識別字；findTagValue 供解析 tagSet 內的具名標籤。
import { allTexts, childrenNamed, firstChildNamed, firstText, parseXml } from "./xml.js";

function findTagValue(node, key) {
  for (const tagNode of childrenNamed(node, "tagSet")) {
    for (const tag of childrenNamed(tagNode, "item")) {
      if (firstText(tag, "key") === key) {
        return firstText(tag, "value");
      }
    }
  }
  return "";
}

export function parseRegionItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeRegionsResponse");
  const regionInfo = firstChildNamed(response, "regionInfo");
  return childrenNamed(regionInfo, "item").map((item) => ({
    regionName: firstText(item, "regionName"),
    optInStatus: firstText(item, "optInStatus"),
  }));
}

export function parseAvailabilityZonesXml(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeAvailabilityZonesResponse");
  const zoneInfo = firstChildNamed(response, "availabilityZoneInfo");
  return childrenNamed(zoneInfo, "item").map((item) => ({
    groupName: firstText(item, "groupName"),
    zoneName: firstText(item, "zoneName"),
    zoneType: firstText(item, "zoneType"),
    optInStatus: firstText(item, "optInStatus"),
    regionName: firstText(item, "regionName"),
  }));
}

export function parseVpcItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeVpcsResponse");
  const vpcSet = firstChildNamed(response, "vpcSet");
  return childrenNamed(vpcSet, "item").map((item) => ({
    vpcId: firstText(item, "vpcId"),
    cidrBlock: firstText(item, "cidrBlock"),
    isDefault: firstText(item, "isDefault") === "true",
    name: findTagValue(item, "Name"),
  }));
}

export function parseSubnetItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeSubnetsResponse");
  const subnetSet = firstChildNamed(response, "subnetSet");
  return childrenNamed(subnetSet, "item").map((item) => ({
    subnetId: firstText(item, "subnetId"),
    availabilityZone: firstText(item, "availabilityZone"),
    cidrBlock: firstText(item, "cidrBlock"),
    vpcId: firstText(item, "vpcId"),
    name: findTagValue(item, "Name"),
  }));
}

export function parseSecurityGroupItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeSecurityGroupsResponse");
  const groupInfo = firstChildNamed(response, "securityGroupInfo");
  return childrenNamed(groupInfo, "item").map((item) => ({
    groupId: firstText(item, "groupId"),
    groupName: firstText(item, "groupName"),
    vpcId: firstText(item, "vpcId"),
    ingressAll: hasAllTrafficRule(firstChildNamed(item, "ipPermissions")),
    egressAll: hasAllTrafficRule(firstChildNamed(item, "ipPermissionsEgress")),
  }));
}

function hasAllTrafficRule(node) {
  for (const permission of childrenNamed(node, "item")) {
    if (firstText(permission, "ipProtocol") !== "-1") {
      continue;
    }
    const ipv4Ranges = childrenNamed(firstChildNamed(permission, "ipRanges"), "item");
    if (ipv4Ranges.some((range) => firstText(range, "cidrIp") === "0.0.0.0/0")) {
      return true;
    }
  }
  return false;
}

export function parseImageItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeImagesResponse");
  const imageSet = firstChildNamed(response, "imagesSet");
  return childrenNamed(imageSet, "item").map((item) => ({
    imageId: firstText(item, "imageId"),
    name: firstText(item, "name"),
    creationDate: firstText(item, "creationDate"),
    rootDeviceName: firstText(item, "rootDeviceName"),
    rootSnapshotId:
      childrenNamed(firstChildNamed(item, "blockDeviceMapping"), "item")
        .map((mapping) => ({
          deviceName: firstText(mapping, "deviceName"),
          snapshotId: firstText(mapping, ["ebs", "snapshotId"]),
        }))
        .find((mapping) => mapping.deviceName === firstText(item, "rootDeviceName"))?.snapshotId || "",
  }));
}

export function parseCarrierGatewayItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeCarrierGatewaysResponse");
  const gatewaySet = firstChildNamed(response, "carrierGatewaySet");
  return childrenNamed(gatewaySet, "item").map((item) => ({
    carrierGatewayId: firstText(item, "carrierGatewayId"),
    vpcId: firstText(item, "vpcId"),
    state: firstText(item, "state"),
  }));
}

export function parseRouteTableItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeRouteTablesResponse");
  const routeTableSet = firstChildNamed(response, "routeTableSet");
  return childrenNamed(routeTableSet, "item").map((item) => ({
    routeTableId: firstText(item, "routeTableId"),
    vpcId: firstText(item, "vpcId"),
    zoneTag: findTagValue(item, "WavelengthZone"),
    associations: childrenNamed(firstChildNamed(item, "associationSet"), "item").map(
      (association) => ({
        routeTableAssociationId: firstText(association, "routeTableAssociationId"),
        subnetId: firstText(association, "subnetId"),
        main: firstText(association, "main") === "true",
      }),
    ),
    routes: childrenNamed(firstChildNamed(item, "routeSet"), "item").map((route) => ({
      destinationCidrBlock: firstText(route, "destinationCidrBlock"),
      carrierGatewayId: firstText(route, "carrierGatewayId"),
      state: firstText(route, "state"),
    })),
  }));
}

export function parseInstanceTypeOfferings(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeInstanceTypeOfferingsResponse");
  const offeringSet = firstChildNamed(response, "instanceTypeOfferingSet");
  return childrenNamed(offeringSet, "item").map((item) => ({
    instanceType: firstText(item, "instanceType"),
    location: firstText(item, "location"),
  }));
}

// 執行個體尺寸排序權重：Wavelength Zone 的機型清單依此由小到大排序。
const INSTANCE_SIZE_ORDER = {
  nano: 1,
  micro: 2,
  small: 3,
  medium: 4,
  large: 5,
  xlarge: 6,
};

function instanceTypeSizeWeight(instanceType) {
  const size = instanceType.split(".").at(-1) || "";
  const multiplierMatch = size.match(/^(\d+)xlarge$/);
  if (multiplierMatch) {
    return 5 + Number(multiplierMatch[1]);
  }
  return INSTANCE_SIZE_ORDER[size] || Number.MAX_SAFE_INTEGER;
}

export function compareInstanceTypesBySize(left, right) {
  const leftWeight = instanceTypeSizeWeight(left);
  const rightWeight = instanceTypeSizeWeight(right);
  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }
  return left.localeCompare(right);
}

export function parseInstanceTypes(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeInstanceTypesResponse");
  const typeSet = firstChildNamed(response, "instanceTypeSet");
  return childrenNamed(typeSet, "item").map((item) => {
    const supportedArchitectures =
      allTexts(item, ["processorInfo", "supportedArchitectureSet", "item"]).filter(Boolean);
    const fallbackArchitectures =
      allTexts(item, ["processorInfo", "supportedArchitectures", "item"]).filter(Boolean);

    return {
      instanceType: firstText(item, "instanceType"),
      supportedArchitectures:
        supportedArchitectures.length > 0 ? supportedArchitectures : fallbackArchitectures,
    };
  });
}

export function parseCreatedSecurityGroupId(xml) {
  const root = parseXml(xml);
  return firstText(root, ["CreateSecurityGroupResponse", "groupId"]);
}

export function parseCreatedCarrierGatewayId(xml) {
  const root = parseXml(xml);
  return (
    firstText(root, ["CreateCarrierGatewayResponse", "carrierGateway", "carrierGatewayId"]) ||
    firstText(root, ["CreateCarrierGatewayResponse", "carrierGatewayId"])
  );
}

export function parseCreatedSubnet(xml) {
  const root = parseXml(xml);
  const subnet = firstChildNamed(
    firstChildNamed(root, "CreateSubnetResponse"),
    "subnet",
  );
  return {
    subnetId: firstText(subnet, "subnetId"),
    cidrBlock: firstText(subnet, "cidrBlock"),
    availabilityZone: firstText(subnet, "availabilityZone"),
  };
}

export function parseCreatedRouteTableId(xml) {
  const root = parseXml(xml);
  return (
    firstText(root, ["CreateRouteTableResponse", "routeTable", "routeTableId"]) ||
    firstText(root, ["CreateRouteTableResponse", "routeTableId"])
  );
}

export function parseRunInstances(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "RunInstancesResponse");
  const instancesSet = firstChildNamed(response, "instancesSet");
  const item = firstChildNamed(instancesSet, "item");
  return {
    instanceId: firstText(item, "instanceId"),
  };
}

export function parseInstanceDescription(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeInstancesResponse");
  const reservationSet = firstChildNamed(response, "reservationSet");
  const reservation = firstChildNamed(reservationSet, "item");
  const instancesSet = firstChildNamed(reservation, "instancesSet");
  const item = firstChildNamed(instancesSet, "item");
  return parseInstanceItem(item);
}

function parseInstanceItem(item) {
  return {
    instanceId: firstText(item, "instanceId"),
    state: firstText(item, ["instanceState", "name"]),
    privateIpAddress: firstText(item, "privateIpAddress"),
    privateDnsName: firstText(item, "privateDnsName"),
    publicIpAddress: firstText(item, "ipAddress"),
    publicDnsName: firstText(item, "dnsName"),
    carrierIpAddress: firstText(item, "dnsName") || firstText(item, "ipAddress"),
    instanceType: firstText(item, "instanceType"),
    subnetId: firstText(item, "subnetId"),
    vpcId: firstText(item, "vpcId"),
    availabilityZone: firstText(item, ["placement", "availabilityZone"]),
  };
}

export function parseInstanceDescriptions(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeInstancesResponse");
  const reservationSet = firstChildNamed(response, "reservationSet");
  const instances = [];
  for (const reservation of childrenNamed(reservationSet, "item")) {
    const instancesSet = firstChildNamed(reservation, "instancesSet");
    for (const item of childrenNamed(instancesSet, "item")) {
      instances.push(parseInstanceItem(item));
    }
  }
  return instances;
}

export function parseInstanceStatus(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeInstanceStatusResponse");
  const statusSet = firstChildNamed(response, "instanceStatusSet");
  const item = firstChildNamed(statusSet, "item");
  return {
    instanceId: firstText(item, "instanceId"),
    instanceStatus: firstText(item, ["instanceStatus", "status"]),
    systemStatus: firstText(item, ["systemStatus", "status"]),
  };
}

export function parseConsoleOutput(xml) {
  const root = parseXml(xml);
  return firstText(root, ["GetConsoleOutputResponse", "output"]);
}
