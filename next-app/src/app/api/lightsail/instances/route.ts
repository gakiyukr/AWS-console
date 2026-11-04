// GET /api/lightsail/instances：列出指定帳號與地區的 Lightsail 執行個體，
// 供「新增機器」挑選（對應 EC2 的 /api/ec2/instances）。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { listLightsailInstances } from "@/server/utils/lightsail-power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { validateInput } from "@/server/utils/validate.js";
import { toHttpError } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const url = new URL(request.url);
  const region = validateInput(url.searchParams.get("region"), "region", "地區");
  if (!region.valid) {
    return errorResponse(400, region.error);
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, url.searchParams.get("account_id"));
    return jsonResponse(await listLightsailInstances(awsEnv, url.searchParams.get("region") || ""));
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
