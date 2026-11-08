// OCI Network 呼叫：VNIC／公網 IP／IPv6 開通／Security List 防火牆。
// 長操作函式接受 emit（progress 事件推送）回呼，供 SSE 路由回報進度；
// 冪等性：每步先查詢確認，已完成的步驟直接跳過。
import { ociRequestJson } from "./oci-request.js";
import { OciApiError } from "./oci-error.js";

function request(ctx) {
  return (options) => ociRequestJson({ ...options, account: ctx.account, privateKeyPem: ctx.privateKeyPem });
}

// ─── VNIC 與 IP 解析 ────────────────────────────────────────

/**
 * 取得執行個體的主要 VNIC（第一個 ATTACHED 的掛載）。
 * @returns {Promise<{ vnicId: string, vnic: any }|null>} null 表示尚無掛載
 */
export async function getPrimaryVnic(ctx, { instanceId, compartmentOcid }) {
  const api = request(ctx);
  const attachments = await api({
    method: "GET",
    path: "/20160918/vnicAttachments",
    query: { compartmentId: compartmentOcid, instanceId },
  });
  const attached = (Array.isArray(attachments) ? attachments : [])
    .find(item => item?.lifecycleState === "ATTACHED" && item?.vnicId);
  if (!attached) {
    return null;
  }
  const vnic = await api({ method: "GET", path: `/20160918/vnics/${encodeURIComponent(attached.vnicId)}` });
  return { vnicId: attached.vnicId, vnic };
}

/**
 * 取得主要 private IP 的 OCID（CreatePublicIp 需 privateIpId）。
 */
export async function getPrimaryPrivateIpId(ctx, vnicId) {
  const api = request(ctx);
  const privateIps = await api({
    method: "GET",
    path: "/20160918/privateIps",
    query: { vnicId },
  });
  const primary = (Array.isArray(privateIps) ? privateIps : []).find(item => item?.isPrimary);
  return primary?.id || null;
}

// ─── 換 IP（ephemeral public IP 交換） ─────────────────────

/**
 * 刪除臨時公網 IP 並重建（同 private IP），取得新位址。
 * Reserved public IP 一律不動（刪除即是真釋放），以錯誤回絕。
 * @param {(progress: {stage: string, message: string}) => void} [emit] SSE 進度推送
 * @returns {Promise<{ previousIp: string | null, newIp: string, deleted: boolean }>}
 */
export async function rotateEphemeralPublicIp(ctx, { compartmentOcid, vnicId, emit }) {
  const api = request(ctx);

  const privateIpId = await getPrimaryPrivateIpId(ctx, vnicId);
  if (!privateIpId) {
    throw new OciApiError("找不到主要 private IP（VNIC 尚未就緒）", 409);
  }

  emit?.({ stage: "lookup", message: "查詢現有公網 IP…" });
  // getByPrivateIpId：無公網 IP 時 OCI 回 404，屬正常路徑
  let existing = null;
  try {
    existing = await api({
      method: "POST",
      path: "/20160918/publicIps/actions/getByPrivateIpId",
      body: { privateIpId },
    });
  } catch (error) {
    if (!(error instanceof OciApiError && error.statusCode === 404)) {
      throw error;
    }
  }

  let previousIp = null;
  if (existing?.id) {
    previousIp = String(existing.ipAddress || "");
    if (existing.lifetime === "RESERVED") {
      throw new OciApiError(
        `此執行個體使用 Reserved Public IP（${previousIp}）；保留 IP 刪除即真釋放，本操作一律不動作。如需更換請至 OCI 主控台處理。`,
        409,
      );
    }
    emit?.({ stage: "delete", message: `刪除臨時公網 IP ${previousIp}…` });
    await api({ method: "DELETE", path: `/20160918/publicIps/${encodeURIComponent(existing.id)}` });
  }

  emit?.({ stage: "create", message: "配置新的臨時公網 IP…" });
  const created = await api({
    method: "POST",
    path: "/20160918/publicIps",
    body: {
      compartmentId: compartmentOcid,
      lifetime: "EPHEMERAL",
      privateIpId,
    },
  });
  const newIp = String(created?.ipAddress || "");
  if (!newIp) {
    throw new OciApiError("OCI 未回傳新的公網 IP 位址", 502);
  }
  return { previousIp, newIp, deleted: Boolean(existing?.id) };
}

// ─── IPv6 開通 ──────────────────────────────────────────────

