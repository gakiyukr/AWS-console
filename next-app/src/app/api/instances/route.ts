// GET /api/instances：即時列出 compartment 內的執行個體，逐台附帶主要
// VNIC 的公網 IP 與 IPv6。清單直接來自 ListInstances API（不落庫）。
// 子請求數：1 + 每台 2（ListVnicAttachments + GetVnic），20 台約 41 個，
// 低於 Workers 單請求 50 上限；分頁由 opc-next-page 權杖控制。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listInstances } from "@/server/utils/oci-compute.js";
import { getPrimaryVnic } from "@/server/utils/oci-network.js";
import { getAllInstanceAliases } from "@/server/utils/instance-aliases.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
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
  if (accountId) {
    const validation = validateInput(accountId, undefined, "account_id");
    if (!validation.valid || !/^\d+$/.test(accountId)) {
      return errorResponse(400, "account_id 參數無效");
    }
  }

  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const [listResult, aliasMap] = await Promise.all([
      listInstances(
        { account: ociAccount, privateKeyPem },
        { page: page || null },
      ),
      env.DB ? (getAllInstanceAliases(env.DB) as Promise<Record<string, { alias: string, notes: string }>>) : Promise.resolve({} as Record<string, { alias: string, notes: string }>),
    ]);
    const { items, nextPage } = listResult;

    const trimmed = items.slice(0, MAX_PAGE_SIZE);
    // 逐台取主要 VNIC 的 IP 資訊；單台失敗不影響整頁（IP 欄位留空）
    const enriched = await Promise.all(trimmed.map(async (instance) => {
      const instanceId = String(instance?.id || "");
      const aliasData = aliasMap[instanceId];
      const base = {
        id: instanceId,
        displayName: String(instance?.displayName || ""),
        alias: aliasData?.alias || null,
        notes: aliasData?.notes || null,
        lifecycleState: String(instance?.lifecycleState || ""),
        shape: String(instance?.shape || ""),
        availabilityDomain: String(instance?.availabilityDomain || ""),
        timeCreated: instance?.timeCreated ? String(instance.timeCreated) : null,
        publicIp: null as string | null,
        ipv6Address: null as string | null,
      };
      try {
        const vnicInfo = await getPrimaryVnic(
          { account: ociAccount, privateKeyPem },
          { instanceId: base.id, compartmentOcid: ociAccount.compartmentOcid },
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
    }));

    return jsonResponse({
      instances: enriched,
      nextPage: nextPage || null,
      region: ociAccount.region,
    });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
