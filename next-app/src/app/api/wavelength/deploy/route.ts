// POST /api/wavelength/deploy：以 SSE 串流部署 Wavelength 執行個體。
// 事件序列：progress…（各階段）→ result（成功）或 error（失敗）；
// sseResponse 已在 onStart 拋錯時自動轉為 error 事件，此處僅需
// 於 result/error 時寫入操作日誌（action: deploy_wavelength）。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { resolveRequestCredential } from "@/server/utils/deploy-credential.js";
import { registerDeploymentMachines } from "@/server/utils/deployment-registration.js";
import { summarizeDeployResult } from "@/server/utils/deploy-log.js";
import { errorResponse, jsonResponse, readJsonBody, sseResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { deployWavelengthInstance, toHttpError } from "@/server/utils/wavelength.js";
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
    [body.instance_type, "instanceType", "執行個體類型"],
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
      const result = await deployWavelengthInstance(awsEnv, body, (stage, details = {}) => {
        emit("progress", { stage, ...details });
      });
      const management = await registerDeploymentMachines(env.DB, "wavelength", body.region, result, account.id);
      const response = { ...result, management };
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_wavelength",
          region: body.region,
          instanceId: result.instance_id,
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
          action: "deploy_wavelength",
          region: body.region,
          instanceId: null,
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