/**
 * 自 VCN /56 挑選未使用的 /64 前綴（更新 4 個 hextet 的低字節）。
 * @param {string[]} vcnCidrBlocks VCN 的 ipv6CidrBlocks
 * @param {string[]} usedCidrBlocks 子網既有的 ipv6CidrBlock 清單
 * @returns {string | null} 未使用的 /64（如 2603:c023:8000:100::/64），無 /56 回 null
 */
export function pickSubnetIpv6Cidr(vcnCidrBlocks, usedCidrBlocks) {
  const vcnCidr = (vcnCidrBlocks || []).find(cidr => String(cidr).endsWith("/56"));
  if (!vcnCidr) {
    return null;
  }
  const [addressPart] = vcnCidr.split("/");
  // ::/56 壓縮後 4 個 hextet 的高字節固定；展開成 4 個明確 hextet
  const hextets = expandIpv6Hextets(addressPart);
  if (hextets.length < 4) {
    return null;
  }
  const used = new Set((usedCidrBlocks || []).map(cidr => String(cidr).replace(/\/64$/, "").toLowerCase()));
  const high = hextets[3] & 0xff00;
  for (let low = 0; low <= 0xff; low += 1) {
    const candidate = [...hextets.slice(0, 3), high | low].map(part => part.toString(16).padStart(4, "0"));
    const candidateAddress = `${candidate.slice(0, 4).join(":")}::`;
    if (!used.has(candidateAddress.toLowerCase())) {
      return `${candidateAddress}/64`;
    }
  }
  return null;
}

/** 展開 IPv6 位址的 :: 壓縮為 8 個 hextet（數值）。 */
function expandIpv6Hextets(address) {
  const [head, tail = ""] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
  return parts.map(part => parseInt(part, 16));
}

/**
 * 一鍵開通 IPv6（PLAN §6.3 完整序列，冪等）：
 * VCN /56 → 子網 /64 → IGW ::/0 路由 → 安全清單（§6.4 合併處理）→ VNIC 指派。
 * @param {(progress: {stage: string, message: string}) => void} [emit] SSE 進度推送
 * @returns {Promise<{ ipv6Address: string, warnings: string[] }>}
 */
/**
 * 更換 VNIC 的 IPv6 位址：刪除現有 IPv6 物件 → 重新指派（Oracle 自子網 /64 選新址）。
 * 若 VNIC 尚無任何 IPv6（或子網／VCN 未開通 IPv6），自動走 enableInstanceIpv6
 * 完整開通流程（＝首次指派）。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{ compartmentOcid: string, vnicId: string, vnic?: object, emit?: Function }} options
 * @returns {Promise<{ previousIp: string, newIp: string, opened: boolean, warnings: string[] }>}
 */
export async function rotateInstanceIpv6(ctx, { compartmentOcid, vnicId, vnic, emit }) {
  const api = request(ctx);
  const warnings = [];

  // 列出現有 IPv6 物件
  emit?.({ stage: "list", message: "檢查 VNIC 現有的 IPv6 位址…" });
  const existing = await api({
    method: "GET",
    path: "/20160918/ipv6",
    query: { vnicId },
  });
  const existingV6 = (Array.isArray(existing) ? existing : []).filter(item => item?.id && item?.address);

  if (existingV6.length === 0) {
    // 尚無 IPv6：視同首次開通（冪等六步流程）
    emit?.({ stage: "enable", message: "VNIC 尚無 IPv6，執行完整開通流程…" });
    const result = await enableInstanceIpv6(ctx, { compartmentOcid, vnicId, vnic, emit });
    return {
      previousIp: "",
      newIp: result.ipv6Address,
      opened: true,
      warnings: [...result.warnings, "原先未指派 IPv6，已執行首次開通。"],
    };
  }

  const previousIp = existingV6[0].address;

  // 刪除現有 IPv6 物件（全部刪除後重新指派一個，確保拿到新位址）
  emit?.({ stage: "release", message: `釋放現有 IPv6 位址（${existingV6.length} 個）…` });
  for (const item of existingV6) {
    await api({
      method: "DELETE",
      path: `/20160918/ipv6/${encodeURIComponent(item.id)}`,
    });
  }

  // 重新指派（未指定 ipAddress，Oracle 自子網 /64 選新址）
  emit?.({ stage: "assign", message: "指派新的 IPv6 位址…" });
  const assigned = await api({
    method: "POST",
    path: "/20160918/ipv6",
    body: { vnicId },
  });
  const newIp = String(assigned?.address || "");
  if (!newIp) {
    throw new OciApiError("IPv6 重新指派失敗（OCI 未回傳位址）", 502);
  }

  return { previousIp, newIp, opened: false, warnings };
}

