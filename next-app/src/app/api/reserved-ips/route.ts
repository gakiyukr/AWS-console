// GET & POST /api/reserved-ips：保留公網 IP 清單與建立（Phase 2，支援單帳號多區域）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listReservedPublicIps, createReservedPublicIp } from "@/server/utils/oci-network.js";
import { readyOciRegions } from "@/server/utils/oci-regions.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog, listCachedOciRegions } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

function mapReservedIp(ip: Record<string, unknown>, region: string) {
  return {
    id: String(ip.id || ""),
    ipAddress: String(ip.ipAddress || ""),
    displayName: String(ip.displayName || ""),
    lifecycleState: String(ip.lifecycleState || ""),
    assignedEntityId: ip.assignedEntityId ? String(ip.assignedEntityId) : null,
    assignedEntityType: ip.assignedEntityType ? String(ip.assignedEntityType) : null,
    privateIpId: ip.privateIpId ? String(ip.privateIpId) : null,
    timeCreated: ip.timeCreated ? String(ip.timeCreated) : null,
    region,
  };
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";
  const regionParam = (query.get("region") ?? "").trim();
  if (accountId) {
    const validation = validateInput(accountId, undefined, "account_id");
    if (!validation.valid || !/^\d+$/.test(accountId)) {
      return errorResponse(400, "account_id 參數無效");
    }
  }

  try {
    const { ociAccount: defaultOciAccount, privateKeyPem } = await resolveOciAccount(
      env,
      accountId || undefined,
      { region: regionParam || undefined },
    );

    let regions: string[] = [];
    if (!regionParam) {
      regions = readyOciRegions(
        await listCachedOciRegions(env.DB, defaultOciAccount.id),
      ).map(item => item.region);
    }

    if (regions.length > 1) {
      const settled = await Promise.allSettled(regions.map(async (region) => {
        const ctx = { account: { ...defaultOciAccount, region }, privateKeyPem };
        const items = await listReservedPublicIps(ctx, { compartmentOcid: defaultOciAccount.compartmentOcid });
        return { region, items };
      }));

      const warnings: string[] = [];
      const merged: Array<ReturnType<typeof mapReservedIp>> = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          for (const ip of outcome.value.items as Array<Record<string, unknown>>) {
            merged.push(mapReservedIp(ip, outcome.value.region));
          }
        } else {
          warnings.push(`區域 ${regions[index]} 保留 IP 清單取得失敗：${ociFailureMessage(outcome.reason)}`);
        }
      });
      merged.sort((a, b) => String(b.timeCreated || "").localeCompare(String(a.timeCreated || "")));

      return jsonResponse({
        reservedIps: merged,
        region: regions.join(","),
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    }

    const items = await listReservedPublicIps(
      { account: defaultOciAccount, privateKeyPem },
      { compartmentOcid: defaultOciAccount.compartmentOcid },
    );
    const mapped = (items as Array<Record<string, unknown>>)
      .map(ip => mapReservedIp(ip, defaultOciAccount.region))
      .sort((a, b) => String(b.timeCreated || "").localeCompare(String(a.timeCreated || "")));

    return jsonResponse({
      reservedIps: mapped,
      region: defaultOciAccount.region,
    });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const body = (await readJsonBody(request)) ?? {};
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";
  const region = typeof body.region === "string" ? body.region.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const privateIpId = typeof body.privateIpId === "string" ? body.privateIpId.trim() : undefined;

  let resolved;
  try {
    resolved = await resolveOciAccount(env, accountId || undefined, { region: region || undefined });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  try {
    const ctx = { account: resolved.ociAccount, privateKeyPem: resolved.privateKeyPem };
    const created = await createReservedPublicIp(ctx, {
      compartmentOcid: resolved.ociAccount.compartmentOcid,
      displayName: displayName || undefined,
      privateIpId: privateIpId || undefined,
    });

    try {
      await appendOperationLog(env.DB, {
        action: "create-reserved-ip",
        ociAccountId: Number(resolved.account.id),
        instanceId: null,
        displayName: displayName || created.ipAddress,
        status: "success",
        detail: { public_ip_id: created.id, ip_address: created.ipAddress, region: resolved.ociAccount.region },
      });
    } catch {
      // ignore
    }

    return jsonResponse({ ok: true, reservedIp: created, region: resolved.ociAccount.region });
  } catch (error) {
    const message = ociFailureMessage(error);
    return errorResponse(500, message);
  }
}
