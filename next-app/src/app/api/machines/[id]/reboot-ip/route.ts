// POST /api/machines/:id/reboot-ip：連續執行 stop + start 來更換公網 IP。
import { appendOperationLog, getMachineById } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
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

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  const machine = Number.isInteger(id) && id > 0 ? await getMachineById(env.DB, id) : null;
  if (!machine) {
    return errorResponse(400, "指定的機器不在清單內。");
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, machine.awsAccountId);

    // Step 1: Stop the instance
    await ec2Query(
      machine.region,
      awsEnv,
      "StopInstances",
      { "InstanceId.1": machine.instanceId },
    );

    // Step 2: Wait for stopped state (polling)
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const describeXml = await ec2Query(
        machine.region,
        awsEnv,
        "DescribeInstanceStatus",
        { "InstanceId.1": machine.instanceId },
      );
      const statusMatch = describeXml.match(/<instanceState>\s*<name>([^<]+)<\/name>/);
      if (statusMatch && statusMatch[1] === "stopped") {
        break;
      }
      attempts++;
    }

    // Step 3: Start the instance
    await ec2Query(
      machine.region,
      awsEnv,
      "StartInstances",
      { "InstanceId.1": machine.instanceId },
    );

    // Record logs
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
      message: "已送出停止→啟動請求（將更換公網 IP）。",
    });
  } catch (error) {
    await appendOperationLog(env.DB, {
      action: "reboot-ip",
      region: machine.region,
      instanceId: machine.instanceId,
      status: "failure",
      detail: error instanceof Error ? error.message : String(error),
      awsAccountId: machine.awsAccountId,
    });
    return errorResponse(500, "操作失敗。");
  }
}

// Import ec2Query dynamically to avoid circular dependency
async function ec2Query(region: string, env: unknown, action: string, params: Record<string, string>) {
  const { ec2Query } = await import("@/server/utils/aws-query.js");
  return ec2Query(region, env as any, action, params);
}