export async function enableInstanceIpv6(ctx, { compartmentOcid, vnicId, vnic, emit }) {
  const api = request(ctx);
  const warnings = [];

  const subnetId = String(vnic?.subnetId || "");
  if (!subnetId) {
    throw new OciApiError("VNIC 缺少 subnet 資訊，無法開通 IPv6", 409);
  }

  // 1. VCN 有無 IPv6 prefix（無則 Oracle 自配 /56 GUA；開了就不能關）
  emit?.({ stage: "vcn", message: "檢查 VCN 的 IPv6 CIDR…" });
  const subnet = await api({ method: "GET", path: `/20160918/subnets/${encodeURIComponent(subnetId)}` });
  const vcnId = String(subnet?.vcnId || "");
  if (!vcnId) {
    throw new OciApiError("子網缺少 vcnId 資訊", 409);
  }
  let vcn = await api({ method: "GET", path: `/20160918/vcns/${encodeURIComponent(vcnId)}` });
  if (!(Array.isArray(vcn?.ipv6CidrBlocks) && vcn.ipv6CidrBlocks.length > 0)) {
    emit?.({ stage: "vcn", message: "VCN 尚無 IPv6，指派 Oracle 提供的 /56 GUA…" });
    await api({
      method: "PUT",
      path: `/20160918/vcns/${encodeURIComponent(vcnId)}`,
      body: { ipv6CidrBlocks: [] },
    });
    vcn = await pollVcnAvailable(api, vcnId);
    warnings.push("IPv6 於 VCN／子網層級開通後即無法關閉。");
  }
  const vcnCidrBlocks = Array.isArray(vcn?.ipv6CidrBlocks) ? vcn.ipv6CidrBlocks : [];

  // 2. 子網有無 /64（無則從 VCN /56 取未用的）
  emit?.({ stage: "subnet", message: "檢查子網的 IPv6 CIDR…" });
  let subnetCidr = String(subnet?.ipv6CidrBlock || "");
  if (!subnetCidr) {
    const existingSubnets = await api({
      method: "GET",
      path: "/20160918/subnets",
      query: { compartmentId: compartmentOcid, vcnId },
    });
    const used = (Array.isArray(existingSubnets) ? existingSubnets : [])
      .map(item => item?.ipv6CidrBlock)
      .filter(Boolean);
    const candidate = pickSubnetIpv6Cidr(vcnCidrBlocks, used);
    if (!candidate) {
      throw new OciApiError("無法從 VCN 的 /56 配出未使用的子網 /64", 502);
    }
    emit?.({ stage: "subnet", message: `為子網指派 ${candidate}…` });
    await api({
      method: "PUT",
      path: `/20160918/subnets/${encodeURIComponent(subnetId)}`,
      body: { ipv6CidrBlock: candidate },
    });
    subnetCidr = candidate;
  }
  const ipv6SubnetCidr = subnetCidr;

  // 3. IGW 存在？私有子網無法公網 IPv6，僅警告略過路由
  emit?.({ stage: "igw", message: "檢查 Internet Gateway…" });
  const gateways = await api({
    method: "GET",
    path: "/20160918/internetGateways",
    query: { compartmentId: compartmentOcid, vcnId },
  });
  const igw = (Array.isArray(gateways) ? gateways : []).find(item => item?.id);
  if (!igw) {
    warnings.push("VCN 沒有 Internet Gateway，已跳過 ::/0 路由；私有子網的 IPv6 無法對外通訊。");
  } else {
    // 4. 路由表 ::/0 → IGW（OCI 是整表覆寫語意，必須先取既有 rules 合併）
    emit?.({ stage: "route", message: "檢查 ::/0 路由規則…" });
    const routeTableId = String(subnet?.routeTableId || "");
    if (routeTableId) {
      const routeTable = await api({ method: "GET", path: `/20160918/routeTables/${encodeURIComponent(routeTableId)}` });
      const rules = Array.isArray(routeTable?.routeRules) ? routeTable.routeRules : [];
      const hasV6Default = rules.some(rule => String(rule?.destination || "") === "::/0");
      if (!hasV6Default) {
        emit?.({ stage: "route", message: "新增 ::/0 → Internet Gateway 路由…" });
        await api({
          method: "PUT",
          path: `/20160918/routeTables/${encodeURIComponent(routeTableId)}`,
          body: {
            routeRules: [
              ...rules,
              { destination: "::/0", destinationType: "CIDR_BLOCK", networkEntityId: igw.id },
            ],
          },
        });
      }
    } else {
      warnings.push("子網未指定路由表，已跳過 ::/0 路由設定。");
    }
  }

  // 5. 安全清單入站 ::/0（與 §6.4 同一呼叫合併處理）
  const { securityListId } = await resolveDefaultSecurityList(api, subnet);
  if (securityListId) {
    const firewallWarnings = await openSecurityList(ctx, { securityListId, emit });
    warnings.push(...firewallWarnings);
  } else {
    warnings.push("找不到子網的安全清單，已跳過雲層防火牆設定。");
  }

  // 6. VNIC 指派 IPv6（Oracle 選址；已有則跳過）
  emit?.({ stage: "assign", message: "為 VNIC 指派 IPv6 位址…" });
  const existingAssignments = await api({
    method: "GET",
    path: "/20160918/ipv6",
    query: { vnicId },
  });
  const existingV6 = Array.isArray(existingAssignments) ? existingAssignments : [];
  let ipv6Address = existingV6.find(item => item?.address)?.address || "";
  if (!ipv6Address) {
    const assigned = await api({
      method: "POST",
      path: "/20160918/ipv6",
      body: { vnicId, ipv6SubnetCidr },
    });
    ipv6Address = String(assigned?.address || "");
  } else {
    warnings.push("VNIC 已有 IPv6 位址，直接沿用。");
  }

  return { ipv6Address, warnings };
}

