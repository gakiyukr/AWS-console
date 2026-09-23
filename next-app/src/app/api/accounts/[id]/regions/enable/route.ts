// POST /api/accounts/[id]/regions/enable：為 AWS 帳號開通指定的 opt-in Region。
// EC2 EnableRegion 屬帳號層級操作（一律送至 us-east-1），成功與失敗皆寫入
// 操作日誌（action=enable_region）供 /logs 頁稽核；日誌寫入失敗不影響回應。
import { resolveAwsAccount, toAwsAccountHttpError } from "@/server/utils/aws-account.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { errorResponse, jsonResponse, readJsonBody, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { enableAwsRegion } from "@/server/utils/wavelength.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

// 請求大小上限：本端點僅接受 { region } 一個欄位
const MAX_BODY_BYTES = 10240;

/** 寫入開通 Region 的操作日誌；失敗時靜默，不影響主回應。 */
async function appendEnableRegionLog(
  db: unknown,
  awsAccountId: number,
  region: string,
  status: string,
  detail: string | null,
) {
  try {
    await appendOperationLog(db as Parameters<typeof appendOperationLog>[0], {
      action: "enable_region",
      region,
      instanceId: null,
      status,
      detail,
      awsAccountId,
    });
  } catch {
    // 日誌寫入失敗不影響回應
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }

  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request));
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const validation = validateInput(body.region, "region", "Region");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }
  const region = body.region;

  const { id: rawId } = await params;
  const awsAccountId = Number(rawId);
  let awsEnv;
  try {
    ({ awsEnv } = await resolveAwsAccount(env, rawId));
  } catch (error) {
    const httpError = toAwsAccountHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  try {
    await enableAwsRegion(awsEnv, region);
  } catch (error) {
    await appendEnableRegionLog(env.DB, awsAccountId, region, "failure", error instanceof Error ? error.message : String(error));
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  await appendEnableRegionLog(env.DB, awsAccountId, region, "success", null);
  return jsonResponse({
    ok: true,
    message: `已送出開通 ${region} 的請求，開通程序需數分鐘，稍後可重新載入確認狀態。`,
  });
}
