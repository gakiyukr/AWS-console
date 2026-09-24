// POST /api/machines/:id/reboot-ip：連續執行 stop → 輪詢等待停止 → start，
// 藉 Stop/Start 釋放並重新分配公網 IP（RebootInstances 不會換 IP）。
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { ec2Query } from "@/server/utils/aws-query.js";
import { parseInstanceDescription } from "@/server/utils/ec2-xml.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

// 請求大小上限：本端點不接受任何 body 欄位
const MAX_BODY_BYTES = 10240;

// 輪詢等待執行個體進入 stopped：StopInstances 通常 20–60 秒，
// 以 3 秒間隔最多 30 次（90 秒）覆蓋常見情境，避免過早 StartInstances 失敗。
const STOP_POLL_INTERVAL_MS = 3_000;
const STOP_POLL_MAX_ATTEMPTS = 30;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForInstanceStopped(region: string, awsEnv: Parameters<typeof ec2Query>[1], instanceId: string): Promise<boolean> {
  for (let attempt = 0; attempt < STOP_POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(STOP_POLL_INTERVAL_MS);
    const xml = await ec2Query(region, awsEnv, "DescribeInstances", {
      "InstanceId.1": instanceId,
    });
    const instance = parseInstanceDescription(xml);
    if (instance.instanceId === instanceId && instance.state === "stopped") {
      return true;
    }
  }
  return false;
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

  try {
    const { awsEnv } = await resolveAwsAccount(env, machine.awsAccountId);

    await ec2Query(machine.region, awsEnv, "StopInstances", {
      "InstanceId.1": machine.instanceId,
    });

    const stopped = await waitForInstanceStopped(machine.region, awsEnv, machine.instanceId);
    if (!stopped) {
      throw new Error("執行個體未在時限內進入 stopped 狀態，已中止更換 IP；請稍後手動啟動。");
    }

    await ec2Query(machine.region, awsEnv, "StartInstances", {
      "InstanceId.1": machine.instanceId,
    });

    await appendOperationLog(env.DB, {
      action: "reboot-ip",
      region: machine.region,
      instanceId: machine.instanceId,
      status: "success",
      detail: null,
      awsAccountId: machine.awsAccountId,
    });

    return jsonResponse({
      ok: true,
      message: "已停止並重新啟動，公網 IP 將更換。",
    });
  } catch (error) {
    try {
      await appendOperationLog(env.DB, {
        action: "reboot-ip",
        region: machine.region,
        instanceId: machine.instanceId,
        status: "failure",
        detail: "reboot_ip_failed",
        awsAccountId: machine.awsAccountId,
      });
    } catch {
      // 日誌寫入失敗不影響錯誤回應
    }
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, "執行個體操作失敗。");
  }
}
