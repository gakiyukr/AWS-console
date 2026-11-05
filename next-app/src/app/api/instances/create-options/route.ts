// GET /api/instances/create-options：聚合建機選項（AD／shape／VCN＋子網）。
// 子請求數：AD(1) + shapes(1) + VCN(1) + 每 VCN 子網(1)，遠低於 50 上限。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listCreateOptions } from "@/server/utils/oci-launch.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const accountId = new URL(request.url).searchParams.get("account_id") ?? "";
  if (accountId) {
    const validation = validateInput(accountId, undefined, "account_id");
    if (!validation.valid || !/^\d+$/.test(accountId)) {
      return errorResponse(400, "account_id 參數無效");
    }
  }

  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const options = await listCreateOptions({ account: ociAccount, privateKeyPem });
    return jsonResponse({ ...options, compartmentOcid: ociAccount.compartmentOcid, region: ociAccount.region });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
