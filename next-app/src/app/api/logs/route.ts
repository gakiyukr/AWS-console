// GET /api/logs：讀取機器操作與部署流程的稽核日誌。
// 可選 action、status 與 limit 篩選。
import { listOperationLogs } from "@/server/utils/db.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const LOG_STATUSES = new Set(["success", "failure"]);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseLimit(value: string | null): number | null {
  if (value === null) {
    return DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return null;
  }
  return Math.min(limit, MAX_LIMIT);
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const action = query.get("action") ?? undefined;
  const status = query.get("status") ?? undefined;
  const awsAccountId = query.get("account_id") === null ? undefined : Number(query.get("account_id"));

  if (action !== undefined) {
    const validation = validateInput(action, undefined, "action");
    if (!validation.valid) {
      return errorResponse(400, validation.error);
    }
  }
  if (status !== undefined && !LOG_STATUSES.has(status)) {
    return errorResponse(400, "status 參數無效");
  }
  if (awsAccountId !== undefined && (!Number.isSafeInteger(awsAccountId) || awsAccountId <= 0)) {
    return errorResponse(400, "account_id 參數無效");
  }

  const limit = parseLimit(query.get("limit"));
  if (limit === null) {
    return errorResponse(400, "limit 參數無效");
  }

  const logs = await listOperationLogs(env.DB, { action, status, awsAccountId, limit });
  return jsonResponse({ logs });
}
