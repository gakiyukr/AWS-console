// /api/ddns/bindings：前綴綁定（prefix → machine）。
// GET  → 列出全部綁定（含 FQDN 與機器資訊）及可選機器清單
// POST → 建立綁定並立即同步 DNS（僅 EC2 非 Wavelength 機器）
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { errorResponse, jsonResponse, readJsonBody, toHttpError } from "@/server/utils/http.js";
import {
  createDdnsBinding,
  isValidDdnsPrefix,
  listDdnsBindings,
  listDdnsDomains,
  syncMachineDdns,
} from "@/server/utils/ddns.js";
import { getMachineById, appendOperationLog } from "@/server/utils/db.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";

const MAX_BODY_BYTES = 10240;

/** 寫入 DDNS 操作日誌；失敗靜默。 */
async function appendDdnsLog(
  db: Parameters<typeof appendOperationLog>[0],
  machine: { region: string; instanceId: string; awsAccountId: number | null } | null,
  status: string,
  detail: unknown,
) {
  try {
    await appendOperationLog(db, {
      action: "ddns-sync",
      region: machine?.region ?? null,
      instanceId: machine?.instanceId ?? null,
      status,
      detail,
      awsAccountId: machine?.awsAccountId ?? null,
    });
  } catch {
    // 日誌寫入失敗不影響回應
  }
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const [bindings, domains] = await Promise.all([
    listDdnsBindings(env.DB),
    listDdnsDomains(env.DB),
  ]);
  return jsonResponse({ bindings, domains });
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const body = await readJsonBody(request);
  const prefix = typeof body?.prefix === "string" ? body.prefix.trim().toLowerCase() : "";
  const domainId = Number(body?.domainId);
  const machineId = Number(body?.machineId);
  if (!prefix || prefix.length > 200 || !isValidDdnsPrefix(prefix)) {
    return errorResponse(400, "前綴格式無效（僅小寫英數字、連字號與點，最多 200 字元）。");
  }
  if (!Number.isInteger(domainId) || domainId <= 0 || !Number.isInteger(machineId) || machineId <= 0) {
    return errorResponse(400, "請選擇域名與機器。");
  }

  const domains = await listDdnsDomains(env.DB);
  const domain = domains.find(item => item.id === domainId);
  if (!domain) {
    return errorResponse(400, "指定的域名不存在，請先到設定頁新增。");
  }

  const machine = await getMachineById(env.DB, machineId);
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }
  if (machine.isWavelength) {
    return errorResponse(400, "Wavelength 機器沒有常規公網 IP，不支援 DDNS。");
  }
  if (machine.platform !== "ec2") {
    return errorResponse(400, "Lightsail 機器的 DDNS 尚未支援。");
  }

  const created = await createDdnsBinding(env.DB, { domainId, prefix, machineId });
  if (!created) {
    return errorResponse(409, "此前綴已綁定其他機器，請更換前綴或先移除舊綁定。");
  }

  // 綁定完成後立即同步（失敗不復原綁定，僅回報）
  const fqdn = `${prefix}.${domain.zoneName}`;
  let awsEnv;
  try {
    ({ awsEnv } = await resolveAwsAccount(env, machine.awsAccountId));
  } catch (error) {
    const httpError = toHttpError(error);
    await appendDdnsLog(env.DB, machine, "failure", { fqdn, error: httpError.body.error });
    return jsonResponse({
      ok: true,
      synced: false,
      fqdn,
      message: `已綁定 ${fqdn}，但無法解析 AWS 帳號：${httpError.body.error}`,
    }, { status: 201 });
  }

  try {
    const result = await syncMachineDdns(awsEnv, env.DB, machine);
    await appendDdnsLog(env.DB, machine, "success", { fqdn, status: result.results[0]?.status || "skipped" });
    return jsonResponse({
      ok: true,
      synced: !result.skipped,
      fqdn,
      result,
      message: result.skipped
        ? `已綁定 ${fqdn}，但未同步：${result.reason}`
        : `DDNS 已同步：${fqdn}`,
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendDdnsLog(env.DB, machine, "failure", { fqdn, error: message });
    return jsonResponse({
      ok: true,
      synced: false,
      fqdn,
      message: `已綁定 ${fqdn}，但同步失敗：${message}`,
    }, { status: 201 });
  }
}
