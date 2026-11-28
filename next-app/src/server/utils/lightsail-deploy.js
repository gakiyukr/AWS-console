// Lightsail 部署業務邏輯：建立 Lightsail 執行個體並等待就緒。
// 與 EC2 部署（wavelength.js）相比，Lightsail 流程更簡化：
//   - 無需管理 VPC、Subnet、Security Group（Lightsail 自動建立）
//   - 使用 Blueprint（作業系統映像）與 Bundle（規格方案）
//   - 內建靜態 IP 分配與防火牆規則管理
import { AwsRequestError, lightsailQuery } from "./aws-lightsail.js";
import { bytesToBase64 } from "./bytes.js";
import { listEc2Regions, resolveDeployCredential } from "./wavelength.js";

/** @typedef {(stage: string, details?: Record<string, unknown>) => void} ProgressReporter */

const POLL_ATTEMPTS = 60;
const POLL_DELAY_MS = 5000;

class LightsailError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LightsailError";
    this.statusCode = details.statusCode || 400;
  }
}

/**
 * 取得 Lightsail 可用 Region 清單。
 */
export async function listLightsailRegions(awsEnv) {
  // 1. Lightsail GetRegions 可從任意 region 呼叫，使用 us-east-1 作為預設端點
  const response = await lightsailQuery("us-east-1", awsEnv, "GetRegions", {});
  const lightsailRegions = (response.regions || []).map((region) => region.name).filter(Boolean);

  // 2. 交叉過濾帳號實際已開通的 Region（排除 not-opted-in 區域）
  try {
    const enabledRegions = await listEc2Regions(awsEnv);
    if (Array.isArray(enabledRegions) && enabledRegions.length > 0) {
      const enabledSet = new Set(enabledRegions);
      return lightsailRegions.filter((r) => enabledSet.has(r));
    }
  } catch {
    // 若 EC2 DescribeRegions 查詢失敗，退回原始清單
  }
  return lightsailRegions;
}

/**
 * 取得指定 Region 的 Lightsail 方案（Bundle）。
 */
export async function listLightsailBundles(awsEnv, region) {
  const response = await lightsailQuery(region, awsEnv, "GetBundles", {});
  return (response.bundles || []).map((bundle) => ({
    bundleId: bundle.bundleId,
    name: bundle.name,
    price: bundle.price,
    cpuCount: bundle.cpuCount,
    ramSizeInGb: bundle.ramSizeInGb,
    diskSizeInGb: bundle.diskSizeInGb,
    transferPerMonthInGb: bundle.transferPerMonthInGb,
    supportedPlatforms: bundle.supportedPlatforms || [],
  }));
}

/**
 * 取得指定 Region 的 Lightsail Blueprint（作業系統映像）。
 */
export async function listLightsailBlueprints(awsEnv, region) {
  const response = await lightsailQuery(region, awsEnv, "GetBlueprints", {});
  return (response.blueprints || [])
    .filter((bp) => bp.type === "os" && bp.isActive !== false) // 僅現行的作業系統版本；GetBlueprints 會一併回傳停售的舊版（isActive: false）
    .map((bp) => ({
      blueprintId: bp.blueprintId,
      // name 是泛名（如 "Ubuntu"），版本資訊在 versionTitle；缺漏時以 name+version 兜底
      name: bp.versionTitle || [bp.name, bp.version].filter(Boolean).join(" "),
      description: bp.description,
      platform: bp.platform,
      group: bp.group,
    }));
}

/**
 * 輪詢等待 Lightsail 執行個體進入 running 狀態。
 */
async function waitForInstanceRunning(awsEnv, region, instanceName, onProgress) {
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));

    const response = await lightsailQuery(region, awsEnv, "GetInstance", {
      instanceName,
    });

    const instance = response.instance;
    const state = instance?.state?.name || "unknown";

    onProgress("waiting_for_running", {
      attempt,
      maxAttempts: POLL_ATTEMPTS,
      currentState: state,
    });

    if (state === "running") {
      return instance;
    }

    if (state === "terminated" || state === "terminating") {
      throw new LightsailError("執行個體已終止，無法繼續等待。", { statusCode: 400 });
    }
  }

  throw new LightsailError(
    `等待執行個體進入 running 狀態逾時（已嘗試 ${POLL_ATTEMPTS} 次）。`,
    { statusCode: 504 },
  );
}

/**
 * 將傳入的憑證物件正規化並以共用規則驗證（相容 keys 陣列與單一 publicKey 欄位）。
 * @param {object} rawCredential
 * @returns {{ type: "ssh_key", keys: string[] } | { type: "password", password: string }}
 */
function normalizeLightsailCredential(rawCredential) {
  const input = rawCredential && typeof rawCredential === "object" ? rawCredential : {};
  const normalized = input.type === "ssh_key" && !Array.isArray(input.keys) && typeof input.publicKey === "string"
    ? { type: "ssh_key", keys: [input.publicKey] }
    : input;
  return resolveDeployCredential({ credential: normalized });
}

/**
 * 產生 Lightsail 啟動腳本（明文 shell script）：設定 root 登入憑證。
 * 依據 AWS Lightsail CreateInstances API 規範，userData 為明文字串（不可 Base64 包裝）；
 * 內部將公鑰與密碼以 Base64 輸送再解碼，完全杜絕單引號、反斜線或 shell 變數展開注入。
 */
