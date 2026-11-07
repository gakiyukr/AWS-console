// DDNS（Cloudflare）整合：多域名管理、「前綴 → 機器」綁定與 A 記錄同步。
// 綁定與域名於設定後臺集中管理；觸發點：換 IP 成功、start/stop/reboot 成功、
// 分享頁 rotate。所有 CF 呼叫經 fetchImpl 參數（預設全域 fetch），
// 可注入 stub 做單元測試。
import { ec2Query } from "./aws-query.js";
import { parseInstanceDescription } from "./ec2-xml.js";
import { deriveIpFromPublicDns } from "./power.js";
import { decryptDdnsToken, encryptDdnsToken } from "./credential-crypto.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
// DDNS 用途需要 SSH 直連，必須 DNS-only；60 秒讓換 IP 後盡快生效
const DNS_TTL = 60;

/**
 * 驗證前綴格式：小寫字母數字連字號與點（允許多級子域），不含 zone 尾。
 * @param {string} prefix
 * @returns {boolean}
 */
export function isValidDdnsPrefix(prefix) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(prefix);
}

/** 由前綴與 zone 組出完整 FQDN。 */
export function buildFqdn(prefix, zoneName) {
  return `${prefix}.${zoneName}`;
}

// ─── 域名管理 ──────────────────────────────────────────────

/**
 * 列出全部已登錄域名（Token 僅 hint，不出伺服器）。
 * @param {D1Database} db
 * @returns {Promise<Array<{ id:number, zoneName:string, zoneId:string, tokenHint:string, createdAt:string }>>}
 */
export async function listDdnsDomains(db) {
  const { results } = await db
    .prepare("SELECT id, zone_name AS zoneName, zone_id AS zoneId, token_hint AS tokenHint, created_at AS createdAt FROM ddns_domains ORDER BY id")
    .all();
  return results;
}

