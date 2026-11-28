// GET /api/instances：OCI 執行個體清單。
// 預設讀 D1 快取（oci_instance_cache，migration 0022），不打 OCI API；
// ?refresh=1 才即時呼叫 ListInstances（多區域並行）並整批回寫快取。
// 回應附 cachedAt（快取同步時間）與 cached 旗標，供前端顯示。
// region 參數：指定時只查該區域；未指定時查帳號所有已訂閱 READY 區域。
// 即時查詢時的單台 IP 補齊：每台 2 個子請求（ListVnicAttachments + GetVnic），
// 受 Workers 單請求 50 個子請求上限約束，故限制單次同步的機器數。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listInstances } from "@/server/utils/oci-compute.js";
import { getPrimaryVnic } from "@/server/utils/oci-network.js";
import { getAllInstanceAliases } from "@/server/utils/instance-aliases.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import {
  getOciInstancesCacheTime,
  listCachedOciInstances,
  listCachedOciRegions,
  replaceCachedOciInstances,
} from "@/server/utils/db.js";
import { readyOciRegions } from "@/server/utils/oci-regions.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_SYNC_INSTANCES = 20;

type CachedRow = {
  id: string
  displayName: string
  lifecycleState: string
  shape: string
  region: string
  availabilityDomain: string
  timeCreated: string | null
  publicIp: string | null
  ipv6Address: string | null
  cachedAt?: string
};

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";
  const regionParam = query.get("region") || "";
  const forceRefresh = query.get("refresh") === "1";
  if (accountId) {
    const validation = validateInput(accountId, undefined, "account_id");
    if (!validation.valid || !/^\d+$/.test(accountId)) {
      return errorResponse(400, "account_id 參數無效");
    }
  }

  const database = env.DB as D1Database;

  try {
    // 先解析帳號取得 id（同時驗證憑證設定與 regionParam 形狀，防 SSRF）；不觸發任何 OCI API。
    const { account, ociAccount: defaultOciAccount, privateKeyPem } = await resolveOciAccount(
      env,
      accountId || undefined,
      { region: regionParam || undefined },
    );
    const resolvedAccountId = Number(account.id);
    const aliasMap = await getAllInstanceAliases(database) as Record<string, { alias: string, notes: string }>;

    // 讀快取模式（預設）
    if (!forceRefresh) {
      const cachedAt = await getOciInstancesCacheTime(database, resolvedAccountId);
      // 快取為空（首次使用或新帳號）：自動同步一次
      if (cachedAt === null) {
        return await syncInstances({
          database,
          accountId: resolvedAccountId,
          defaultOciAccount,
          privateKeyPem,
          regionParam,
          aliasMap,
          triggeredBy: "empty-cache",
        });
      }
      const rows = await listCachedOciInstances(database, resolvedAccountId, { region: regionParam || undefined }) as CachedRow[];
      return jsonResponse({
        instances: attachAliases(rows, aliasMap),
        nextPage: null,
        region: regionParam || defaultOciAccount.region,
        cached: true,
        cachedAt,
      });
    }

    return await syncInstances({
      database,
      accountId: resolvedAccountId,
      defaultOciAccount,
      privateKeyPem,
      regionParam,
      aliasMap,
      triggeredBy: "manual",
    });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}

/** 為快取列補上 alias／notes（DB 內的使用者標記）。 */
function attachAliases(rows: CachedRow[], aliasMap: Record<string, { alias: string, notes: string }>) {
  return rows.map(row => ({
    ...row,
    alias: aliasMap[row.id]?.alias || null,
    notes: aliasMap[row.id]?.notes || null,
  }));
}

