// POST /api/wavelength/forwarder：以 SSE 串流為既有 Wavelength 執行個體
// 部署區域型 forwarder（一般區域 t3.nano + iptables 轉送）。
// 事件序列與 deploy 相同：progress… → result|error；
// 操作日誌 action: deploy_forwarder。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { resolveRequestCredential } from "@/server/utils/deploy-credential.js";
import { registerDeploymentMachines } from "@/server/utils/deployment-registration.js";
import { summarizeDeployResult } from "@/server/utils/deploy-log.js";
import { errorResponse, jsonResponse, readJsonBody, sseResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import {
  deployForwarderForExistingWavelengthInstance,
  toHttpError,
} from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request));
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  for (const [value, type, label] of [
    [body.region, "region", "地區"],
    [body.zone, "zone", "Zone ID"],
    [body.vpc_id, "vpcId", "VPC ID"],
    [body.instance_id, "instanceId", "執行個體 ID"],
    [body.os, "os", "作業系統"],
  ] as const) {
    const validation = validateInput(value, type, label);
    if (!validation.valid) {
      return errorResponse(400, validation.error);
    }
  }
  const credentialResolution = await resolveRequestCredential(env.DB, body);
  if (credentialResolution.error) {
    return errorResponse(400, credentialResolution.error);
  }
  body.credential = credentialResolution.credential;

  let accountContext;
  try {
    accountContext = await resolveAwsAccount(env, body.account_id);
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
  const { account, awsEnv } = accountContext;

  return sseResponse(async (emit) => {
    try {
      const result = await deployForwarderForExistingWavelengthInstance(awsEnv, body, (stage, details = {}) => {
        emit("progress", { stage, ...details });
      });
      const management = await registerDeploymentMachines(env.DB, "forwarder", body.region, result, account.id);
      const response = { ...result, management };
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_forwarder",
          region: body.region,
          instanceId: result.forwarder?.instance_id || result.target_instance_id,
          status: "success",
          detail: summarizeDeployResult(response),
          awsAccountId: account.id,
        });
      } catch {
        // 日誌寫入失敗不影響成功結果
      }
      emit("result", response);
    } catch (error) {
      const httpError = toHttpError(error);
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_forwarder",
          region: body.region,
          instanceId: body.instance_id,
          status: "failure",
          detail: httpError.body?.error || String(error),
          awsAccountId: account.id,
        });
      } catch {
        // 日誌寫入失敗不影響錯誤事件
      }
      emit("error", httpError.body);
    }
  });
}
