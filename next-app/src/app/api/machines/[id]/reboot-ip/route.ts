// POST /api/machines/:id/reboot-ip：更換公網 IPv4，可選同時更換 IPv6。
// 依平台分流：
// - EC2：stop → 輪詢 stopped → start（rotatePublicIp）；includeIpv6 時接
//   rotateEc2Ipv6（Unassign → Assign）。
// - Lightsail：動態 IP 走 stop → start（公網 IP 釋放後重配）；綁 Static IP 時
//   Detach → Release → Allocate → Attach 重配新靜態 IP；includeIpv6 時以
//   ipAddressType ipv4 → dualstack 切換換發 IPv6（v4 保留）。
// - Lightsail 無法換 IP 的舊 400 已移除：AWS 文件證實 stop/start 會重配動態 IP。
// 共用邏輯：power.js rotatePublicIp／rotateEc2Ipv6、lightsail-power.js
// rotateLightsailPublicIp。成功後同步 DDNS（EC2）。
import { errorResponse, jsonResponse, readJsonBody, toHttpError } from "@/server/utils/http.js";
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { rotateIpFailureMessage, rotatePublicIp } from "@/server/utils/power.js";
import { rotateLightsailPublicIp } from "@/server/utils/lightsail-power.js";
import { rotateEc2Ipv6 } from "@/server/utils/power.js";
import { syncMachineDdns } from "@/server/utils/ddns.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

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
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const includeIpv6 = body.includeIpv6 === true;

  const { id: rawId } = await params;
  const id = Number(rawId);
  const machine = Number.isInteger(id) && id > 0 ? await getMachineById(env.DB, id) : null;
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }
  if (machine.isWavelength && includeIpv6) {
    return errorResponse(400, "Wavelength Zone 不支援 IPv6，無法同時更換 IPv6。");
  }

  let awsEnv: Awaited<ReturnType<typeof resolveAwsAccount>>["awsEnv"];
  let ipv4Result: { previousIp?: string; newIp?: string } | null = null;
  let ipv6Result: { previousIp?: string; newIp?: string } | null = null;
  try {
    ({ awsEnv } = await resolveAwsAccount(env, machine.awsAccountId));

    if (machine.platform === "lightsail") {
      const result = await rotateLightsailPublicIp(awsEnv, machine, {
        includeIpv6,
        onProgress: () => {
          // JSON 端點無進度串流；輪詢在伺服端進行
        },
      });
      ipv4Result = { previousIp: result.previousIp, newIp: result.newIp };
      if (result.ipv6Rotated) {
        ipv6Result = { previousIp: "", newIp: "" };
      }
    } else {
      const v4 = await rotatePublicIp(awsEnv, machine);
      ipv4Result = { previousIp: "", newIp: v4.newIpAddress || "" };
      if (includeIpv6) {
        ipv6Result = await rotateEc2Ipv6(awsEnv, machine);
      }
    }
  } catch (error) {
    const rotateError = error as { precheck?: boolean; recoveryRequested?: boolean } | null;
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
      detail: {
        previous_ip: ipv4Result?.previousIp ?? null,
        new_ip: ipv4Result?.newIp ?? null,
        ...(ipv6Result ? { ipv6: ipv6Result } : {}),
      },
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // AWS 操作已成功時，稽核日誌失敗不應回報操作失敗。
  }

  // 換 IP 成功後同步 DDNS（EC2 綁定 hostname 的機器）；失敗僅附警告，
  // 不改動換 IP 本身的成功結果。
  let ddnsWarning: string | undefined;
  if (machine.platform === "ec2" && !machine.isWavelength) {
    try {
      const result = await syncMachineDdns(awsEnv, env.DB, machine, { knownIp: ipv4Result?.newIp || null });
      if (result.results.some(item => item.status === "updated" || item.status === "created")) {
        try {
          await appendOperationLog(env.DB, {
            action: "ddns-sync",
            region: machine.region,
            instanceId: machine.instanceId,
            status: "success",
            detail: { bindings: result.results, trigger: "reboot-ip" },
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
  }

  const parts = [
    ipv4Result?.previousIp ? `${ipv4Result.previousIp} → ${ipv4Result.newIp}` : null,
    ipv6Result ? "IPv6 已更換" : null,
  ].filter(Boolean);

  return jsonResponse({
    ok: true,
    message: parts.length > 0 ? `已更換：${parts.join("；")}` : "已停止並重新啟動，公網 IP 將更換。",
    ...(ipv4Result?.newIp ? { ipAddress: ipv4Result.newIp } : {}),
    ...(ipv6Result?.newIp ? { ipv6Address: ipv6Result.newIp } : {}),
    ...(ddnsWarning ? { ddnsWarning } : {}),
  });
}