/** 輪詢 VCN 回到 AVAILABLE（UpdateVcn 為長操作）。 */
async function pollVcnAvailable(api, vcnId, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const vcn = await api({ method: "GET", path: `/20160918/vcns/${encodeURIComponent(vcnId)}` });
    if (String(vcn?.lifecycleState || "") === "AVAILABLE") {
      return vcn;
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new OciApiError("VCN IPv6 指派逾時（等待 AVAILABLE 超時）", 504);
}

// ─── 防火牆（Security List 全開） ───────────────────────────

/** 由子網取得預設安全清單 ID。 */
async function resolveDefaultSecurityList(api, subnet) {
  const securityListId = String(subnet?.defaultSecurityListId
    || (Array.isArray(subnet?.securityListIds) ? subnet.securityListIds[0] : "")
    || "");
  return { securityListId };
}

/**
 * 一鍵開防火牆（PLAN §6.4 雲層）：Security List 全開
 * （TCP／UDP／ICMP，v4+v6 入站；全部協定出站）。冪等合併：已存在相同
 * 規則（同 protocol/source/destination/埠）則跳過；UpdateSecurityList 為
 * 整表覆寫語意，一律以「既有 + 新增」的合併結果送回。
 * @param {(progress: {stage: string, message: string}) => void} [emit] SSE 進度推送
 * @returns {Promise<{ added: string[], warnings: string[] }>}
 */
export async function openSecurityList(ctx, { securityListId, emit }) {
  const api = request(ctx);
  const warnings = [];

  emit?.({ stage: "security-list", message: "讀取安全清單既有規則…" });
  const securityList = await api({
    method: "GET",
    path: `/20160918/securityLists/${encodeURIComponent(securityListId)}`,
  });
  const ingress = Array.isArray(securityList?.ingressSecurityRules) ? securityList.ingressSecurityRules : [];
  const egress = Array.isArray(securityList?.egressSecurityRules) ? securityList.egressSecurityRules : [];

  const ingressRules = [
    { source: "0.0.0.0/0", protocol: "6" },   // TCP 全埠
    { source: "0.0.0.0/0", protocol: "17" },  // UDP 全埠
    { source: "0.0.0.0/0", protocol: "1" },   // ICMPv4
    { source: "::/0", protocol: "6" },
    { source: "::/0", protocol: "17" },
    { source: "::/0", protocol: "58" },       // ICMPv6
  ];
  const egressRules = [
    { destination: "0.0.0.0/0", protocol: "all" },
    { destination: "::/0", protocol: "all" },
  ];

  const existingIngressKeys = new Set(ingress.map(rule => ruleKey(rule)));
  const existingEgressKeys = new Set(egress.map(rule => ruleKey(rule)));
  const mergedIngress = [...ingress];
  const mergedEgress = [...egress];
  const added = [];

  for (const { source, protocol } of ingressRules) {
    const key = `${protocol}|${source}|in`;
    if (existingIngressKeys.has(key)) {
      continue;
    }
    mergedIngress.push({
      protocol,
      source,
      sourceType: "CIDR_BLOCK",
      isStateless: false,
      description: "oci-console: allow all (one-click firewall)",
    });
    existingIngressKeys.add(key);
    added.push(`ingress ${protocol} ← ${source}`);
  }
  for (const { destination, protocol } of egressRules) {
    const key = `${protocol}|${destination}|out`;
    if (existingEgressKeys.has(key)) {
      continue;
    }
    mergedEgress.push({
      protocol,
      destination,
      destinationType: "CIDR_BLOCK",
      isStateless: false,
      description: "oci-console: allow all (one-click firewall)",
    });
    existingEgressKeys.add(key);
    added.push(`egress ${protocol} → ${destination}`);
  }

  if (added.length === 0) {
    emit?.({ stage: "security-list", message: "安全清單已全開，無需變更。" });
    return { added, warnings };
  }

  emit?.({ stage: "security-list", message: `送出 ${added.length} 條新規則…` });
  await api({
    method: "PUT",
    path: `/20160918/securityLists/${encodeURIComponent(securityListId)}`,
    body: {
      ingressSecurityRules: mergedIngress,
      egressSecurityRules: mergedEgress,
    },
  });
  warnings.push(
    "雲層防火牆已全開；OCI 的 Ubuntu／Oracle Linux 映像出廠即在 iptables 擋掉 22 以外的埠，"
    + "其他埠仍不通時請於主機執行 iptables 清理（見完成畫面說明）。",
  );
  return { added, warnings };
}

/** 規則比對鍵：(protocol, source/destination, 埠範圍/ICMP 選項)。 */
function ruleKey(rule) {
  const direction = rule?.source !== undefined ? "in" : "out";
  const endpoint = String(rule?.source ?? rule?.destination ?? "");
  const tcp = rule?.tcpOptions?.destinationPortRange;
  const ports = tcp ? `ports:${tcp.min ?? 0}-${tcp.max ?? 65535}` : "";
  const icmp = rule?.icmpOptions ? `icmp:${rule.icmpOptions.type ?? "*"}:${rule.icmpOptions.code ?? "*"}` : "";
  return `${String(rule?.protocol || "")}|${endpoint}|${direction}|${ports}|${icmp}`;
}

// ─── 保留公網 IP（Reserved Public IP，Phase 2）───────────────

/**
 * 列出 Compartment 內的保留公網 IP 清單。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{ compartmentOcid?: string }} [options]
 */
export async function listReservedPublicIps(ctx, options = {}) {
  const api = request(ctx);
  const compartmentId = options.compartmentOcid || ctx.account.compartmentOcid;
  const items = await api({
    method: "GET",
    path: "/20160918/publicIps",
    query: {
      scope: "REGION",
      compartmentId,
      lifetime: "RESERVED",
    },
  });
  return Array.isArray(items) ? items : [];
}

/**
 * 建立（申請）新的保留公網 IP。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{ compartmentOcid?: string, displayName?: string, privateIpId?: string }} [options]
 */
export async function createReservedPublicIp(ctx, options = {}) {
  const api = request(ctx);
  const compartmentId = options.compartmentOcid || ctx.account.compartmentOcid;
  const body = {
    compartmentId,
    lifetime: "RESERVED",
  };
  if (options.displayName) {
    body.displayName = options.displayName;
  }
  if (options.privateIpId) {
    body.privateIpId = options.privateIpId;
  }
  return api({
    method: "POST",
    path: "/20160918/publicIps",
    body,
  });
}

/**
 * 更新保留公網 IP（綁定 privateIpId 或解綁傳空字串）。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {string} publicIpId
 * @param {{ privateIpId?: string, displayName?: string }} [options]
 */
export async function updateReservedPublicIp(ctx, publicIpId, options = {}) {
  const api = request(ctx);
  const body = {};
  if (options.privateIpId !== undefined) {
    body.privateIpId = options.privateIpId || "";
  }
  if (options.displayName !== undefined) {
    body.displayName = options.displayName;
  }
  return api({
    method: "PUT",
    path: `/20160918/publicIps/${encodeURIComponent(publicIpId)}`,
    body,
  });
}

/**
 * 刪除（釋放）保留公網 IP。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {string} publicIpId
 */
export async function deleteReservedPublicIp(ctx, publicIpId) {
  const api = request(ctx);
  return api({
    method: "DELETE",
    path: `/20160918/publicIps/${encodeURIComponent(publicIpId)}`,
  });
}
