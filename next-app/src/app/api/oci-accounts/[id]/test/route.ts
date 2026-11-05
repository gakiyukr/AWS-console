// POST /api/oci-accounts/[id]/test：以 ListRegions 呼叫驗證帳號憑證
// （簽章正確 + Tenancy 可用），成功時更新 lastVerifiedAt。
import { toOciAccountHttpError, resolveOciAccount } from "@/server/utils/oci-account.js";
import { ociRequestJson } from "@/server/utils/oci-request.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { markOciAccountVerified } from "@/server/utils/db.js";
import { jsonResponse } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  try {
    const { account, ociAccount, privateKeyPem } = await resolveOciAccount(env, id);
    await ociRequestJson({
      account: ociAccount,
      privateKeyPem,
      method: "GET",
      path: "/20160918/regions",
    });
    await markOciAccountVerified(env.DB, account.id);
    return jsonResponse({ ok: true, message: "OCI 憑證驗證成功" });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    if (httpError.status === 500) {
      return jsonResponse({ error: ociFailureMessage(error) }, { status: httpError.status });
    }
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
