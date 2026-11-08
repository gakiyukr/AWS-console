// POST /api/machines/:id/rotate-ipv6：更換既有 EC2 機器的 IPv6 位址。
// 流程：Unassign 全部現有 v6 → Assign 一個新位址（EC2 自子網 /64 選新址）。
// 機器未指派 v6 時回 409（請先用 machines/:id/ipv6 開通）。
// 不需重開機。僅 EC2（platform=ec2 且非 Wavelength）。
// 輪換邏輯位於 power.js 的 rotateEc2Ipv6，與 reboot-ip（includeIpv6）共用。
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { rotateEc2Ipv6 } from "@/server/utils/power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function POST(
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
  if (machine.isWavelength) {
    return errorResponse(400, "Wavelength 機器沒有常規 IPv6，不支援更換。");
  }
  if (machine.platform === "lightsail") {
    return errorResponse(400, "Lightsail 的 IPv6 由 ipAddressType 管理，請用 machines/:id/ipv6。");
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, machine.awsAccountId);
    const result = await rotateEc2Ipv6(awsEnv, machine);

    try {
      await appendOperationLog(env.DB, {
        action: "rotate-ipv6",
        region: machine.region,
        instanceId: machine.instanceId,
        status: "success",
        detail: { previous_ip: result.previousIp, new_ip: result.newIp },
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 操作已成功時，稽核日誌失敗不影響結果
    }

    return jsonResponse({
      ok: true,
      previousIp: result.previousIp,
      ipv6Address: result.newIp,
      message: `已更換 IPv6 位址：${result.previousIp} → ${result.newIp || "（指派中，稍後重新整理即可查看）"}`,
    });
  } catch (error) {
    const httpError = toHttpError(error);
    const message = httpError.status === 500
      ? `更換 IPv6 失敗：${error instanceof Error ? error.message : "未知錯誤"}`
      : httpError.body.error;
    try {
      await appendOperationLog(env.DB, {
        action: "rotate-ipv6",
        region: machine.region,
        instanceId: machine.instanceId,
        status: "failure",
        detail: message,
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 日誌寫入失敗不影響錯誤回應
    }
    return errorResponse(httpError.status, message);
  }
}
