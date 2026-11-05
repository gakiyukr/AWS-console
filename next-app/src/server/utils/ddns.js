// DDNS（Cloudflare）整合：設定存取、Token 驗證與機器 A 記錄同步。
// 觸發點：換 IP 成功、start/stop/reboot 成功、機器 DDNS 對話框手動同步。
// 所有 CF 呼叫經 fetchImpl 參數（預設全域 fetch），可注入 stub 做單元測試。
import { ec2Query } from "./aws-query.js";
import { parseInstanceDescription } from "./ec2-xml.js";
import { deriveIpFromPublicDns } from "./power.js";
import { decryptDdnsToken, encryptDdnsToken } from "./credential-crypto.js";
import { setMachineDdns } from "./db.js";
import { outboundFetch } from "./proxy.js";
import { getEnv } from "@/server/env";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
// DDNS 用途需要 SSH 直連，必須 DNS-only；60 秒讓換 IP 後盡快生效
const DNS_TTL = 60;

function delay(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

/** 讀取 DDNS 設定並解密 Token；未設定回 null。 */
export async function getDdnsSettings(db, encryptionKey) {
  const row = await db
    .prepare("SELECT token_ciphertext AS tokenCiphertext, token_iv AS tokenIv, token_hint AS tokenHint, zone_id AS zoneId, zone_name AS zoneName FROM ddns_settings WHERE id = 1")
    .first();
  if (!row) {
    return null;
  }
  const token = await decryptDdnsToken(row, encryptionKey);
  return { token, zoneId: row.zoneId, zoneName: row.zoneName, tokenHint: row.tokenHint };
}

/** 儲存 DDNS 設定（Token 加密；呼叫端須先驗證 Token 可用）。 */
export async function saveDdnsSettings(db, encryptionKey, { token, zoneId, zoneName }) {
  const encrypted = await encryptDdnsToken(token, encryptionKey);
  await db
    .prepare(`INSERT INTO ddns_settings (id, token_ciphertext, token_iv, token_hint, zone_id, zone_name)
      VALUES (1, ?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        token_ciphertext = ?1, token_iv = ?2, token_hint = ?3,
        zone_id = ?4, zone_name = ?5, updated_at = datetime('now')`)
    .bind(encrypted.clientSecretCiphertext, encrypted.clientSecretIv, token.slice(-4), zoneId, zoneName)
    .run();
}

/** 清除 DDNS 設定。回傳是否確實刪除。 */
export async function clearDdnsSettings(db) {
  const result = await db.prepare("DELETE FROM ddns_settings WHERE id = 1").run();
  return (result.meta.changes ?? 0) > 0;
}

async function defaultFetch(url, init) {
  const env = await getEnv().catch(() => null);
  return outboundFetch(url, init, env);
}

/**
 * 驗證 CF Token 是否能存取指定 zone（需 Zone.DNS Edit）。
 * @returns {Promise<string | null>} zone id；Token 無效或 zone 不存在回 null
 */
export async function verifyCloudflareToken(token, zoneName, fetchImpl = defaultFetch) {
  const response = await fetchImpl(
    `${CF_API_BASE}/zones?name=${encodeURIComponent(zoneName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const payload = await response.json().catch(() => null);
  if (!payload?.success) {
    return null;
  }
  return payload.result?.find(zone => zone.name.toLowerCase() === zoneName.toLowerCase())?.id || null;
}

/** 統一呼叫 CF API：檢查 v4 success 旗標，失敗時拋出帶 errors 摘要的錯誤。 */
async function cfRequest(fetchImpl, token, path, init) {
  const response = await fetchImpl(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!payload?.success) {
    const detail = (payload?.errors || []).map(error => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API 錯誤：${detail}`);
  }
  return payload.result;
}

/** 驗證 hostname 為 zone 的子網域（避免把記錄開到設定的 zone 之外）。 */
export function isHostnameInZone(hostname, zoneName) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const zone = String(zoneName || "").toLowerCase();
  return host === zone || host.endsWith(`.${zone}`);
}

/**
 * 同步單一機器的 DNS A 記錄至目前公網 IP。
 * 冪等：先查公網 IP 與既有記錄，無變化就不打寫入 API。
 * @param {object} awsEnv 已注入 AWS 憑證的執行環境
 * @param {D1Database} db
 * @param {{ id:number, region:string, instanceId:string, platform:string, isWavelength:boolean,
 *   ddnsHostname:string|null }} machine
 * @param {{ fetchImpl?: typeof fetch, knownIp?: string | null }} [opts]
 * @returns {Promise<{ status: "created"|"match"|"updated"|"skipped", ip?: string, hostname?: string, reason?: string }>}
 */
export async function syncMachineDdns(awsEnv, db, machine, { fetchImpl = defaultFetch, knownIp = null } = {}) {
  if (machine.platform !== "ec2" || machine.isWavelength) {
    return { status: "skipped", reason: "Wavelength／Lightsail 機器不支援 DDNS" };
  }
  const settings = await getDdnsSettings(db, awsEnv.CREDENTIAL_ENCRYPTION_KEY);
  if (!settings) {
    return { status: "skipped", reason: "尚未設定 Cloudflare DDNS" };
  }
  const hostname = machine.ddnsHostname;
  if (!hostname) {
    return { status: "skipped", reason: "此機器未綁定 DDNS 主機名" };
  }

  let ip = knownIp;
  if (!ip) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        await delay(2000);
      }
      const instance = parseInstanceDescription(
        await ec2Query(machine.region, awsEnv, "DescribeInstances", {
          "InstanceId.1": machine.instanceId,
        }),
      );
      if (!instance.instanceId) {
        return { status: "skipped", reason: "找不到執行個體" };
      }
      ip = instance.publicIpAddress || deriveIpFromPublicDns(instance.publicDnsName);
      if (ip) {
        break;
      }
    }
  }

  if (!ip) {
    return { status: "skipped", reason: "執行個體目前沒有公網 IPv4" };
  }

  const existing = await cfRequest(fetchImpl, settings.token,
    `/zones/${settings.zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}`, {});
  const record = existing[0];

  if (record && record.content === ip) {
    // 記錄已符合；補記 recordId 供後續更新免重查
    if (machine.ddnsRecordId !== record.id) {
      await setMachineDdns(db, machine.id, hostname, record.id);
    }
    return { status: "match", ip, hostname };
  }

  let recordId;
  if (record) {
    await cfRequest(fetchImpl, settings.token,
      `/zones/${settings.zoneId}/dns_records/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: ip }),
      });
    recordId = record.id;
  } else {
    const created = await cfRequest(fetchImpl, settings.token,
      `/zones/${settings.zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "A",
          name: hostname,
          content: ip,
          ttl: DNS_TTL,
          proxied: false, // SSH 直連必須 DNS-only
        }),
      });
    recordId = created.id;
  }

  await setMachineDdns(db, machine.id, hostname, recordId);
  return { status: record ? "updated" : "created", ip, hostname };
}
