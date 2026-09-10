// GET /api/wavelength/regions：列出已啟用且設有 Wavelength Zone 的地區。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { jsonResponse } from "@/server/utils/http.js";
import { listWavelengthRegions, toHttpError } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  try {
    const { awsEnv } = await resolveAwsAccount(env, new URL(request.url).searchParams.get("account_id"));
    return jsonResponse({ regions: await listWavelengthRegions(awsEnv) });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
