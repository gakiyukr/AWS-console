// GET /api/wavelength/os-options：回傳支援的作業系統選項（靜態清單）。
import { jsonResponse } from "@/server/utils/http.js";
import { listWavelengthOsOptions } from "@/server/utils/wavelength.js";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  return jsonResponse({ os: listWavelengthOsOptions() });
}
