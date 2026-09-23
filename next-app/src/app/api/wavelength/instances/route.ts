// GET /api/wavelength/instances?region=…&zone=…&vpc_id=…：
// 列出指定 VPC 內既有的 Wavelength 執行個體（供 forwarder 流程選擇目標）。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { listExistingWavelengthInstances } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const region = String(query.get("region") ?? "");
  const zone = String(query.get("zone") ?? "");
  const vpcId = String(query.get("vpc_id") ?? "");

  const regionValidation = validateInput(region, "region", "地區");
  if (!regionValidation.valid) {
    return errorResponse(400, regionValidation.error);
  }
  const zoneValidation = validateInput(zone, "zone", "Zone ID");
  if (!zoneValidation.valid) {
    return errorResponse(400, zoneValidation.error);
  }
  const vpcValidation = validateInput(vpcId, "vpcId", "VPC ID");
  if (!vpcValidation.valid) {
    return errorResponse(400, vpcValidation.error);
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.get("account_id"));
    return jsonResponse({
      region,
      zone,
      vpc_id: vpcId,
      instances: await listExistingWavelengthInstances(awsEnv, { region, zone, vpc_id: vpcId }),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
