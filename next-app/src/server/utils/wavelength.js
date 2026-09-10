import { AwsRequestError, ec2Query, encodeUserData } from "./aws-query.js";
import { allTexts, childrenNamed, firstChildNamed, firstText, parseXml } from "./xml.js";

/** @typedef {(stage: string, details?: Record<string, unknown>) => void} ProgressReporter */

export const WAVELENGTH_CLOUD_INIT_MARKER = "WAVELENGTH_CLOUD_INIT_DONE";

const MANAGED_TAGS = {
  ManagedBy: "ec2-power-console",
  Feature: "wavelength",
};

function buildManagementTags(zone) {
  return {
    ...MANAGED_TAGS,
    WavelengthZone: zone,
  };
}

const OS_OPTIONS = [
  {
    value: "debian11",
    label: "Debian 11",
    owners: ["136693071363"],
    imageNameByArchitecture: {
      x86_64: "debian-11-amd64-*",
      arm64: "debian-11-arm64-*",
    },
  },
  {
    value: "debian12",
    label: "Debian 12",
    owners: ["136693071363"],
    imageNameByArchitecture: {
      x86_64: "debian-12-amd64-*",
      arm64: "debian-12-arm64-*",
    },
  },
  {
    value: "debian13",
    label: "Debian 13",
    owners: ["136693071363"],
    imageNameByArchitecture: {
      x86_64: "debian-13-amd64-*",
      arm64: "debian-13-arm64-*",
    },
  },
];

const POLL_ATTEMPTS = 60;
const POLL_DELAY_MS = 5000;
const DEFAULT_REGIONAL_INSTANCE_TYPE = "t3.nano";
const INSTANCE_SIZE_ORDER = {
  nano: 1,
  micro: 2,
  small: 3,
  medium: 4,
  large: 5,
  xlarge: 6,
};

class WavelengthError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WavelengthError";
    this.statusCode = details.statusCode || 400;
  }
}

function addFilters(params, filters) {
  filters.forEach((filter, filterIndex) => {
    params[`Filter.${filterIndex + 1}.Name`] = filter.name;
    filter.values.forEach((value, valueIndex) => {
      params[`Filter.${filterIndex + 1}.Value.${valueIndex + 1}`] = value;
    });
  });
}

function addTags(params, prefix, tags) {
  Object.entries(tags).forEach(([key, value], index) => {
    const tagPrefix = prefix ? `${prefix}.Tag` : "Tag";
    params[`${tagPrefix}.${index + 1}.Key`] = key;
    params[`${tagPrefix}.${index + 1}.Value`] = value;
  });
}

function addTagSpecification(params, index, resourceType, tags) {
  params[`TagSpecification.${index}.ResourceType`] = resourceType;
  addTags(params, `TagSpecification.${index}`, tags);
}

function addIndexedValues(params, prefix, values) {
  values.forEach((value, index) => {
    params[`${prefix}.${index + 1}`] = value;
  });
}

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

function parseRegionItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeRegionsResponse");
  const regionInfo = firstChildNamed(response, "regionInfo");
  return childrenNamed(regionInfo, "item").map((item) => ({
    regionName: firstText(item, "regionName"),
    optInStatus: firstText(item, "optInStatus"),
  }));
}

