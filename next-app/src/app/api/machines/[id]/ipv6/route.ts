// POST /api/machines/:id/ipv6：為既有機器開通 IPv6（完整開通）。
// EC2：VPC /56 → 子網 /64 → IGW ::/0 路由 → SG ::/0 規則 → 指派位址，
//      指派後重開機一次讓客體 OS 抓到位址（reboot 不會更換 IPv4 公網 IP）。
// Lightsail：SetIpAddressType dualstack（免重開）。
// Wavelength Zone 不支援 IPv6，於入口直接拒絕。
// 平台辨別：D1 沒有平台欄位，先以 EC2 DescribeInstances 查詢，
// 找不到再試 Lightsail GetInstance。
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { ec2Query } from "@/server/utils/aws-query.js";
import { parseInstanceNicInfo } from "@/server/utils/ec2-xml.js";
import { enableEc2InstanceIpv6, enableLightsailIpv6 } from "@/server/utils/ipv6.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;

// 指派後重開機，並輪詢確認位址出現（客體抓取時間不定，取不到不算失敗）
const REBOOT_POLL_INTERVAL_MS = 3_000;
const REBOOT_POLL_MAX_ATTEMPTS = 10;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 重新開機並等待 IPv6 位址出現在 DescribeInstances；逾時回 null。 */
async function rebootAndConfirmIpv6(
  region: string,
  awsEnv: Parameters<typeof ec2Query>[1],
  instanceId: string,
): Promise<string | null> {
  await ec2Query(region, awsEnv, "RebootInstances", { "InstanceId.1": instanceId });
  for (let attempt = 0; attempt < REBOOT_POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(REBOOT_POLL_INTERVAL_MS);
    const nic = parseInstanceNicInfo(
      await ec2Query(region, awsEnv, "DescribeInstances", { "InstanceId.1": instanceId }),
    );
    if (nic.ipv6Addresses.length > 0) {
      return nic.ipv6Addresses[0];
    }
  }
  return null;
}

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
  if (machine.isWavelength) {
    return errorResponse(400, "Wavelength Zone 不支援 IPv6。");
  }

  let awsEnv: Awaited<ReturnType<typeof resolveAwsAccount>>["awsEnv"];
  let ipv6Address = "";
  let rebooted = false;
  const warnings: string[] = [];

  try {
    ({ awsEnv } = await resolveAwsAccount(env, machine.awsAccountId));

    // 平台辨別：EC2 先查，找不到再試 Lightsail
    let platform: "ec2" | "lightsail" | null = null;
    try {
      const nic = parseInstanceNicInfo(
        await ec2Query(machine.region, awsEnv, "DescribeInstances", {
          "InstanceId.1": machine.instanceId,
        }),
      );
      if (nic.instanceId) {
        platform = "ec2";
      }
    } catch {
      // EC2 查無此執行個體時改試 Lightsail
    }

    if (platform === "ec2") {
      const result = await enableEc2InstanceIpv6(awsEnv, machine);
      warnings.push(...result.warnings);
      if (result.alreadyAssigned && result.ipv6Address) {
        ipv6Address = result.ipv6Address;
      } else {
        // 指派後重開機讓客體 OS 取得位址
        rebooted = true;
        ipv6Address = await rebootAndConfirmIpv6(machine.region, awsEnv, machine.instanceId) || "";
        if (!ipv6Address) {
          warnings.push("位址已指派，但重開機後尚未回報；請稍後重新整理或至 AWS 主控台確認。");
        }
      }
    } else {
      try {
        const result = await enableLightsailIpv6(awsEnv, machine.region, machine.instanceId);
        ipv6Address = result.ipv6Address;
      } catch {
        platform = null;
      }
    }

    if (!platform) {
      return errorResponse(404, "在 EC2 或 Lightsail 都找不到此執行個體。");
    }
  } catch (error) {
    try {
      await appendOperationLog(env.DB, {
        action: "enable-ipv6",
        region: machine.region,
        instanceId: machine.instanceId,
        status: "failure",
        detail: String(error instanceof Error ? error.message : error),
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 日誌寫入失敗不影響錯誤回應
    }
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500
      ? "開通 IPv6 失敗，請確認執行個體狀態與 IAM 權限。"
      : httpError.body.error);
  }

  try {
    await appendOperationLog(env.DB, {
      action: "enable-ipv6",
      region: machine.region,
      instanceId: machine.instanceId,
      status: "success",
      detail: { ipv6_address: ipv6Address, rebooted, warnings },
      awsAccountId: machine.awsAccountId,
    });
  } catch {
    // AWS 操作已成功時，稽核日誌失敗不應回報操作失敗。
  }

  return jsonResponse({
    ok: true,
    ipv6Address,
    rebooted,
    warnings,
    message: ipv6Address
      ? `IPv6 已開通：${ipv6Address}`
      : "IPv6 已指派，位址稍後重新整理即可查看。",
  });
}
