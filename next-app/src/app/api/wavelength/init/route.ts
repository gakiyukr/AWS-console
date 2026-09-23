// POST /api/wavelength/init：初始化指定 Zone 的託管資源
// （subnet、carrier gateway、route table、security group）。
// Zone 未啟用時內部會自動輪詢 Opt-In 狀態（3 秒 × 最長 60 秒）。
// 成功後寫入操作日誌（action: init_zone）。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { initializeWavelengthZone } from "@/server/utils/wavelength.js";
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

  const regionValidation = validateInput(body.region, "region", "地區");
  if (!regionValidation.valid) {
    return errorResponse(400, regionValidation.error);
  }
  const zoneValidation = validateInput(body.zone, "zone", "Zone ID");
  if (!zoneValidation.valid) {
    return errorResponse(400, zoneValidation.error);
  }
  const vpcValidation = validateInput(body.vpc_id, "vpcId", "VPC ID");
  if (!vpcValidation.valid) {
    return errorResponse(400, vpcValidation.error);
  }

  let accountContext;
  try {
    accountContext = await resolveAwsAccount(env, body.account_id);
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
  const { account, awsEnv } = accountContext;

  try {
    const result = await initializeWavelengthZone(awsEnv, body);
    try {
      await appendOperationLog(env.DB, {
        action: "init_zone",
        region: body.region,
        instanceId: null,
        status: "success",
        detail: `已初始化 ${body.zone}`,
        awsAccountId: account.id,
      });
    } catch {
      // 日誌寫入失敗不影響成功回應
    }
    return jsonResponse(result);
  } catch (error) {
    const httpError = toHttpError(error);
    try {
      await appendOperationLog(env.DB, {
        action: "init_zone",
        region: body.region,
        instanceId: null,
        status: "failure",
        detail: httpError.body?.error || String(error),
        awsAccountId: account.id,
      });
    } catch {
      // 日誌寫入失敗不影響錯誤回應
    }
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
