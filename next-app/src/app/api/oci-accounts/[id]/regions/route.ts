// /api/oci-accounts/[id]/regions：OCI 帳號已訂閱區域快取。
// GET  ?refresh=1 → 即時呼叫 ListRegionSubscriptions 並整批替換快取
//      否則讀快取；快取為空且非 backfill=0 時自動回填（相容既有帳號）
// POST → 手動刷新。訂閱新區域需在 OCI 主控台 Region Management 操作，
//        本端點僅唯讀查詢與快取，不提供開通。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listRegionSubscriptions, sortOciRegions } from "@/server/utils/oci-regions.js";
import { listCachedOciRegions, replaceCachedOciRegions } from "@/server/utils/db.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

async function resolveAccountOrError(env: { DB: D1Database, CREDENTIAL_ENCRYPTION_KEY?: string }, id: string) {
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return { error: errorResponse(400, "帳號 ID 無效。") };
  }
  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId);
    return { ctx: { account: ociAccount, privateKeyPem }, accountId };
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return { error: jsonResponse(httpError.body, { status: httpError.status }) };
  }
}

async function fetchAndCache(env: { DB: D1Database, CREDENTIAL_ENCRYPTION_KEY?: string }, accountId: number, ctx: { account: unknown, privateKeyPem: string }) {
  const subscriptions = await listRegionSubscriptions(ctx as never);
  await replaceCachedOciRegions(env.DB, accountId, subscriptions);
  return subscriptions;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  const resolved = await resolveAccountOrError(env, id);
  if (resolved.error) return resolved.error;

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!forceRefresh) {
    const cached = await listCachedOciRegions(env.DB, resolved.accountId);
    if (cached.length > 0) {
      return jsonResponse({ regions: sortOciRegions(cached), cached: true });
    }
  }

  // backfill=0：唯讀模式（快取為空時不打 OCI API）
  if (new URL(request.url).searchParams.get("backfill") === "0") {
    return jsonResponse({ regions: [], cached: true });
  }

  try {
    const regions = await fetchAndCache(env, resolved.accountId, resolved.ctx);
    return jsonResponse({ regions, cached: false });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const { id } = await params;
  const resolved = await resolveAccountOrError(env, id);
  if (resolved.error) return resolved.error;

  try {
    const regions = await fetchAndCache(env, resolved.accountId, resolved.ctx);
    return jsonResponse({
      ok: true,
      regions,
      message: `已更新訂閱區域快取（共 ${regions.length} 區）。`,
      count: regions.length,
    });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
