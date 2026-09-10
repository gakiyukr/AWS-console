// GET /api/ec2/os-options：回傳一般 EC2 部署支援的作業系統。
import { jsonResponse } from "@/server/utils/http.js";
import { listWavelengthOsOptions } from "@/server/utils/wavelength.js";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  return jsonResponse({ os: listWavelengthOsOptions() });
}
