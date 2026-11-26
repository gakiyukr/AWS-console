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
  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";
  // 多區域：region 覆蓋帳號預設操作區域，AD／shape／VCN 隨之切換
  const region = query.get("region") || "";
  if (accountId) {
    const validation = validateInput(accountId, undefined, "account_id");
    if (!validation.valid || !/^\d+$/.test(accountId)) {
      return errorResponse(400, "account_id 參數無效");
    }
  }

  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined, { region: region || undefined });
    const options = await listCreateOptions({ account: ociAccount, privateKeyPem });
    return jsonResponse({ ...options, compartmentOcid: ociAccount.compartmentOcid, region: ociAccount.region });
  } catch (error) {
    // 記錄 OCI 原始錯誤（代碼／狀態／訊息），Dashboard Workers Logs 可查
    console.error("[oci create-options] failed", {
      accountId: accountId || "default",
      region: region || "default",
      message: error instanceof Error ? error.message : String(error),
      ociCode: /** @type {{ ociCode?: string }} */ (error)?.ociCode || null,
      status: /** @type {{ statusCode?: number }} */ (error)?.statusCode || null,
      stack: error instanceof Error ? error.stack : null,
    });
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