/** 儲存域名（Token 加密；呼叫端須先以 verifyCloudflareToken 驗證）。 */
export async function createDdnsDomain(db, encryptionKey, { token, zoneId, zoneName }) {
  const encrypted = await encryptDdnsToken(token, encryptionKey);
  try {
    const result = await db
      .prepare(`INSERT INTO ddns_domains (zone_name, zone_id, token_ciphertext, token_iv, token_hint)
        VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(zoneName, zoneId, encrypted.clientSecretCiphertext, encrypted.clientSecretIv, token.slice(-4))
      .run();
    return { id: result.meta.last_row_id };
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      return null; // zone 已存在 → 409
    }
    throw error;
  }
}

/** 更新域名的 Token（zone 不變）。 */
export async function updateDdnsDomainToken(db, encryptionKey, domainId, token) {
  const encrypted = await encryptDdnsToken(token, encryptionKey);
  const result = await db
    .prepare(`UPDATE ddns_domains SET token_ciphertext = ?1, token_iv = ?2, token_hint = ?3, updated_at = datetime('now')
      WHERE id = ?4`)
    .bind(encrypted.clientSecretCiphertext, encrypted.clientSecretIv, token.slice(-4), domainId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 刪除域名（CASCADE 清除其綁定）。 */
export async function deleteDdnsDomain(db, domainId) {
  const result = await db.prepare("DELETE FROM ddns_domains WHERE id = ?1").bind(domainId).run();
  return (result.meta.changes ?? 0) > 0;
}

/** 取得單一域名的解密 Token；不存在回 null。 */
async function getDomainToken(db, domainId, encryptionKey) {
  const row = await db
    .prepare("SELECT token_ciphertext AS tokenCiphertext, token_iv AS tokenIv, zone_name AS zoneName, zone_id AS zoneId FROM ddns_domains WHERE id = ?1")
    .bind(domainId)
    .first();
  if (!row) {
    return null;
  }
  const token = await decryptDdnsToken(row, encryptionKey);
  return { token, zoneId: row.zoneId, zoneName: row.zoneName };
}

// ─── 前綴綁定 ──────────────────────────────────────────────

/**
 * 列出前綴綁定（可依機器過濾），含 FQDN 與機器顯示資訊。
 * @param {D1Database} db
 * @param {{ machineId?: number }} [options]
 * @returns {Promise<Array<{ id:number, domainId:number, zoneName:string, prefix:string,
 *   fqdn:string, machineId:number, machineName:string, recordId:string|null }>>}
 */
/** @returns {Promise<Array<{ id:number, domainId:number, zoneName:string, prefix:string,
 *   fqdn:string, machineId:number, machineName:string, machineInstanceId:string,
 *   recordId:string|null }>>} */
export async function listDdnsBindings(db, options = {}) {
  const base = `SELECT b.id, b.domain_id AS domainId, d.zone_name AS zoneName,
      b.prefix, b.machine_id AS machineId, m.name AS machineName,
      m.instance_id AS machineInstanceId, b.record_id AS recordId
    FROM ddns_bindings b
    JOIN ddns_domains d ON d.id = b.domain_id
    JOIN machines m ON m.id = b.machine_id`;
  const statement = options.machineId
    ? db.prepare(`${base} WHERE b.machine_id = ?1 ORDER BY b.id`).bind(options.machineId)
    : db.prepare(`${base} ORDER BY b.id`);
  const { results } = await statement.all();
  return results.map(row => ({
    ...row,
    fqdn: buildFqdn(row.prefix, row.zoneName),
  }));
}

/** 建立前綴綁定；(domain, prefix) 撞 UNIQUE 回 null（呼叫端回 409）。 */
export async function createDdnsBinding(db, { domainId, prefix, machineId }) {
  try {
    const result = await db
      .prepare("INSERT INTO ddns_bindings (domain_id, prefix, machine_id) VALUES (?1, ?2, ?3)")
      .bind(domainId, prefix, machineId)
      .run();
    return { id: result.meta.last_row_id };
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      return null;
    }
    throw error;
  }
}

/** 刪除前綴綁定（CF 記錄保留不刪）。 */
export async function deleteDdnsBinding(db, bindingId) {
  const result = await db.prepare("DELETE FROM ddns_bindings WHERE id = ?1").bind(bindingId).run();
  return (result.meta.changes ?? 0) > 0;
}

// ─── 同步 ──────────────────────────────────────────────────

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

/**
 * 同步單一機器的全部 DDNS 綁定至目前公網 IP。
 * 冪等：先查公網 IP 與既有記錄，無變化就不打寫入 API。
 * @param {object} awsEnv 已注入 AWS 憑證的執行環境
 * @param {D1Database} db
 * @param {{ id:number, region:string, instanceId:string, platform:string, isWavelength:boolean }} machine
 * @param {{ fetchImpl?: typeof fetch, knownIp?: string | null }} [opts]
 * @returns {Promise<{ results: Array<{ fqdn:string, status:"created"|"match"|"updated" }>,
 *   skipped?: boolean, reason?: string }>}
 */
export async function syncMachineDdns(awsEnv, db, machine, { fetchImpl = fetch, knownIp = null } = {}) {
  if (machine.platform !== "ec2" || machine.isWavelength) {
    return { results: [], skipped: true, reason: "Wavelength／Lightsail 機器不支援 DDNS" };
  }
  const bindings = await listDdnsBindings(db, { machineId: machine.id });
  if (bindings.length === 0) {
    return { results: [], skipped: true, reason: "此機器未綁定任何 DDNS 前綴" };
  }

  let ip = knownIp;
  if (!ip) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const instance = parseInstanceDescription(
        await ec2Query(machine.region, awsEnv, "DescribeInstances", {
          "InstanceId.1": machine.instanceId,
        }),
      );
      if (!instance.instanceId) {
        return { results: [], skipped: true, reason: "找不到執行個體" };
      }
      ip = instance.publicIpAddress || deriveIpFromPublicDns(instance.publicDnsName);
      if (ip) {
        break;
      }
    }
  }

  if (!ip) {
    return { results: [], skipped: true, reason: "執行個體目前沒有公網 IPv4" };
  }

  // 依域名分組取 token（同一域名多綁定只解密一次）
  const tokenCache = new Map();
  const results = [];
  for (const binding of bindings) {
    let domain;
    if (tokenCache.has(binding.domainId)) {
      domain = tokenCache.get(binding.domainId);
    } else {
      domain = await getDomainToken(db, binding.domainId, awsEnv.CREDENTIAL_ENCRYPTION_KEY);
      tokenCache.set(binding.domainId, domain);
    }
    if (!domain) {
      results.push({ fqdn: binding.fqdn, status: "skipped", reason: "域名設定遺失" });
      continue;
    }

    const fqdn = buildFqdn(binding.prefix, domain.zoneName);
    const existing = await cfRequest(fetchImpl, domain.token,
      `/zones/${domain.zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`, {});
    const record = existing[0];

    if (record && record.content === ip) {
      if (binding.recordId !== record.id) {
        await db.prepare("UPDATE ddns_bindings SET record_id = ?1 WHERE id = ?2").bind(record.id, binding.id).run();
      }
      results.push({ fqdn, status: "match", ip });
      continue;
    }

    let recordId;
    if (record) {
      await cfRequest(fetchImpl, domain.token,
        `/zones/${domain.zoneId}/dns_records/${record.id}`, {
          method: "PATCH",
          body: JSON.stringify({ content: ip }),
        });
      recordId = record.id;
    } else {
      const created = await cfRequest(fetchImpl, domain.token,
        `/zones/${domain.zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify({
            type: "A",
            name: fqdn,
            content: ip,
            ttl: DNS_TTL,
            proxied: false, // SSH 直連必須 DNS-only
          }),
        });
      recordId = created.id;
    }

    await db.prepare("UPDATE ddns_bindings SET record_id = ?1 WHERE id = ?2").bind(recordId, binding.id).run();
    results.push({ fqdn, status: record ? "updated" : "created", ip });
  }

  return { results, skipped: false };
}

/**
 * 驗證 CF Token 是否能存取指定 zone（需 Zone.DNS Edit）。
 * @returns {Promise<string | null>} zone id；Token 無效或 zone 不存在回 null
 */
export async function verifyCloudflareToken(token, zoneName, fetchImpl = fetch) {
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