export function generateCloudInitUserData(rawCredential) {
  const credential = normalizeLightsailCredential(rawCredential);
  const lines = ["#!/bin/bash", "set -e"];

  if (credential.type === "ssh_key") {
    const keysPayload = bytesToBase64(new TextEncoder().encode(`${credential.keys.join("\n")}\n`));
    lines.push(
      "mkdir -p /root/.ssh",
      "chmod 700 /root/.ssh",
      `printf '%s' '${keysPayload}' | base64 -d >> /root/.ssh/authorized_keys`,
      "chmod 600 /root/.ssh/authorized_keys",
      "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config",
      "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
      "if [ -d /etc/ssh/sshd_config.d ]; then printf 'PermitRootLogin prohibit-password\\nPasswordAuthentication no\\n' > /etc/ssh/sshd_config.d/99-console-auth.conf; fi",
      "systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || service ssh reload 2>/dev/null || true",
    );
  } else {
    const chpasswdPayload = bytesToBase64(new TextEncoder().encode(`root:${credential.password}\n`));
    lines.push(
      `printf '%s' '${chpasswdPayload}' | base64 -d | chpasswd`,
      "passwd -u root 2>/dev/null || true",
      "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config",
      "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config",
      "if [ -d /etc/ssh/sshd_config.d ]; then printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/99-console-auth.conf; fi",
      "systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || service sshd restart 2>/dev/null || service ssh restart 2>/dev/null || true",
    );
  }

  return lines.join("\n");
}

/**
 * 部署 Lightsail 執行個體。
 * @param {object} awsEnv AWS 憑證環境
 * @param {object} body 部署請求參數
 * @param {ProgressReporter} onProgress 進度回報函式
 * @returns {Promise<object>} 部署結果
 */
export async function deployLightsailInstance(awsEnv, body, onProgress) {
  const { region, blueprint_id, bundle_id, instance_name } = body;
  const credential = normalizeLightsailCredential(body?.credential);
  // 選用旗標：沿用寬鬆解析（JSON 布林或字串），不進路由欄位白名單
  const isIpv6Enabled = body?.ipv6 === true || body?.ipv6 === "true";

  onProgress("validating", { region, blueprintId: blueprint_id, bundleId: bundle_id });

  // 產生明文啟動腳本（AWS Lightsail CreateInstances 的 userData 必須為明文字串）
  const userData = generateCloudInitUserData(credential);

  // 建立執行個體
  onProgress("launching_instance", { instanceName: instance_name });

  try {
    await lightsailQuery(region, awsEnv, "CreateInstances", {
      instanceNames: [instance_name],
      availabilityZone: `${region}a`, // 預設使用第一個 AZ
      blueprintId: blueprint_id,
      bundleId: bundle_id,
      userData,
      // ipAddressType：ipv4 或 dualstack（IPv6）；由部署表單的 IPv6 選項決定
      ipAddressType: isIpv6Enabled ? "dualstack" : "ipv4",
      tags: [
        { key: "ManagedBy", value: "aws-console-lightsail" },
        { key: "DeployedAt", value: new Date().toISOString() },
      ],
    });
  } catch (error) {
    if (error instanceof AwsRequestError) {
      throw new LightsailError(error.message, { statusCode: error.statusCode });
    }
    throw error;
  }

  onProgress("instance_launched", { instanceName: instance_name });

  // 等待執行個體進入 running
  const instance = await waitForInstanceRunning(awsEnv, region, instance_name, onProgress);
  let publicIpAddress = String(instance.publicIpAddress || "");

  onProgress("instance_running", {
    instanceName: instance_name,
    publicIpAddress,
  });

  // 分配靜態 IP（Lightsail 的靜態 IP 可在執行個體關機後保留）
  let staticIp = null;
  const staticIpName = `${instance_name}-static-ip`;

  try {
    onProgress("allocating_static_ip", { staticIpName });

    const allocateResponse = await lightsailQuery(region, awsEnv, "AllocateStaticIp", {
      staticIpName,
    });

    staticIp = allocateResponse.operations?.[0]?.resourceName || staticIpName;

    // 等待靜態 IP 就緒後附加到執行個體
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await lightsailQuery(region, awsEnv, "AttachStaticIp", {
      staticIpName,
      instanceName: instance_name,
    });

    // 附加靜態 IP 後，執行個體對外 IP 已變更為靜態 IP，必須重新查詢取得新位址
    const probe = await lightsailQuery(region, awsEnv, "GetStaticIp", { staticIpName });
    const attachedIp = String(probe?.staticIp?.ipAddress || "");
    if (attachedIp) {
      publicIpAddress = attachedIp;
    }

    onProgress("static_ip_attached", { staticIpName, staticIpAddress: publicIpAddress });
  } catch (error) {
    // 靜態 IP 分配失敗不中斷流程，使用動態 IP
    onProgress("static_ip_skipped", {
      reason: error.message,
      usingDynamicIp: true,
    });
  }

  // 開啟預設防火牆規則（SSH）
  try {
    await lightsailQuery(region, awsEnv, "PutInstancePublicPorts", {
      instanceName: instance_name,
      portInfos: [
        {
          fromPort: 22,
          toPort: 22,
          protocol: "tcp",
        },
      ],
    });
    onProgress("firewall_configured", { port: 22 });
  } catch (error) {
    // 防火牆規則設定失敗不中斷流程
    onProgress("firewall_skipped", { reason: error.message });
  }

  // 回傳部署結果
  const ipv6Addresses = Array.isArray(instance.ipv6Addresses) ? instance.ipv6Addresses : [];
  return {
    success: true,
    instance_id: instance.name, // Lightsail 使用 name 作為識別
    instance_name: instance.name,
    region,
    blueprint_id,
    bundle_id,
    public_ip_address: publicIpAddress,
    ipv6_address: ipv6Addresses[0] || "",
    ip_address_type: instance.ipAddressType || (isIpv6Enabled ? "dualstack" : "ipv4"),
    static_ip_name: staticIp,
    username: "root",
    credential_type: credential.type,
    password: credential.type === "password" ? credential.password : "",
    ready: true,
  };
}
