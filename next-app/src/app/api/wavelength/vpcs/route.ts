// GET /api/wavelength/vpcs?region=…：列出指定地區可用的 VPC 選項。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { listVpcOptions, toHttpError } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const region = String(query.get("region") ?? "");
  const validation = validateInput(region, "region", "地區");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }
  try {
    const { awsEnv } = await resolveAwsAccount(env, query.get("account_id"));
    return jsonResponse({ region, vpcs: await listVpcOptions(awsEnv, region) });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
