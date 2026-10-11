// GET /api/lightsail/blueprints：取得指定 Region 的 Lightsail Blueprint（作業系統映像）。
import { requireApiSession } from "@/server/api-guard";
import { getEnv } from "@/server/env";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { listLightsailBlueprints } from "@/server/utils/lightsail-deploy.js";
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";

export async function GET(request: Request) {
  const denied = await requireApiSession(request);
  if (denied) return denied;

  const env = await getEnv();
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account_id");
  const region = url.searchParams.get("region");

  if (!accountId || !region) {
    return errorResponse(400, "缺少 account_id 或 region 參數。");
  }

  let accountContext;
  try {
    accountContext = await resolveAwsAccount(env, Number(accountId));
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  try {
    const blueprints = await listLightsailBlueprints(accountContext.awsEnv, region);
    return jsonResponse({ blueprints });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
