// GET /api/ec2/regions：列出所選 AWS 帳號已啟用的全部 Region。
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { jsonResponse, toHttpError } from "@/server/utils/http.js";
// 注意：Region 探索與 Wavelength 共用同一模組，非 Wavelength 專屬。
import { listEc2Regions } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const accountId = new URL(request.url).searchParams.get("account_id");
  try {
    const { awsEnv } = await resolveAwsAccount(env, accountId);
    return jsonResponse({ regions: await listEc2Regions(awsEnv) });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