function parseAvailabilityZonesXml(xml) {
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

function parseVpcItems(xml) {
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

function parseSubnetItems(xml) {
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

function parseSecurityGroupItems(xml) {
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

function parseImageItems(xml) {
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

function parseCarrierGatewayItems(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeCarrierGatewaysResponse");
  const gatewaySet = firstChildNamed(response, "carrierGatewaySet");
  return childrenNamed(gatewaySet, "item").map((item) => ({
    carrierGatewayId: firstText(item, "carrierGatewayId"),
    vpcId: firstText(item, "vpcId"),
    state: firstText(item, "state"),
  }));
}

function parseRouteTableItems(xml) {
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

function parseInstanceTypeOfferings(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "DescribeInstanceTypeOfferingsResponse");
  const offeringSet = firstChildNamed(response, "instanceTypeOfferingSet");
  return childrenNamed(offeringSet, "item").map((item) => ({
    instanceType: firstText(item, "instanceType"),
    location: firstText(item, "location"),
  }));
}

function instanceTypeSizeWeight(instanceType) {
  const size = instanceType.split(".").at(-1) || "";
  const multiplierMatch = size.match(/^(\d+)xlarge$/);
  if (multiplierMatch) {
    return 5 + Number(multiplierMatch[1]);
  }
  return INSTANCE_SIZE_ORDER[size] || Number.MAX_SAFE_INTEGER;
}

function compareInstanceTypesBySize(left, right) {
  const leftWeight = instanceTypeSizeWeight(left);
  const rightWeight = instanceTypeSizeWeight(right);
  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }
  return left.localeCompare(right);
}

function parseInstanceTypes(xml) {
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

function parseCreatedSecurityGroupId(xml) {
  const root = parseXml(xml);
  return firstText(root, ["CreateSecurityGroupResponse", "groupId"]);
}

function parseCreatedCarrierGatewayId(xml) {
  const root = parseXml(xml);
  return (
    firstText(root, ["CreateCarrierGatewayResponse", "carrierGateway", "carrierGatewayId"]) ||
    firstText(root, ["CreateCarrierGatewayResponse", "carrierGatewayId"])
  );
}

function parseCreatedSubnet(xml) {
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

function parseCreatedRouteTableId(xml) {
  const root = parseXml(xml);
  return (
    firstText(root, ["CreateRouteTableResponse", "routeTable", "routeTableId"]) ||
    firstText(root, ["CreateRouteTableResponse", "routeTableId"])
  );
}

function parseRunInstances(xml) {
  const root = parseXml(xml);
  const response = firstChildNamed(root, "RunInstancesResponse");
  const instancesSet = firstChildNamed(response, "instancesSet");
  const item = firstChildNamed(instancesSet, "item");
  return {
    instanceId: firstText(item, "instanceId"),
  };
}

function parseInstanceDescription(xml) {
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

function parseInstanceDescriptions(xml) {
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

function parseInstanceStatus(xml) {
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

function parseConsoleOutput(xml) {
  const root = parseXml(xml);
  return firstText(root, ["GetConsoleOutputResponse", "output"]);
}

function isRegionEnabled(region) {
  return (
    region.optInStatus === "opt-in-not-required" ||
    region.optInStatus === "opted-in" ||
    region.optInStatus === ""
  );
}

function toBase64(text) {
  return encodeUserData(text);
}

function decodeBase64(text) {
  if (!text) {
    return "";
  }
  return atob(text);
}

function sleep(env, delayMs) {
  if (env.__testHooks?.sleep) {
    return env.__testHooks.sleep(delayMs);
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function formatResourceName(kind, zone) {
  return `ec2-power-console-${kind}-${zone}`;
}

function isForwarderEnabled(input) {
  return input?.enable_forwarder === true || input?.enable_forwarder === "true";
}

function generateForwarderListenPort() {
  return 20000 + randomInt(40000);
}

function buildManagedTags(zone, extra = {}) {
  return {
    ...buildManagementTags(zone),
    ...extra,
  };
}

async function tagExistingResource(env, region, resourceId, zone) {
  const params = {
    "ResourceId.1": resourceId,
  };
  addTags(params, "", buildManagementTags(zone));
  await ec2Query(region, env, "CreateTags", params);
}

function validateDeployInput(input) {
  const required = ["region", "zone", "vpc_id", "instance_type", "os"];
  for (const field of required) {
    if (!input?.[field]) {
      throw new WavelengthError(`缺少必要欄位: ${field}`);
    }
  }
}

function validateRegionalDeployInput(input) {
  const required = ["region", "vpc_id", "os"];
  for (const field of required) {
    if (!input?.[field]) {
      throw new WavelengthError(`缺少必要欄位: ${field}`);
    }
  }
}

function validateListExistingWavelengthInstancesInput(input) {
  const required = ["region", "zone", "vpc_id"];
  for (const field of required) {
    if (!input?.[field]) {
      throw new WavelengthError(`缺少必要欄位: ${field}`);
    }
  }
}

function validateExistingForwarderInput(input) {
  const required = ["region", "zone", "vpc_id", "instance_id", "os"];
  for (const field of required) {
    if (!input?.[field]) {
      throw new WavelengthError(`缺少必要欄位: ${field}`);
    }
  }
}

function getRegionalInstanceType() {
  return DEFAULT_REGIONAL_INSTANCE_TYPE;
}

function isRetryablePollingError(error) {
  return (
    error instanceof AwsRequestError &&
    (
      error.statusCode >= 500 ||
      error.code === "RequestLimitExceeded" ||
      error.code === "Throttling" ||
      error.code === "InvalidInstanceID.NotFound"
    )
  );
}

function validateInitInput(input) {
  const required = ["region", "zone", "vpc_id"];
  for (const field of required) {
    if (!input?.[field]) {
      throw new WavelengthError(`缺少必要欄位: ${field}`);
    }
  }
}

function getOsDefinition(value) {
  const match = OS_OPTIONS.find((option) => option.value === value);
  if (!match) {
    throw new WavelengthError(`不支援的作業系統: ${value}`);
  }
  return match;
}

function randomInt(maxExclusive) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("密碼學安全的隨機數生成器不可用");
  }
  const array = new Uint32Array(1);
  globalThis.crypto.getRandomValues(array);
  return array[0] % maxExclusive;
}

// ─── 登入憑證 ───────────────────────────────────────────────
// 部署憑證由使用者自訂：SSH 公鑰（存於 D1 公鑰庫）或自訂 root 密碼
// （僅存在於單次請求，不落任何儲存）。金鑰與密碼的深度驗證集中於此，
// 端點層只負責從 D1 或請求本體組出 credential 物件。

// 允許的 SSH 公鑰金鑰類型；不允許 options 前綴，縮小 authorized_keys 注入面
const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];
const SSH_PUBLIC_KEY_LINE = new RegExp(
  `^(${SSH_KEY_TYPES.map((type) => type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) [A-Za-z0-9+/=]+( [^\\s].*)?$`,
);
const SSH_KEY_MAX_LINES = 10;
const SSH_KEY_MAX_LENGTH = 8192;
const ROOT_PASSWORD_MIN_LENGTH = 8;
const ROOT_PASSWORD_MAX_LENGTH = 128;

/**
 * 驗證多行 SSH 公鑰文字（設定頁入庫與部署解析共用）。
 * @param {string} text 換行分隔的公鑰文字
 * @returns {string[]} 逐行 trim 後的金鑰陣列
 * @throws {WavelengthError} 格式無效、行數或長度超限時拋出（訊息繁中）
 */
export function validateSshPublicKeyText(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new WavelengthError("SSH 公鑰不能為空");
  }
  if (text.length > SSH_KEY_MAX_LENGTH) {
    throw new WavelengthError(`SSH 公鑰總長度不可超過 ${SSH_KEY_MAX_LENGTH} 字元`);
  }
  const keys = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new WavelengthError("SSH 公鑰不能為空");
  }
  if (keys.length > SSH_KEY_MAX_LINES) {
    throw new WavelengthError(`SSH 公鑰最多 ${SSH_KEY_MAX_LINES} 把`);
  }
  for (const [index, key] of keys.entries()) {
    if (!SSH_PUBLIC_KEY_LINE.test(key)) {
      throw new WavelengthError(`SSH 公鑰格式無效：第 ${index + 1} 行`);
    }
  }
  return keys;
}

/**
 * 解析並驗證部署請求攜帶的登入憑證。
 * @param {{credential?: {type: "ssh_key", keys: string[]} | {type: "password", password: string}}} input
 * @returns {{type: "ssh_key", keys: string[]} | {type: "password", password: string}}
 * @throws {WavelengthError} 憑證缺漏、類型無效或內容不符規範時拋出
 */
export function resolveDeployCredential(input) {
  const credential = input?.credential;
  if (!credential || typeof credential !== "object") {
    throw new WavelengthError("缺少登入憑證");
  }
  if (credential.type === "ssh_key") {
    const keys = validateSshPublicKeyText(Array.isArray(credential.keys) ? credential.keys.join("\n") : "");
    return { type: "ssh_key", keys };
  }
  if (credential.type === "password") {
    const { password } = credential;
    if (typeof password !== "string"
      || password.length < ROOT_PASSWORD_MIN_LENGTH
      || password.length > ROOT_PASSWORD_MAX_LENGTH) {
      throw new WavelengthError(
        `root 密碼長度必須為 ${ROOT_PASSWORD_MIN_LENGTH} 到 ${ROOT_PASSWORD_MAX_LENGTH} 字元`,
      );
    }
    return { type: "password", password };
  }
  throw new WavelengthError("登入憑證類型無效，必須是 ssh_key 或 password");
}

/** 結果物件用的密碼欄位：僅密碼模式回填使用者輸入值，金鑰模式為空字串。 */
function credentialPasswordValue(credential) {
  return credential.type === "password" ? credential.password : "";
}

function quoteYamlString(text) {
  return `"${String(text)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

/**
 * 依憑證類型組出 cloud-init 的 YAML 前段與 sshd runcmd：
 * - ssh_key 模式：寫入 root authorized_keys、停用密碼登入（ssh_pwauth false）
 * - password 模式：chpasswd 設定 root 密碼、開放密碼登入（現行行為）
 */
function buildCredentialCloudInitBody(credential) {
  if (credential.type === "ssh_key") {
    // block literal 逐行輸出金鑰；金鑰內容不含換行，固定縮排即安全
    const keyLines = credential.keys.map((key) => `      ${key}`).join("\n");
    return {
      preamble: `disable_root: false
ssh_pwauth: false

write_files:
  - path: /root/.ssh/authorized_keys
    permissions: "0600"
    content: |
${keyLines}`,
      runcmd: [
        "chmod 700 /root/.ssh",
        "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin without-password/' /etc/ssh/sshd_config",
        "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
        "systemctl restart ssh || systemctl restart sshd",
      ],
    };
  }

  const quotedRootPassword = quoteYamlString(credential.password);
  return {
    preamble: `ssh_pwauth: true
disable_root: false

chpasswd:
  expire: false
  users:
    - name: root
      password: ${quotedRootPassword}
      type: text`,
    runcmd: [
      "passwd -u root",
      "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config",
      "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config",
      "systemctl restart ssh || systemctl restart sshd",
    ],
  };
}

function formatRuncmd(commands) {
  return commands.map((command) => `  - ${command}`).join("\n");
}

export function buildCloudInit(credential) {
  const { preamble, runcmd } = buildCredentialCloudInitBody(credential);

  return `#cloud-config

${preamble}

runcmd:
${formatRuncmd(runcmd)}
  - echo ${WAVELENGTH_CLOUD_INIT_MARKER} >/dev/console
`;
}

export function buildForwarderCloudInit(credential, targetPrivateIp, listenPort) {
  const { preamble, runcmd } = buildCredentialCloudInitBody(credential);

  return `#cloud-config

${preamble}

runcmd:
${formatRuncmd(runcmd)}
  - sysctl -w net.ipv4.ip_forward=1
  - printf 'net.ipv4.ip_forward=1\\n' >/etc/sysctl.d/99-wavelength-forwarder.conf
  - iptables -t nat -A PREROUTING -p tcp --dport ${listenPort} -j DNAT --to-destination ${targetPrivateIp}:22
  - iptables -t nat -A POSTROUTING -p tcp -d ${targetPrivateIp} --dport 22 -j MASQUERADE
  - echo ${WAVELENGTH_CLOUD_INIT_MARKER} >/dev/console
`;
}

function ipv4ToInt(ipAddress) {
  return ipAddress
    .split(".")
    .map((part) => Number(part))
    .reduce((value, part) => (value << 8) + part, 0) >>> 0;
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function parseCidr(cidr) {
  const [ipAddress, prefixLength] = cidr.split("/");
  return {
    start: ipv4ToInt(ipAddress),
    prefixLength: Number(prefixLength),
  };
}

function cidrSize(prefixLength) {
  return 2 ** (32 - prefixLength);
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function chooseAvailableSubnetCidr(vpcCidr, existingSubnetCidrs) {
  const vpc = parseCidr(vpcCidr);
  if (vpc.prefixLength > 26) {
    throw new WavelengthError(`VPC CIDR 太小，無法切出 /26 子網: ${vpcCidr}`);
  }

  const vpcSize = cidrSize(vpc.prefixLength);
  const subnetSize = cidrSize(26);
  const vpcEnd = vpc.start + vpcSize - 1;
  const occupiedRanges = existingSubnetCidrs.map((cidr) => {
    const subnet = parseCidr(cidr);
    const size = cidrSize(subnet.prefixLength);
    return {
      start: subnet.start,
      end: subnet.start + size - 1,
    };
  });

  for (let candidate = vpc.start; candidate + subnetSize - 1 <= vpcEnd; candidate += subnetSize) {
    const candidateEnd = candidate + subnetSize - 1;
    const overlaps = occupiedRanges.some((range) =>
      rangesOverlap(candidate, candidateEnd, range.start, range.end),
    );
    if (!overlaps) {
      return `${intToIpv4(candidate)}/26`;
    }
  }

  throw new WavelengthError(`找不到可用的 /26 子網，VPC=${vpcCidr}`);
}

async function describeRegions(env) {
  const xml = await ec2Query("us-east-1", env, "DescribeRegions", {
    AllRegions: "true",
  });
  return parseRegionItems(xml).filter(isRegionEnabled);
}

/** 列出帳號已啟用的全部 AWS Region，供一般 EC2 部署選擇。 */
export async function listEc2Regions(env) {
  return (await describeRegions(env))
    .map(region => region.regionName)
    .sort();
}

/**
 * 列出帳號的全部 AWS Region 與 opt-in 狀態（不過濾），
 * 供帳號管理頁的開通區域功能呈現與操作。
 * @returns {Promise<Array<{region: string, optInStatus: string}>>}
 */
export async function listAccountRegions(env) {
  const xml = await ec2Query("us-east-1", env, "DescribeRegions", {
    AllRegions: "true",
  });
  return parseRegionItems(xml)
    .map(item => ({ region: item.regionName, optInStatus: item.optInStatus }))
    .sort((a, b) => a.region.localeCompare(b.region));
}

/**
 * 為帳號開通指定的 opt-in AWS Region。
 * EC2 EnableRegion 屬帳號層級操作，一律送至 us-east-1；
 * 開通程序由 AWS 於背景進行，需數分鐘後該區域才可供部署。
 */
export function enableAwsRegion(env, region) {
  return ec2Query("us-east-1", env, "EnableRegion", {
    RegionName: region,
  });
}

export async function listWavelengthRegions(env) {
  const regions = await describeRegions(env);

  // 各區域的 Wavelength 探測彼此獨立，平行發送以縮短整體延遲；
  // 單一區域失敗（未開通、無權限、逾時）不應影響其餘區域的列舉。
  const zoneLists = await Promise.all(
    regions.map(async (region) => {
      try {
        const zones = await listWavelengthZones(env, region.regionName);
        return zones.length > 0 ? region.regionName : null;
      } catch {
        return null;
      }
    }),
  );

  return zoneLists.filter(Boolean).sort();
}

export async function listWavelengthZones(env, region) {
  const params = {
    AllAvailabilityZones: "true",
  };
  addFilters(params, [
    {
      name: "zone-type",
      values: ["wavelength-zone"],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeAvailabilityZones", params);
  return parseAvailabilityZonesXml(xml)
    .filter((zone) => zone.zoneType === "wavelength-zone")
    .map((zone) => zone.zoneName)
    .sort();
}

async function listRegionalAvailabilityZones(env, region) {
  const params = {
    AllAvailabilityZones: "true",
  };
  addFilters(params, [
    {
      name: "zone-type",
      values: ["availability-zone"],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeAvailabilityZones", params);
  return parseAvailabilityZonesXml(xml)
    .filter((zone) => zone.zoneType === "availability-zone")
    .filter((zone) => zone.optInStatus === "opt-in-not-required" || zone.optInStatus === "opted-in")
    .map((zone) => zone.zoneName)
    .sort();
}

async function describeWavelengthZone(env, region, zoneName) {
  const params = {
    AllAvailabilityZones: "true",
  };
  addFilters(params, [
    {
      name: "zone-name",
      values: [zoneName],
    },
    {
      name: "zone-type",
      values: ["wavelength-zone"],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeAvailabilityZones", params);
  return parseAvailabilityZonesXml(xml)[0] || null;
}

// ModifyAvailabilityZoneGroup 的狀態變更為非同步生效，API 成功後
// DescribeAvailabilityZones 需數秒至數十秒才反映 opted-in；
// 以固定間隔輪詢確認，避免立即重查讀到舊狀態而誤判 Opt-In 失敗。
const OPT_IN_POLL_INTERVAL_MS = 3_000;
const OPT_IN_POLL_TIMEOUT_MS = 60_000;

async function autoOptInZoneGroup(env, region, zoneDetails) {
  const groupName = zoneDetails.groupName || zoneDetails.zoneName;
  if (!groupName) {
    throw new WavelengthError(`無法判定 Wavelength Zone group: ${zoneDetails.zoneName}`);
  }

  await ec2Query(region, env, "ModifyAvailabilityZoneGroup", {
    GroupName: groupName,
    OptInStatus: "opted-in",
  });
}

async function ensureWavelengthZoneReady(env, region, zoneName) {
  const zoneDetails = await describeWavelengthZone(env, region, zoneName);
  if (!zoneDetails) {
    throw new WavelengthError(`Wavelength Zone 不存在: ${zoneName}`, {
      statusCode: 404,
    });
  }

  if (zoneDetails.optInStatus === "not-opted-in") {
    await autoOptInZoneGroup(env, region, zoneDetails);
    const deadline = Date.now() + OPT_IN_POLL_TIMEOUT_MS;
    let refreshed = zoneDetails;
    while (Date.now() < deadline) {
      await sleep(env, OPT_IN_POLL_INTERVAL_MS);
      refreshed = await describeWavelengthZone(env, region, zoneName);
      if (!refreshed) {
        throw new WavelengthError(`Wavelength Zone 不存在: ${zoneName}`, {
          statusCode: 404,
        });
      }
      if (refreshed.optInStatus !== "not-opted-in") {
        break;
      }
    }
    if (refreshed.optInStatus === "not-opted-in") {
      throw new WavelengthError(`自動 Opt-In 失敗: ${zoneName}`);
    }
    return refreshed;
  }

  if (
    zoneDetails.optInStatus &&
    zoneDetails.optInStatus !== "opted-in" &&
    zoneDetails.optInStatus !== "opt-in-not-required"
  ) {
    throw new WavelengthError(`Wavelength Zone 狀態不可用: ${zoneName}`);
  }

  return zoneDetails;
}

export async function listVpcOptions(env, region) {
  const xml = await ec2Query(region, env, "DescribeVpcs");
  return parseVpcItems(xml)
    .sort((left, right) => {
      if (left.isDefault === right.isDefault) {
        return left.vpcId.localeCompare(right.vpcId);
      }
      return left.isDefault ? -1 : 1;
    })
    .map((vpc) => ({
      value: vpc.vpcId,
      label: `${vpc.vpcId}${vpc.isDefault ? "（預設）" : ""} ${vpc.cidrBlock}`,
      cidr_block: vpc.cidrBlock,
      is_default: vpc.isDefault,
      name: vpc.name,
    }));
}

export function listWavelengthOsOptions() {
  return OS_OPTIONS.map(({ value, label }) => ({ value, label }));
}

export async function listWavelengthInstanceTypes(env, region, zone) {
  const params = {
    LocationType: "availability-zone",
  };
  addFilters(params, [
    {
      name: "location",
      values: [zone],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeInstanceTypeOfferings", params);
  return parseInstanceTypeOfferings(xml)
    .map((offering) => offering.instanceType)
    .sort(compareInstanceTypesBySize);
}

async function describeSelectedVpc(env, region, vpcId) {
  const xml = await ec2Query(region, env, "DescribeVpcs", {
    "VpcId.1": vpcId,
  });
  const vpcs = parseVpcItems(xml);
  if (vpcs.length === 0) {
    throw new WavelengthError(`找不到指定的 VPC: ${vpcId}`, { statusCode: 404 });
  }
  return vpcs[0];
}

async function describeSubnets(env, region, vpcId) {
  const params = {};
  addFilters(params, [
    {
      name: "vpc-id",
      values: [vpcId],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeSubnets", params);
  return parseSubnetItems(xml);
}

async function ensureWavelengthSubnet(env, region, vpc, zone, options = {}) {
  const { createIfMissing = true } = options;
  const subnets = await describeSubnets(env, region, vpc.vpcId);
  const existing = subnets.find((subnet) => subnet.availabilityZone === zone);
  if (existing) {
    if (createIfMissing) {
      await tagExistingResource(env, region, existing.subnetId, zone);
    }
    return existing;
  }

  if (!createIfMissing) {
    throw new WavelengthError(
      `Wavelength 子網尚未初始化: ${zone}，請先執行 Zone 初始化`,
    );
  }

  const cidrBlock = chooseAvailableSubnetCidr(
    vpc.cidrBlock,
    subnets.map((subnet) => subnet.cidrBlock),
  );
  const params = {
    VpcId: vpc.vpcId,
    AvailabilityZone: zone,
    CidrBlock: cidrBlock,
  };
  addTagSpecification(params, 1, "subnet", buildManagedTags(zone, {
    Name: formatResourceName("subnet", zone),
  }));
  const xml = await ec2Query(region, env, "CreateSubnet", params);
  return parseCreatedSubnet(xml);
}

async function ensureRegionalSubnet(env, region, vpc, zone) {
  const subnets = await describeSubnets(env, region, vpc.vpcId);
  const existing = subnets.find((subnet) => subnet.availabilityZone && subnet.availabilityZone !== zone);
  if (existing) {
    return existing;
  }

  const regionalZones = await listRegionalAvailabilityZones(env, region);
  if (regionalZones.length === 0) {
    throw new WavelengthError(`找不到可部署普通 EC2 的 Availability Zone: ${region}`);
  }

  const cidrBlock = chooseAvailableSubnetCidr(
    vpc.cidrBlock,
    subnets.map((subnet) => subnet.cidrBlock),
  );
  const params = {
    VpcId: vpc.vpcId,
    AvailabilityZone: regionalZones[0],
    CidrBlock: cidrBlock,
  };
  addTagSpecification(params, 1, "subnet", buildManagedTags(zone, {
    Name: formatResourceName("forwarder-subnet", zone),
  }));
  const xml = await ec2Query(region, env, "CreateSubnet", params);
  return parseCreatedSubnet(xml);
}

async function describeCarrierGateways(env, region, vpcId) {
  const params = {};
  addFilters(params, [
    {
      name: "vpc-id",
      values: [vpcId],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeCarrierGateways", params);
  return parseCarrierGatewayItems(xml);
}

async function ensureCarrierGateway(env, region, vpcId, zone, options = {}) {
  const { createIfMissing = true } = options;
  const existing = (await describeCarrierGateways(env, region, vpcId)).find(
    (gateway) => gateway.state !== "deleted",
  );
  if (existing) {
    if (createIfMissing) {
      await tagExistingResource(env, region, existing.carrierGatewayId, zone);
    }
    return existing.carrierGatewayId;
  }

  if (!createIfMissing) {
    throw new WavelengthError(
      `Carrier Gateway 尚未初始化: ${zone}，請先執行 Zone 初始化`,
    );
  }

  const params = {
    VpcId: vpcId,
  };
  addTagSpecification(params, 1, "carrier-gateway", buildManagedTags(zone, {
    Name: formatResourceName("carrier-gateway", zone),
  }));
  const xml = await ec2Query(region, env, "CreateCarrierGateway", params);
  const carrierGatewayId = parseCreatedCarrierGatewayId(xml);
  if (!carrierGatewayId) {
    throw new WavelengthError("Carrier Gateway 建立失敗");
  }
  return carrierGatewayId;
}

async function describeSecurityGroups(env, region, vpcId) {
  const params = {};
  addFilters(params, [
    {
      name: "vpc-id",
      values: [vpcId],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeSecurityGroups", params);
  return parseSecurityGroupItems(xml);
}

async function ensureFullAccessSecurityGroup(env, region, vpcId, zone, options = {}) {
  const { createIfMissing = true } = options;
  const existing = (await describeSecurityGroups(env, region, vpcId)).find(
    (group) => group.ingressAll && group.egressAll,
  );
  if (existing) {
    if (createIfMissing) {
      await tagExistingResource(env, region, existing.groupId, zone);
    }
    return existing.groupId;
  }

  if (!createIfMissing) {
    throw new WavelengthError(
      `Security Group 尚未初始化: ${zone}，請先執行 Zone 初始化`,
    );
  }

  const createParams = {
    VpcId: vpcId,
    GroupName: formatResourceName("security-group", zone),
    GroupDescription: "Managed full-access security group for Wavelength deployments",
  };
  addTagSpecification(createParams, 1, "security-group", buildManagedTags(zone, {
    Name: formatResourceName("security-group", zone),
  }));
  const createXml = await ec2Query(region, env, "CreateSecurityGroup", createParams);
  const groupId = parseCreatedSecurityGroupId(createXml);
  if (!groupId) {
    throw new WavelengthError("Security Group 建立失敗");
  }

  const ingressParams = {
    GroupId: groupId,
    "IpPermissions.1.IpProtocol": "-1",
    "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0",
  };
  await ec2Query(region, env, "AuthorizeSecurityGroupIngress", ingressParams);
  return groupId;
}

async function describeRouteTables(env, region, vpcId) {
  const params = {};
  addFilters(params, [
    {
      name: "vpc-id",
      values: [vpcId],
    },
  ]);
  const xml = await ec2Query(region, env, "DescribeRouteTables", params);
  return parseRouteTableItems(xml);
}

function findRouteTableForSubnet(routeTables, subnetId, zone) {
  const associated = routeTables.find((routeTable) =>
    routeTable.associations.some((association) => association.subnetId === subnetId),
  );
  if (associated) {
    return associated;
  }

  return routeTables.find((routeTable) => routeTable.zoneTag === zone) || null;
}

async function ensureRouteTable(
  env,
  region,
  vpcId,
  subnetId,
  carrierGatewayId,
  zone,
  options = {},
) {
  const { createIfMissing = true } = options;
  const routeTables = await describeRouteTables(env, region, vpcId);
  let routeTable = findRouteTableForSubnet(routeTables, subnetId, zone);
  let reusedRouteTable = Boolean(routeTable);

  if (!routeTable) {
    if (!createIfMissing) {
      throw new WavelengthError(
        `Route Table 尚未初始化: ${zone}，請先執行 Zone 初始化`,
      );
    }
    const createParams = {
      VpcId: vpcId,
    };
    addTagSpecification(createParams, 1, "route-table", buildManagedTags(zone, {
      Name: formatResourceName("route-table", zone),
    }));
    const createXml = await ec2Query(region, env, "CreateRouteTable", createParams);
    routeTable = {
      routeTableId: parseCreatedRouteTableId(createXml),
      associations: [],
      routes: [],
    };
    if (!routeTable.routeTableId) {
      throw new WavelengthError("Route Table 建立失敗");
    }
    reusedRouteTable = false;
  }

  if (createIfMissing && reusedRouteTable) {
    await tagExistingResource(env, region, routeTable.routeTableId, zone);
  }

  const defaultRoute = routeTable.routes.find(
    (route) => route.destinationCidrBlock === "0.0.0.0/0",
  );
  if (!defaultRoute) {
    if (!createIfMissing) {
      throw new WavelengthError(
        `Route Table 缺少 0.0.0.0/0 預設路由: ${zone}，請先執行 Zone 初始化`,
      );
    }
    await ec2Query(region, env, "CreateRoute", {
      RouteTableId: routeTable.routeTableId,
      DestinationCidrBlock: "0.0.0.0/0",
      CarrierGatewayId: carrierGatewayId,
    });
  } else if (defaultRoute.carrierGatewayId !== carrierGatewayId) {
    throw new WavelengthError("Route Table 已存在衝突的 0.0.0.0/0 路由");
  }

  const associated = routeTable.associations.some((association) => association.subnetId === subnetId);
  if (!associated) {
    if (!createIfMissing) {
      throw new WavelengthError(
        `Route Table 尚未關聯子網: ${zone}，請先執行 Zone 初始化`,
      );
    }
    await ec2Query(region, env, "AssociateRouteTable", {
      RouteTableId: routeTable.routeTableId,
      SubnetId: subnetId,
    });
  }

  return routeTable.routeTableId;
}

async function describeInstanceType(env, region, instanceType) {
  const xml = await ec2Query(region, env, "DescribeInstanceTypes", {
    "InstanceType.1": instanceType,
  });
  const result = parseInstanceTypes(xml)[0];
  if (!result) {
    throw new WavelengthError(`查不到 Instance Type: ${instanceType}`, {
      statusCode: 404,
    });
  }
  return result;
}

async function resolveAmi(env, region, osValue, architecture) {
  const osDefinition = getOsDefinition(osValue);
  const imagePattern = osDefinition.imageNameByArchitecture[architecture];
  if (!imagePattern) {
    throw new WavelengthError(`作業系統 ${osValue} 不支援架構 ${architecture}`);
  }

  const params = {};
  addFilters(params, [
    { name: "name", values: [imagePattern] },
    { name: "state", values: ["available"] },
  ]);
  addIndexedValues(params, "Owner", osDefinition.owners);
  const xml = await ec2Query(region, env, "DescribeImages", params);
  const images = parseImageItems(xml).sort((left, right) =>
    right.creationDate.localeCompare(left.creationDate),
  );
  if (images.length === 0) {
    throw new WavelengthError(`AMI 查詢失敗: 找不到 ${osValue} 可用映像`);
  }
  return images[0];
}

async function ensureInstanceTypeOffering(env, region, zone, instanceType) {
  const offerings = await listWavelengthInstanceTypes(env, region, zone);
  if (!offerings.includes(instanceType)) {
    throw new WavelengthError(`Instance Type ${instanceType} 不支援 ${zone}`);
  }
}

async function waitForInstanceRunning(env, region, instanceId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    try {
      const xml = await ec2Query(region, env, "DescribeInstances", {
        "InstanceId.1": instanceId,
      });
      const instance = parseInstanceDescription(xml);
      if (instance.state === "running") {
        return instance;
      }
    } catch (error) {
      if (!isRetryablePollingError(error) || attempt === POLL_ATTEMPTS - 1) {
        throw error;
      }
    }
    if (attempt < POLL_ATTEMPTS - 1) {
      await sleep(env, POLL_DELAY_MS);
    }
  }

  throw new WavelengthError(`執行個體 ${instanceId} 未在期限內進入 running 狀態`);
}

async function waitForInstancePublicDns(env, region, instanceId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    try {
      const xml = await ec2Query(region, env, "DescribeInstances", {
        "InstanceId.1": instanceId,
      });
      const instance = parseInstanceDescription(xml);
      if (instance.publicDnsName) {
        return instance;
      }
    } catch (error) {
      if (!isRetryablePollingError(error) || attempt === POLL_ATTEMPTS - 1) {
        throw error;
      }
    }
    if (attempt < POLL_ATTEMPTS - 1) {
      await sleep(env, POLL_DELAY_MS);
    }
  }

  throw new WavelengthError(`執行個體 ${instanceId} 未在期限內取得公網 DNS`);
}

async function waitForInstanceStatusOk(env, region, instanceId, onProgress = () => {}) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    try {
      const xml = await ec2Query(region, env, "DescribeInstanceStatus", {
        "InstanceId.1": instanceId,
        IncludeAllInstances: "true",
      });
      const status = parseInstanceStatus(xml);
      onProgress("status_check_progress", {
        instance_id: instanceId,
        attempt: attempt + 1,
        max_attempts: POLL_ATTEMPTS,
        instance_status: status.instanceStatus || "pending",
        system_status: status.systemStatus || "pending",
      });
      if (status.instanceStatus === "ok" && status.systemStatus === "ok") {
        return;
      }
    } catch (error) {
      if (!isRetryablePollingError(error) || attempt === POLL_ATTEMPTS - 1) {
        throw error;
      }
      onProgress("status_check_progress", {
        instance_id: instanceId,
        attempt: attempt + 1,
        max_attempts: POLL_ATTEMPTS,
        instance_status: "retrying",
        system_status: "retrying",
      });
    }
    if (attempt < POLL_ATTEMPTS - 1) {
      await sleep(env, POLL_DELAY_MS);
    }
  }

  throw new WavelengthError(`執行個體 ${instanceId} 狀態檢查未通過`);
}

async function waitForCloudInit(env, region, instanceId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    try {
      const xml = await ec2Query(region, env, "GetConsoleOutput", {
        InstanceId: instanceId,
        Latest: "true",
      });
      const output = decodeBase64(parseConsoleOutput(xml));
      if (output.includes(WAVELENGTH_CLOUD_INIT_MARKER)) {
        return;
      }
    } catch (error) {
      if (!isRetryablePollingError(error) || attempt === POLL_ATTEMPTS - 1) {
        throw error;
      }
    }
    if (attempt < POLL_ATTEMPTS - 1) {
      await sleep(env, POLL_DELAY_MS);
    }
  }

  throw new WavelengthError(`cloud-init 未在期限內完成: ${instanceId}`);
}

function mapAwsError(error) {
  if (!(error instanceof AwsRequestError)) {
    return error;
  }

  if (error.code === "UnauthorizedOperation" || error.code === "AuthFailure") {
    return new WavelengthError(`IAM 權限不足: ${error.message}`, { statusCode: 403 });
  }
  if (error.code === "RequestLimitExceeded" || error.code === "Throttling") {
    return new WavelengthError(`AWS API Throttling: ${error.message}`, { statusCode: 429 });
  }

  return new WavelengthError(error.message || "AWS API 請求失敗", {
    statusCode: error.statusCode || 500,
  });
}

function buildLaunchedInstanceResult({
  instanceId,
  state,
  publicIpAddress = "",
  publicDnsName = "",
  privateIpAddress = "",
  privateDnsName = "",
  subnetId,
  carrierGatewayId,
  routeTableId,
  credential,
  ready,
  waitError = "",
  forwarder = null,
  instanceType = "",
}) {
  return {
    ready,
    instance_id: instanceId,
    state,
    instance_type: instanceType,
    public_ip: publicIpAddress,
    public_dns_name: publicDnsName,
    private_ip: privateIpAddress,
    private_dns_name: privateDnsName,
    subnet_id: subnetId,
    carrier_gateway_id: carrierGatewayId,
    route_table_id: routeTableId,
    username: "root",
    password: credentialPasswordValue(credential),
    credential_type: credential.type,
    ssh_command: publicDnsName ? `ssh root@${publicDnsName}` : "",
    ...(forwarder ? { forwarder } : {}),
    ...(waitError
      ? {
          warning:
            "執行個體已啟動，但就緒檢查未完成。請保存連線憑證，並前往 AWS 主控台檢查該執行個體。",
          wait_error: waitError,
        }
      : {}),
  };
}

function buildRegionalInstanceResult({
  instanceId,
  state,
  publicIpAddress = "",
  publicDnsName = "",
  privateIpAddress = "",
  privateDnsName = "",
  subnetId,
  securityGroupId,
  credential,
  ready,
  waitError = "",
  instanceType = "",
}) {
  return {
    ready,
    instance_id: instanceId,
    state,
    instance_type: instanceType,
    public_ip: publicIpAddress,
    public_dns_name: publicDnsName,
    private_ip: privateIpAddress,
    private_dns_name: privateDnsName,
    subnet_id: subnetId,
    security_group_id: securityGroupId,
    username: "root",
    password: credentialPasswordValue(credential),
    credential_type: credential.type,
    ssh_command: publicDnsName ? `ssh root@${publicDnsName}` : "",
    ...(waitError
      ? {
          warning:
            "執行個體已啟動，但就緒檢查未完成。請保存連線憑證，並前往 AWS 主控台檢查該執行個體。",
          wait_error: waitError,
        }
      : {}),
  };
}

async function launchForwarderInstance({
  env,
  region,
  zone,
  vpc,
  subnet,
  securityGroupId,
  image,
  instanceType,
  os,
  credential,
  targetPrivateIp,
  onProgress,
}) {
  const listenPort = generateForwarderListenPort();
  const userData = toBase64(buildForwarderCloudInit(credential, targetPrivateIp, listenPort));
  const runParams = {
    ImageId: image.imageId,
    InstanceType: instanceType,
    MinCount: "1",
    MaxCount: "1",
    UserData: userData,
    "BlockDeviceMapping.1.DeviceName": image.rootDeviceName || "/dev/sda1",
    "BlockDeviceMapping.1.Ebs.SnapshotId": image.rootSnapshotId,
    "BlockDeviceMapping.1.Ebs.VolumeType": "gp2",
    "NetworkInterface.1.DeviceIndex": "0",
    "NetworkInterface.1.SubnetId": subnet.subnetId,
    "NetworkInterface.1.AssociatePublicIpAddress": "true",
    "NetworkInterface.1.SecurityGroupId.1": securityGroupId,
  };
  addTagSpecification(runParams, 1, "instance", buildManagedTags(zone, {
    Name: formatResourceName("forwarder", zone),
    Os: os,
    Role: "ssh-forwarder",
  }));

  const runXml = await ec2Query(region, env, "RunInstances", runParams);
  const launched = parseRunInstances(runXml);
  if (!launched.instanceId) {
    throw new WavelengthError("Forwarder EC2 啟動失敗");
  }

  onProgress("forwarder_launched", {
    instance_id: launched.instanceId,
    listen_port: listenPort,
  });
  await ec2Query(region, env, "ModifyInstanceAttribute", {
    InstanceId: launched.instanceId,
    "SourceDestCheck.Value": "false",
  });

  onProgress("waiting_for_forwarder_running", { instance_id: launched.instanceId });
  let instance = await waitForInstanceRunning(env, region, launched.instanceId);
  onProgress("forwarder_running", { instance_id: launched.instanceId });
  onProgress("waiting_for_forwarder_public_dns", { instance_id: launched.instanceId });
  instance = await waitForInstancePublicDns(env, region, launched.instanceId);
  onProgress("forwarder_public_dns_ready", {
    instance_id: launched.instanceId,
    public_dns_name: instance.publicDnsName,
    listen_port: listenPort,
  });
  onProgress("waiting_for_forwarder_status_checks", { instance_id: launched.instanceId });
  await waitForInstanceStatusOk(env, region, launched.instanceId, onProgress);
  onProgress("forwarder_status_checks_passed", { instance_id: launched.instanceId });
  onProgress("waiting_for_forwarder_cloud_init", { instance_id: launched.instanceId });
  await waitForCloudInit(env, region, launched.instanceId);
  onProgress("forwarder_cloud_init_complete", { instance_id: launched.instanceId });

  return {
    instance_id: launched.instanceId,
    state: instance.state,
    public_ip: instance.publicIpAddress,
    public_dns_name: instance.publicDnsName,
    private_ip: instance.privateIpAddress,
    private_dns_name: instance.privateDnsName,
    subnet_id: subnet.subnetId,
    vpc_id: vpc.vpcId,
    instance_type: instanceType,
    username: "root",
    password: credentialPasswordValue(credential),
    credential_type: credential.type,
    listen_port: listenPort,
    target_private_ip: targetPrivateIp,
    target_port: 22,
    ssh_command: instance.publicDnsName ? `ssh -p ${listenPort} root@${instance.publicDnsName}` : "",
  };
}

export async function listExistingWavelengthInstances(env, input) {
  try {
    validateListExistingWavelengthInstancesInput(input);

    const params = {};
    addFilters(params, [
      { name: "availability-zone", values: [input.zone] },
      { name: "vpc-id", values: [input.vpc_id] },
      { name: "instance-state-name", values: ["pending", "running"] },
    ]);

    const xml = await ec2Query(input.region, env, "DescribeInstances", params);
    return parseInstanceDescriptions(xml).map((instance) => ({
      instance_id: instance.instanceId,
      state: instance.state,
      instance_type: instance.instanceType,
      private_ip: instance.privateIpAddress,
      private_dns_name: instance.privateDnsName,
      public_dns_name: instance.publicDnsName,
      subnet_id: instance.subnetId,
      vpc_id: instance.vpcId,
      availability_zone: instance.availabilityZone,
    }));
  } catch (error) {
    throw mapAwsError(error);
  }
}

export async function deployRegionalEc2Instance(env, input, /** @type {ProgressReporter} */ onProgress = () => {}) {
  try {
    validateRegionalDeployInput(input);
    onProgress("validating", { region: input.region });

    const regionalInstanceType = getRegionalInstanceType(input);
    const instanceType = await describeInstanceType(env, input.region, regionalInstanceType);
    const architecture = instanceType.supportedArchitectures[0];
    const image = await resolveAmi(env, input.region, input.os, architecture);
    const vpc = await describeSelectedVpc(env, input.region, input.vpc_id);
    const subnet = await ensureRegionalSubnet(env, input.region, vpc, input.region);
    const securityGroupId = await ensureFullAccessSecurityGroup(
      env,
      input.region,
      vpc.vpcId,
      input.region,
      { createIfMissing: true },
    );
    onProgress("resources_ready", {
      subnet_id: subnet.subnetId,
      security_group_id: securityGroupId,
    });

    const credential = resolveDeployCredential(input);
    onProgress("credentials_ready", {
      username: "root",
      credential_type: credential.type,
    });
    const userData = toBase64(buildCloudInit(credential));
    const runParams = {
      ImageId: image.imageId,
      InstanceType: regionalInstanceType,
      MinCount: "1",
      MaxCount: "1",
      UserData: userData,
      "BlockDeviceMapping.1.DeviceName": image.rootDeviceName || "/dev/sda1",
      "BlockDeviceMapping.1.Ebs.SnapshotId": image.rootSnapshotId,
      "BlockDeviceMapping.1.Ebs.VolumeType": "gp2",
      "NetworkInterface.1.DeviceIndex": "0",
      "NetworkInterface.1.SubnetId": subnet.subnetId,
      "NetworkInterface.1.AssociatePublicIpAddress": "true",
      "NetworkInterface.1.SecurityGroupId.1": securityGroupId,
    };
    addTagSpecification(runParams, 1, "instance", buildManagedTags(input.region, {
      Name: formatResourceName("regional-instance", input.region),
      Os: input.os,
    }));
    const runXml = await ec2Query(input.region, env, "RunInstances", runParams);
    const launched = parseRunInstances(runXml);
    if (!launched.instanceId) {
      throw new WavelengthError("EC2 啟動失敗");
    }

    let instance = null;
    onProgress("instance_launched", { instance_id: launched.instanceId });
    try {
      onProgress("waiting_for_running", { instance_id: launched.instanceId });
      instance = await waitForInstanceRunning(env, input.region, launched.instanceId);
      onProgress("instance_running", { instance_id: launched.instanceId });
      onProgress("waiting_for_public_dns", { instance_id: launched.instanceId });
      instance = await waitForInstancePublicDns(env, input.region, launched.instanceId);
      onProgress("public_dns_ready", {
        instance_id: launched.instanceId,
        public_dns_name: instance.publicDnsName,
      });
      onProgress("waiting_for_status_checks", { instance_id: launched.instanceId });
      await waitForInstanceStatusOk(env, input.region, launched.instanceId, onProgress);
      onProgress("status_checks_passed", { instance_id: launched.instanceId });
      onProgress("waiting_for_cloud_init", { instance_id: launched.instanceId });
      await waitForCloudInit(env, input.region, launched.instanceId);
      onProgress("cloud_init_complete", { instance_id: launched.instanceId });
    } catch (error) {
      return buildRegionalInstanceResult({
        instanceId: launched.instanceId,
        state: instance?.state || "launched",
        publicIpAddress: instance?.publicIpAddress || "",
        publicDnsName: instance?.publicDnsName || "",
        privateIpAddress: instance?.privateIpAddress || "",
        privateDnsName: instance?.privateDnsName || "",
        subnetId: subnet.subnetId,
        securityGroupId,
        credential,
        ready: false,
        waitError: error.message || String(error),
        instanceType: regionalInstanceType,
      });
    }

    return buildRegionalInstanceResult({
      instanceId: launched.instanceId,
      state: instance.state,
      publicIpAddress: instance.publicIpAddress,
      publicDnsName: instance.publicDnsName,
      privateIpAddress: instance.privateIpAddress,
      privateDnsName: instance.privateDnsName,
      subnetId: subnet.subnetId,
      securityGroupId,
      credential,
      ready: true,
      instanceType: regionalInstanceType,
    });
  } catch (error) {
    throw mapAwsError(error);
  }
}

export async function deployForwarderForExistingWavelengthInstance(env, input, /** @type {ProgressReporter} */ onProgress = () => {}) {
  try {
    validateExistingForwarderInput(input);
    onProgress("validating_existing_forwarder", {
      instance_id: input.instance_id,
      zone: input.zone,
    });

    const targetXml = await ec2Query(input.region, env, "DescribeInstances", {
      "InstanceId.1": input.instance_id,
    });
    const target = parseInstanceDescription(targetXml);
    if (!target.instanceId) {
      throw new WavelengthError(`找不到指定的 WL EC2: ${input.instance_id}`, { statusCode: 404 });
    }
    if (target.vpcId !== input.vpc_id || target.availabilityZone !== input.zone) {
      throw new WavelengthError("選中的 WL EC2 不屬於目前選擇的 Zone/VPC", { statusCode: 400 });
    }
    if (!target.privateIpAddress) {
      throw new WavelengthError("選中的 WL EC2 沒有私網 IP，無法配置轉發", { statusCode: 400 });
    }

    const regionalInstanceType = getRegionalInstanceType();
    const instanceType = await describeInstanceType(env, input.region, regionalInstanceType);
    const architecture = instanceType.supportedArchitectures[0];
    const image = await resolveAmi(env, input.region, input.os, architecture);
    const vpc = await describeSelectedVpc(env, input.region, input.vpc_id);
    const securityGroupId = await ensureFullAccessSecurityGroup(
      env,
      input.region,
      input.vpc_id,
      input.zone,
      { createIfMissing: false },
    );
    const forwarderSubnet = await ensureRegionalSubnet(env, input.region, vpc, input.zone);

    onProgress("preparing_forwarder", {
      target_instance_id: target.instanceId,
      target_instance_type: target.instanceType,
      target_private_ip: target.privateIpAddress,
      target_port: 22,
    });
    const credential = resolveDeployCredential(input);
    onProgress("credentials_ready", {
      username: "root",
      credential_type: credential.type,
    });
    const forwarder = await launchForwarderInstance({
      env,
      region: input.region,
      zone: input.zone,
      vpc,
      subnet: forwarderSubnet,
      securityGroupId,
      image,
      instanceType: regionalInstanceType,
      os: input.os,
      credential,
      targetPrivateIp: target.privateIpAddress,
      onProgress,
    });

    return {
      ready: true,
      target_instance_id: target.instanceId,
      target_private_ip: target.privateIpAddress,
      target_private_dns_name: target.privateDnsName,
      target_public_dns_name: target.publicDnsName,
      security_group_id: securityGroupId,
      forwarder,
    };
  } catch (error) {
    throw mapAwsError(error);
  }
}

export async function deployWavelengthInstance(env, input, /** @type {ProgressReporter} */ onProgress = () => {}) {
  try {
    validateDeployInput(input);
    onProgress("validating", { region: input.region, zone: input.zone });

    await ensureWavelengthZoneReady(env, input.region, input.zone);
    onProgress("zone_ready", { zone: input.zone });

    await ensureInstanceTypeOffering(env, input.region, input.zone, input.instance_type);
    const instanceType = await describeInstanceType(env, input.region, input.instance_type);
    const architecture = instanceType.supportedArchitectures[0];
    const image = await resolveAmi(env, input.region, input.os, architecture);
    const vpc = await describeSelectedVpc(env, input.region, input.vpc_id);
    const subnet = await ensureWavelengthSubnet(env, input.region, vpc, input.zone, {
      createIfMissing: false,
    });
    const carrierGatewayId = await ensureCarrierGateway(
      env,
      input.region,
      vpc.vpcId,
      input.zone,
      { createIfMissing: false },
    );
    const securityGroupId = await ensureFullAccessSecurityGroup(
      env,
      input.region,
      vpc.vpcId,
      input.zone,
      { createIfMissing: false },
    );
    const routeTableId = await ensureRouteTable(
      env,
      input.region,
      vpc.vpcId,
      subnet.subnetId,
      carrierGatewayId,
      input.zone,
      { createIfMissing: false },
    );
    onProgress("resources_ready", {
      subnet_id: subnet.subnetId,
      carrier_gateway_id: carrierGatewayId,
      route_table_id: routeTableId,
      security_group_id: securityGroupId,
    });
    const credential = resolveDeployCredential(input);
    onProgress("credentials_ready", {
      username: "root",
      credential_type: credential.type,
    });
    const userData = toBase64(buildCloudInit(credential));
    const runParams = {
      ImageId: image.imageId,
      InstanceType: input.instance_type,
      MinCount: "1",
      MaxCount: "1",
      UserData: userData,
      "BlockDeviceMapping.1.DeviceName": image.rootDeviceName || "/dev/sda1",
      "BlockDeviceMapping.1.Ebs.SnapshotId": image.rootSnapshotId,
      "BlockDeviceMapping.1.Ebs.VolumeType": "gp2",
      "NetworkInterface.1.DeviceIndex": "0",
      "NetworkInterface.1.SubnetId": subnet.subnetId,
      "NetworkInterface.1.AssociateCarrierIpAddress": "true",
      "NetworkInterface.1.SecurityGroupId.1": securityGroupId,
    };
    addTagSpecification(runParams, 1, "instance", buildManagedTags(input.zone, {
      Name: formatResourceName("instance", input.zone),
      Os: input.os,
    }));
    const runXml = await ec2Query(input.region, env, "RunInstances", runParams);
    const launched = parseRunInstances(runXml);
    if (!launched.instanceId) {
      throw new WavelengthError("EC2 啟動失敗");
    }

    let instance = null;
    let forwarder = null;
    onProgress("instance_launched", { instance_id: launched.instanceId });
    try {
      onProgress("waiting_for_running", { instance_id: launched.instanceId });
      instance = await waitForInstanceRunning(env, input.region, launched.instanceId);
      onProgress("instance_running", { instance_id: launched.instanceId });
      onProgress("waiting_for_public_dns", { instance_id: launched.instanceId });
      instance = await waitForInstancePublicDns(env, input.region, launched.instanceId);
      onProgress("public_dns_ready", {
        instance_id: launched.instanceId,
        public_dns_name: instance.publicDnsName,
      });
      if (isForwarderEnabled(input)) {
        onProgress("preparing_forwarder", {
          target_private_ip: instance.privateIpAddress,
          target_port: 22,
        });
        const forwarderSubnet = await ensureRegionalSubnet(env, input.region, vpc, input.zone);
        forwarder = await launchForwarderInstance({
          env,
          region: input.region,
          zone: input.zone,
          vpc,
          subnet: forwarderSubnet,
          securityGroupId,
          image,
          instanceType: getRegionalInstanceType(input),
          os: input.os,
          credential,
          targetPrivateIp: instance.privateIpAddress,
          onProgress,
        });
        return buildLaunchedInstanceResult({
          instanceId: launched.instanceId,
          state: instance.state,
          publicIpAddress: instance.publicIpAddress,
          publicDnsName: instance.publicDnsName,
          privateIpAddress: instance.privateIpAddress,
          privateDnsName: instance.privateDnsName,
          subnetId: subnet.subnetId,
          carrierGatewayId,
          routeTableId,
          credential,
          ready: true,
          forwarder,
          instanceType: input.instance_type,
        });
      }
      onProgress("waiting_for_status_checks", { instance_id: launched.instanceId });
      await waitForInstanceStatusOk(env, input.region, launched.instanceId, onProgress);
      onProgress("status_checks_passed", { instance_id: launched.instanceId });
      onProgress("waiting_for_cloud_init", { instance_id: launched.instanceId });
      await waitForCloudInit(env, input.region, launched.instanceId);
      onProgress("cloud_init_complete", { instance_id: launched.instanceId });
    } catch (error) {
      return buildLaunchedInstanceResult({
        instanceId: launched.instanceId,
        state: instance?.state || "launched",
        publicIpAddress: instance?.publicIpAddress || "",
        publicDnsName: instance?.publicDnsName || "",
        privateIpAddress: instance?.privateIpAddress || "",
        privateDnsName: instance?.privateDnsName || "",
        subnetId: subnet.subnetId,
        carrierGatewayId,
        routeTableId,
        credential,
        ready: false,
        waitError: error.message || String(error),
        forwarder,
        instanceType: input.instance_type,
      });
    }

    return buildLaunchedInstanceResult({
      instanceId: launched.instanceId,
      state: instance.state,
      publicIpAddress: instance.publicIpAddress,
      publicDnsName: instance.publicDnsName,
      privateIpAddress: instance.privateIpAddress,
      privateDnsName: instance.privateDnsName,
      subnetId: subnet.subnetId,
      carrierGatewayId,
      routeTableId,
      credential,
      ready: true,
      forwarder,
      instanceType: input.instance_type,
    });
  } catch (error) {
    throw mapAwsError(error);
  }
}

export async function initializeWavelengthZone(env, input) {
  try {
    validateInitInput(input);

    await ensureWavelengthZoneReady(env, input.region, input.zone);

    const vpc = await describeSelectedVpc(env, input.region, input.vpc_id);
    const subnet = await ensureWavelengthSubnet(env, input.region, vpc, input.zone, {
      createIfMissing: true,
    });
    const carrierGatewayId = await ensureCarrierGateway(
      env,
      input.region,
      vpc.vpcId,
      input.zone,
      { createIfMissing: true },
    );
    const securityGroupId = await ensureFullAccessSecurityGroup(
      env,
      input.region,
      vpc.vpcId,
      input.zone,
      { createIfMissing: true },
    );
    const routeTableId = await ensureRouteTable(
      env,
      input.region,
      vpc.vpcId,
      subnet.subnetId,
      carrierGatewayId,
      input.zone,
      { createIfMissing: true },
    );

    return {
      region: input.region,
      zone: input.zone,
      vpc_id: vpc.vpcId,
      subnet_id: subnet.subnetId,
      carrier_gateway_id: carrierGatewayId,
      route_table_id: routeTableId,
      security_group_id: securityGroupId,
      message: "Wavelength Zone 初始化完成",
    };
  } catch (error) {
    throw mapAwsError(error);
  }
}

export function toHttpError(error) {
  if (error instanceof WavelengthError) {
    return {
      status: error.statusCode,
      body: {
        error: error.message,
      },
    };
  }

  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600) {
    return {
      status: error.statusCode,
      body: { error: error.message || "請求失敗" },
    };
  }

  return {
    status: 500,
    body: {
      error: "伺服器內部錯誤",
    },
  };
}
