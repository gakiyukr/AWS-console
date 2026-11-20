// GET /api/instances：即時列出 compartment 內的執行個體，逐台附帶主要
// VNIC 的公網 IP 與 IPv6。清單直接來自 ListInstances API（不落庫）。
// region 參數：指定時只查該區域（支援 opc-next-page 分頁）；未指定時並行
// 查詢帳號所有已訂閱區域（快取，migration 0021）各第一頁，合併按
// timeCreated DESC 截前 20 台。多區域合併模式不回傳 nextPage。
// 子請求數：區域數 + 每台 2（ListVnicAttachments + GetVnic），20 台約 41+N，
// 低於 Workers 單請求 50 上限。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listInstances } from "@/server/utils/oci-compute.js";
import { getPrimaryVnic } from "@/server/utils/oci-network.js";
import { getAllInstanceAliases } from "@/server/utils/instance-aliases.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { listCachedOciRegions } from "@/server/utils/db.js";
import { readyOciRegions } from "@/server/utils/oci-regions.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_PAGE_SIZE = 20;

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";
  const page = query.get("page") || "";
  const regionParam = query.get("region") || "";
  if (accountId) {
    const validation = validateInput(accountId, undefined, "account_id");
    if (!validation.valid || !/^\d+$/.test(accountId)) {
      return errorResponse(400, "account_id 參數無效");
    }
  }

  try {
    // 帳號與私鑰只解密一次；多區域切換僅覆蓋 account.region。
    const { ociAccount: defaultOciAccount, privateKeyPem } = await resolveOciAccount(
      env,
      accountId || undefined,
      { region: regionParam || undefined },
    );

    // 多區域合併模式：未指定 region、非分頁請求、快取含 ≥2 READY 區域。
    const database = env.DB as D1Database;
    let regions: string[] = [];
    if (!regionParam && !page) {
      regions = readyOciRegions(
        await listCachedOciRegions(database, Number(accountId) || defaultOciAccount.id),
      ).map(item => item.region);
    }

    const aliasMap = await getAllInstanceAliases(database) as Record<string, { alias: string, notes: string }>;

    if (regions.length > 1) {
      // 並行抓各區域第一頁；單區域失敗不影響其他區域，錯誤以 warnings 回報。
      const settled = await Promise.allSettled(regions.map(async (region) => {
        const ctx = { account: { ...defaultOciAccount, region }, privateKeyPem };
        const result = await listInstances(ctx, { page: null });
        return { region, ctx, ...result };
      }));
      const warnings: string[] = [];
      const merged: Array<{ instance: unknown, region: string, ctx: { account: { compartmentOcid: string, id: number }, privateKeyPem: string } }> = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          for (const instance of outcome.value.items) {
            merged.push({ instance, region: outcome.value.region, ctx: outcome.value.ctx });
          }
        } else {
          warnings.push(`區域 ${regions[index]} 清單取得失敗：${ociFailureMessage(outcome.reason)}`);
        }
      });
      merged.sort((a, b) => String((b.instance as { timeCreated?: string })?.timeCreated || "")
        .localeCompare(String((a.instance as { timeCreated?: string })?.timeCreated || "")));
      const maxInstances = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor((46 - regions.length) / 2)));
      if (merged.length > maxInstances) {
        warnings.push(`多區域合計僅顯示前 ${maxInstances} 台；請選擇單一區域檢視完整清單。`);
      }
      const trimmed = merged.slice(0, maxInstances);

      const enriched = await Promise.all(trimmed.map(async ({ instance, region, ctx }) =>
        enrichInstance(instance, region, ctx as { account: { compartmentOcid: string, id: number }, privateKeyPem: string }, aliasMap, defaultOciAccount.compartmentOcid)));
      return jsonResponse({
        instances: enriched,
        nextPage: null,
        region: regions.join(","),
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    }

    // 單一區域模式（明確指定 region、分頁、或快取無多區域）
    const ctx = { account: defaultOciAccount, privateKeyPem };
    const { items, nextPage } = await listInstances(ctx, { page: page || null });

    const trimmed = items.slice(0, MAX_PAGE_SIZE);
    const enriched = await Promise.all(trimmed.map((instance: unknown) =>
      enrichInstance(instance, defaultOciAccount.region, ctx, aliasMap, defaultOciAccount.compartmentOcid)));

    return jsonResponse({
      instances: enriched,
      nextPage: nextPage || null,
      region: defaultOciAccount.region,
    });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}

/** 逐台補主要 VNIC 的公網 IP 與 IPv6；單台失敗不影響整頁（IP 欄位留空）。 */
async function enrichInstance(
  instance: unknown,
  region: string,
  ctx: { account: { compartmentOcid: string, id: number }, privateKeyPem: string },
  aliasMap: Record<string, { alias: string, notes: string }>,
  compartmentOcid: string,
) {
  const data = instance as { id?: string, displayName?: string, lifecycleState?: string, shape?: string, availabilityDomain?: string, timeCreated?: string };
  const instanceId = String(data?.id || "");
  const aliasData = aliasMap[instanceId];
  const base = {
    id: instanceId,
    displayName: String(data?.displayName || ""),
    alias: aliasData?.alias || null,
    notes: aliasData?.notes || null,
    lifecycleState: String(data?.lifecycleState || ""),
    shape: String(data?.shape || ""),
    region,
    availabilityDomain: String(data?.availabilityDomain || ""),
    timeCreated: data?.timeCreated ? String(data.timeCreated) : null,
    publicIp: null as string | null,
    ipv6Address: null as string | null,
  };
  try {
    const vnicInfo = await getPrimaryVnic(
      ctx,
      { instanceId: base.id, compartmentOcid: compartmentOcid || ctx.account.compartmentOcid },
    );
    if (vnicInfo) {
      base.publicIp = vnicInfo.vnic?.publicIp ? String(vnicInfo.vnic.publicIp) : null;
      const v6: Array<{ address?: string }> = Array.isArray(vnicInfo.vnic?.ipv6Addresses) ? vnicInfo.vnic.ipv6Addresses : [];
      const firstV6 = v6.find(item => item?.address);
      base.ipv6Address = firstV6 ? String(firstV6.address) : null;
    }
  } catch {
    // IP 資訊取得失敗不中斷列表
  }
  return base;
}
