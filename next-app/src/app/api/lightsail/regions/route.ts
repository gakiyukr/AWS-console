// GET /api/lightsail/regions：取得 Lightsail 可用 Region 清單。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { listLightsailRegions } from "@/server/utils/lightsail-deploy.js";
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";

export async function GET(request: Request) {
  const denied = await requireApiSession(request);
  if (denied) return denied;

  const env = await getEnv();
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account_id");

  if (!accountId) {
    return errorResponse(400, "缺少 account_id 參數。");
  }

  let accountContext;
  try {
    accountContext = await resolveAwsAccount(env, Number(accountId));
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  try {
    const regions = await listLightsailRegions(accountContext.awsEnv);
    return jsonResponse({ regions });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
