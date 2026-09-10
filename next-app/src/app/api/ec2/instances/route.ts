// GET /api/ec2/instances：列出所選 AWS 帳號與 Region 內的全部 EC2 執行個體，
// 供「新增機器」挑選既有執行個體，取代手動輸入執行個體 ID。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { listRegionInstances } from "@/server/utils/power.js";
import { toHttpError } from "@/server/utils/wavelength.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const region = String(query.get("region") ?? "");
  const validation = validateInput(region, "region", "地區");
  if (!validation.valid)
    return errorResponse(400, validation.error);

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.get("account_id"));
    return jsonResponse({ region, instances: await listRegionInstances(awsEnv, region) });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
