// POST /api/oci-accounts/[id]/test：以 ListRegions 呼叫驗證帳號憑證
// （簽章正確 + Tenancy 可用），成功時更新 lastVerifiedAt。
import { toOciAccountHttpError, resolveOciAccount } from "@/server/utils/oci-account.js";
import { ociRequestJson } from "@/server/utils/oci-request.js";
import { listRegionSubscriptions } from "@/server/utils/oci-regions.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { listCachedOciRegions, markOciAccountVerified, replaceCachedOciRegions } from "@/server/utils/db.js";
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
      service: "identity",
      method: "GET",
      path: "/20160918/regions",
    });
    await markOciAccountVerified(env.DB, account.id);
    // 快取為空時順手回填訂閱區域；IAM 缺 TENANCY_INSPECT 等失敗不影響憑證驗證結果。
    try {
      const accountId = Number(account.id);
      const cached = await listCachedOciRegions(env.DB, accountId);
      if (cached.length === 0) {
        const subscriptions = await listRegionSubscriptions({ account: ociAccount, privateKeyPem });
        await replaceCachedOciRegions(env.DB, accountId, subscriptions);
      }
    } catch {
      // ignore
    }
    return jsonResponse({ ok: true, message: "OCI 憑證驗證成功" });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    if (httpError.status === 500) {
      return jsonResponse({ error: ociFailureMessage(error) }, { status: httpError.status });
    }
    return jsonResponse(httpError.body, { status: httpError.status });
  }
}
