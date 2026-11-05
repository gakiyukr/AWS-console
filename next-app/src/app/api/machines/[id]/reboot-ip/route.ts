// POST /api/machines/:id/reboot-ip：連續執行 stop → 輪詢等待停止 → start，
// 藉 Stop/Start 釋放並重新分配公網 IP（RebootInstances 不會換 IP）。
// 輪詢、補償與失敗文案位於 power.js 的 rotatePublicIp，與公開分享頁共用。
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { rotateIpFailureMessage, rotatePublicIp } from "@/server/utils/power.js";
import { syncMachineDdns } from "@/server/utils/ddns.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

// 請求大小上限：本端點不接受任何 body 欄位
const MAX_BODY_BYTES = 10240;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  const machine = Number.isInteger(id) && id > 0 ? await getMachineById(env.DB, id) : null;
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }
  // Lightsail 沒有 stop→start 換 IP 的機制（靜態 IP 需另行 allocate/attach）
  if (machine.platform === "lightsail") {
    return errorResponse(400, "Lightsail 執行個體不支援更換公網 IP。");
  }

  let awsEnv: Awaited<ReturnType<typeof resolveAwsAccount>>["awsEnv"];
  try {
    ({ awsEnv } = await resolveAwsAccount(env, machine.awsAccountId));
    await rotatePublicIp(awsEnv, machine);
  } catch (error) {
    const rotateError = error as { precheck?: boolean; recoveryRequested?: boolean } | null;
    // 預檢 409（機器非 running）不送 AWS 操作，沿用原行為不寫入稽核；
    // 其餘失敗記錄是否已送出恢復啟動，供 /logs 判讀機器可能殘留的狀態。
    if (!rotateError?.precheck) {
      try {
        await appendOperationLog(env.DB, {
          action: "reboot-ip",
          region: machine.region,
          instanceId: machine.instanceId,
          status: "failure",
          detail: rotateError?.recoveryRequested
            ? "reboot_ip_failed_recovery_requested"
            : "reboot_ip_failed_instance_may_be_stopped",
          awsAccountId: machine.awsAccountId,
        });
      } catch {
        // 日誌寫入失敗不影響錯誤回應
      }
    }
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, rotateIpFailureMessage(error));
  }

  try {
    await appendOperationLog(env.DB, {
      action: "reboot-ip",
      region: machine.region,
      instanceId: machine.instanceId,
      status: "success",
      detail: null,
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // AWS 操作已成功時，稽核日誌失敗不應回報操作失敗。
  }

  // 換 IP 成功後同步 DDNS（綁定 hostname 的 EC2 機器）；失敗僅附警告，
  // 不改動換 IP 本身的成功結果。
  let ddnsWarning: string | undefined;
  try {
    const result = await syncMachineDdns(awsEnv, env.DB, machine);
    if (result.status === "updated" || result.status === "created") {
      try {
        await appendOperationLog(env.DB, {
          action: "ddns-sync",
          region: machine.region,
          instanceId: machine.instanceId,
          status: "success",
          detail: { hostname: result.hostname, ip: result.ip, trigger: "reboot-ip" },
          awsAccountId: machine.awsAccountId,
        });
      } catch {
        // 日誌失敗不影響回應
      }
    }
  } catch (error) {
    ddnsWarning = `DNS 同步失敗：${error instanceof Error ? error.message : String(error)}`;
    try {
      await appendOperationLog(env.DB, {
        action: "ddns-sync",
        region: machine.region,
        instanceId: machine.instanceId,
        status: "failure",
        detail: { trigger: "reboot-ip", error: ddnsWarning },
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 日誌失敗不影響回應
    }
  }

  return jsonResponse({
    ok: true,
    message: "已停止並重新啟動，公網 IP 將更換。",
    ...(ddnsWarning ? { ddnsWarning } : {}),
  });
}
