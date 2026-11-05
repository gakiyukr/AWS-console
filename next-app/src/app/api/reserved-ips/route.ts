// GET & POST /api/reserved-ips：保留公網 IP 清單與建立（Phase 2）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listReservedPublicIps, createReservedPublicIp } from "@/server/utils/oci-network.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";

  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const items = await listReservedPublicIps(
      { account: ociAccount, privateKeyPem },
      { compartmentOcid: ociAccount.compartmentOcid },
    );

    const mapped = (items as Array<Record<string, unknown>>).map((ip) => ({
      id: String(ip.id || ""),
      ipAddress: String(ip.ipAddress || ""),
      displayName: String(ip.displayName || ""),
      lifecycleState: String(ip.lifecycleState || ""),
      assignedEntityId: ip.assignedEntityId ? String(ip.assignedEntityId) : null,
      assignedEntityType: ip.assignedEntityType ? String(ip.assignedEntityType) : null,
      privateIpId: ip.privateIpId ? String(ip.privateIpId) : null,
      timeCreated: ip.timeCreated ? String(ip.timeCreated) : null,
    }));

    return jsonResponse({
      reservedIps: mapped,
      region: ociAccount.region,
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
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const privateIpId = typeof body.privateIpId === "string" ? body.privateIpId.trim() : undefined;

  let ctx;
  try {
    ctx = await resolveOciAccount(env, accountId || undefined);
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  try {
    const created = await createReservedPublicIp(ctx, {
      compartmentOcid: ctx.ociAccount.compartmentOcid,
      displayName: displayName || undefined,
      privateIpId: privateIpId || undefined,
    });

    try {
      await appendOperationLog(env.DB, {
        action: "create-reserved-ip",
        ociAccountId: ctx.account.id,
        instanceId: null,
        displayName: displayName || created.ipAddress,
        status: "success",
        detail: { public_ip_id: created.id, ip_address: created.ipAddress },
      });
    } catch {
      // ignore
    }

    return jsonResponse({ ok: true, reservedIp: created });
  } catch (error) {
    const message = ociFailureMessage(error);
    return errorResponse(500, message);
  }
}
