// PUT /api/machines/:id/ddns：為機器啟用／更新 DDNS 綁定並立即同步。
// DELETE：停用（清除綁定，CF 記錄保留不刪——刪記錄交由使用者決定）。
// 僅 EC2（platform=ec2 且非 Wavelength）：WL 沒有常規公網 IP。
import {
  clearMachineDdns,
  getMachineById,
  setMachineDdns,
  appendOperationLog,
} from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody, toHttpError } from "@/server/utils/http.js";
import { getDdnsSettings, isHostnameInZone, syncMachineDdns } from "@/server/utils/ddns.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;

/** 寫入 DDNS 操作日誌；失敗靜默。 */
async function appendDdnsLog(
  db: Parameters<typeof appendOperationLog>[0],
  machine: { region: string; instanceId: string; awsAccountId: number | null },
  status: string,
  detail: unknown,
) {
  try {
    await appendOperationLog(db, {
      action: "ddns-sync",
      region: machine.region,
      instanceId: machine.instanceId,
      status,
      detail,
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // 日誌寫入失敗不影響回應
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const body = await readJsonBody(request);
  const hostname = typeof body?.hostname === "string" ? body.hostname.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!hostname || !hostname.includes(".")) {
    return errorResponse(400, "請填寫完整主機名（例如 mybox.example.com）。");
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  const machine = Number.isInteger(id) && id > 0 ? await getMachineById(env.DB, id) : null;
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }
  if (machine.isWavelength) {
    return errorResponse(400, "Wavelength 機器沒有常規公網 IP，不支援 DDNS。");
  }
  if (machine.platform === "lightsail") {
    return errorResponse(400, "Lightsail 機器的 DDNS 尚未支援。");
  }

  const settings = await getDdnsSettings(env.DB, env.CREDENTIAL_ENCRYPTION_KEY);
  if (!settings) {
    return errorResponse(400, "尚未設定 Cloudflare DDNS，請先到設定頁配置。");
  }
  if (!isHostnameInZone(hostname, settings.zoneName)) {
    return errorResponse(400, `主機名必須在設定的 Zone（${settings.zoneName}）之下。`);
  }

  let awsEnv;
  try {
    ({ awsEnv } = await resolveAwsAccount(env, machine.awsAccountId));
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.body.error);
  }

  // 先綁定再同步：同步結果即時回給使用者
  await setMachineDdns(env.DB, id, hostname, machine.ddnsRecordId);
  try {
    const result = await syncMachineDdns(awsEnv, env.DB, { ...machine, ddnsHostname: hostname });
    await appendDdnsLog(env.DB, machine, "success",
      { hostname, status: result.status, ip: result.ip || null });
    return jsonResponse({
      ok: true,
      ...result,
      message: result.status === "skipped"
        ? `已綁定 ${hostname}，但未同步：${result.reason}`
        : `DDNS 已同步：${hostname} → ${result.ip}（${result.status === "created" ? "建立新記錄" : result.status === "updated" ? "已更新記錄" : "記錄原本即正確"}）`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendDdnsLog(env.DB, machine, "failure", { hostname, error: message });
    return errorResponse(502, `綁定完成，但同步失敗：${message}`);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const { id: rawId } = await params;
  const id = Number(rawId);
  const machine = Number.isInteger(id) && id > 0 ? await getMachineById(env.DB, id) : null;
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }

  const cleared = await clearMachineDdns(env.DB, id);
  if (cleared) {
    await appendDdnsLog(env.DB, machine, "success", { hostname: machine.ddnsHostname, status: "disabled" });
  }
  return jsonResponse({ ok: true, cleared });
}
