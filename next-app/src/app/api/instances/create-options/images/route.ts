// GET /api/instances/create-options/images：指定 shape 相容的映像清單
// （TIMECREATED DESC）。前端依 OS 分組選擇，不對 OS 名稱寫死。
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { listImages } from "@/server/utils/oci-launch.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_IMAGES = 200;

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const query = new URL(request.url).searchParams;
  const accountId = query.get("account_id") ?? "";
  const shape = query.get("shape") ?? "";
  const shapeValidation = validateInput(shape, "shape", "shape");
  if (!shapeValidation.valid) {
    return errorResponse(400, shapeValidation.error);
  }

  try {
    const { ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const images = await listImages({ account: ociAccount, privateKeyPem }, { shape });
    return jsonResponse({ images: images.slice(0, MAX_IMAGES) });
  } catch (error) {
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
