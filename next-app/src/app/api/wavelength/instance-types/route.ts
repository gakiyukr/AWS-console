// GET /api/wavelength/instance-types?region=…&zone=…：
// 列出該 Zone 內可用的執行個體類型（依價位排序）。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { listWavelengthInstanceTypes, toHttpError } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const region = String(query.get("region") ?? "");
  const zone = String(query.get("zone") ?? "");

  const regionValidation = validateInput(region, "region", "地區");
  if (!regionValidation.valid) {
    return errorResponse(400, regionValidation.error);
  }
  const zoneValidation = validateInput(zone, "zone", "Zone ID");
  if (!zoneValidation.valid) {
    return errorResponse(400, zoneValidation.error);
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.get("account_id"));
    return jsonResponse({
      region,
      zone,
      instance_types: await listWavelengthInstanceTypes(awsEnv, region, zone),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