/** 即時同步：多區域並行 ListInstances → 補 IP → 整批回寫快取。 */
async function syncInstances({
  database,
  accountId,
  defaultOciAccount,
  privateKeyPem,
  regionParam,
  aliasMap,
  triggeredBy,
}: {
  database: D1Database
  accountId: number
  defaultOciAccount: { id: number, region: string, compartmentOcid: string }
  privateKeyPem: string
  regionParam: string
  aliasMap: Record<string, { alias: string, notes: string }>
  triggeredBy: string
}) {
  let regions: string[];
  if (regionParam) {
    regions = [regionParam];
  } else {
    const cached = readyOciRegions(await listCachedOciRegions(database, accountId)).map(item => item.region);
    regions = cached.length > 0 ? cached : [defaultOciAccount.region];
  }

  const settled = await Promise.allSettled(regions.map(async (region) => {
    const ctx = { account: { ...defaultOciAccount, region }, privateKeyPem };
    const result = await listInstances(ctx, { page: null });
    return { region, ctx, items: result.items as Array<Record<string, unknown>> };
  }));

  const warnings: string[] = [];
  const merged: Array<{ instance: Record<string, unknown>, region: string, ctx: { account: { compartmentOcid: string, id: number }, privateKeyPem: string } }> = [];
  let firstError: unknown = null;
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      for (const instance of outcome.value.items) {
        merged.push({ instance, region: outcome.value.region, ctx: outcome.value.ctx as never });
      }
    } else {
      firstError ??= outcome.reason;
      warnings.push(`區域 ${regions[index]} 清單取得失敗：${ociFailureMessage(outcome.reason)}`);
    }
  });

  // 全部區域都失敗時，把第一個錯誤往上拋（讓前端看到明確原因）
  if (merged.length === 0 && firstError) {
    throw firstError;
  }

  merged.sort((a, b) => String(b.instance?.timeCreated || "").localeCompare(String(a.instance?.timeCreated || "")));
  const limited = merged.slice(0, MAX_SYNC_INSTANCES);
  if (merged.length > MAX_SYNC_INSTANCES) {
    warnings.push(`本次僅同步前 ${MAX_SYNC_INSTANCES} 台；請選擇單一區域以取得完整清單。`);
  }

  const enriched = await Promise.all(limited.map(async ({ instance, region, ctx }) =>
    enrichInstance(instance, region, ctx, defaultOciAccount.compartmentOcid)));

  await replaceCachedOciInstances(database, accountId, enriched);
  const cachedAt = await getOciInstancesCacheTime(database, accountId);

  console.log("[oci instances] synced", { accountId, regions: regions.length, count: enriched.length, triggeredBy });

  return jsonResponse({
    instances: attachAliases(enriched as CachedRow[], aliasMap),
    nextPage: null,
    region: regions.length === 1 ? regions[0] : regions.join(","),
    cached: false,
    cachedAt,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

/** 逐台補主要 VNIC 的公網 IP 與 IPv6；單台失敗不影響整批（IP 欄位留空）。 */
async function enrichInstance(
  instance: Record<string, unknown>,
  region: string,
  ctx: { account: { compartmentOcid: string }, privateKeyPem: string },
  compartmentOcid: string,
) {
  const base = {
    id: String(instance?.id || ""),
    displayName: String(instance?.displayName || ""),
    lifecycleState: String(instance?.lifecycleState || ""),
    shape: String(instance?.shape || ""),
    region,
    availabilityDomain: String(instance?.availabilityDomain || ""),
    timeCreated: instance?.timeCreated ? String(instance.timeCreated) : null,
    publicIp: null as string | null,
    ipv6Address: null as string | null,
  };
  try {
    const vnicInfo = await getPrimaryVnic(
      ctx as never,
      { instanceId: base.id, compartmentOcid: compartmentOcid || ctx.account.compartmentOcid },
    );
    if (vnicInfo) {
      base.publicIp = vnicInfo.vnic?.publicIp ? String(vnicInfo.vnic.publicIp) : null;
      // OCI GetVnic 的 ipv6Addresses 依官方規格為 string[]，同時相容物件形式兜底
      const v6List: unknown[] = Array.isArray(vnicInfo.vnic?.ipv6Addresses) ? vnicInfo.vnic.ipv6Addresses : [];
      const firstV6 = v6List
        .map(item => (typeof item === "string"
          ? item.trim()
          : String((item as { ipAddress?: string; address?: string } | null)?.ipAddress
            || (item as { ipAddress?: string; address?: string } | null)?.address
            || "").trim()))
        .find(Boolean);
      base.ipv6Address = firstV6 || null;
    }
  } catch {
    // IP 資訊取得失敗不中斷清單
  }
  return base;
}
