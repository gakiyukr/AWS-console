// POST /api/accounts/[id]/test：以 DescribeRegions 驗證帳號憑證，成功時
// 更新 lastVerifiedAt。
import { resolveAwsAccount, toAwsAccountHttpError } from "@/server/utils/aws-account.js";
import { ec2Query } from "@/server/utils/aws-query.js";
import { markAwsAccountVerified } from "@/server/utils/db.js";
import { jsonResponse } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  try {
    const { account, awsEnv } = await resolveAwsAccount(env, id);
    await ec2Query("us-east-1", awsEnv, "DescribeRegions", { "AllRegions": false });
    await markAwsAccountVerified(env.DB, account.id);
    return jsonResponse({ ok: true, message: "AWS 憑證驗證成功" });
  } catch (error) {
    const httpError = toAwsAccountHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
