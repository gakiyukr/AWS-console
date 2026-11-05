// 帳號區域快取：
// GET  ?platform=ec2|lightsail → 讀快取；快取為空時改抓 live 並回填
//      （相容此功能上線前建立的既有帳號），回應帶 cached: true|false。
//      帳號管理頁的唯讀顯示可帶 backfill=0，快取為空時直接回空、不打 AWS。
// POST → 手動重新整理：兩個平台都重抓 live 並整批替換快取。
// 快取的更新點：建立帳號自動抓取、「開通區域」成功後併入、本端點手動刷新。
import {
  listCachedRegions,
  replaceCachedRegions,
} from "@/server/utils/db.js";
import { errorResponse, jsonResponse, toHttpError } from "@/server/utils/http.js";
import { listEc2Regions } from "@/server/utils/wavelength.js";
import { listLightsailRegions } from "@/server/utils/lightsail-deploy.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const PLATFORMS = ["ec2", "lightsail"] as const;
type Platform = (typeof PLATFORMS)[number];

/** 抓取指定平台的 live 區域清單。 */
async function fetchLiveRegions(awsEnv: unknown, platform: Platform): Promise<string[]> {
  if (platform === "lightsail") {
    return await listLightsailRegions(awsEnv);
  }
  return await listEc2Regions(awsEnv);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  const platformParam = new URL(request.url).searchParams.get("platform");
  if (platformParam !== "ec2" && platformParam !== "lightsail") {
    return errorResponse(400, "platform 參數須為 ec2 或 lightsail。");
  }

  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return errorResponse(400, "帳號 ID 無效。");
  }

  let awsEnv: unknown;
  try {
    ({ awsEnv } = await resolveAwsAccount(env, accountId));
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!forceRefresh) {
    const cached = await listCachedRegions(env.DB, accountId, platformParam);
    if (cached.length > 0) {
      return jsonResponse({ regions: cached, cached: true });
    }
  }

  // backfill=0：唯讀模式（帳號管理頁顯示用），快取為空就不打 AWS
  if (new URL(request.url).searchParams.get("backfill") === "0") {
    return jsonResponse({ regions: [], cached: true });
  }

  // 快取為空（既有帳號首次讀取）：抓 live 並回填
  try {
    const regions = await fetchLiveRegions(awsEnv, platformParam);
    await replaceCachedRegions(env.DB, accountId, platformParam, regions);
    return jsonResponse({ regions, cached: false });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
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
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return errorResponse(400, "帳號 ID 無效。");
  }

  let awsEnv: unknown;
  try {
    ({ awsEnv } = await resolveAwsAccount(env, accountId));
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  const counts: Record<Platform, number> = { ec2: 0, lightsail: 0 };
  try {
    for (const platform of PLATFORMS) {
      const regions = await fetchLiveRegions(awsEnv, platform);
      counts[platform] = await replaceCachedRegions(env.DB, accountId, platform, regions);
    }
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }

  return jsonResponse({
    ok: true,
    message: `區域快取已更新（EC2 ${counts.ec2} 區、Lightsail ${counts.lightsail} 區）。`,
    ...counts,
  });
}
