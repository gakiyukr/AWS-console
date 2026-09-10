// GET /api/ssh-keys：列出設定頁管理的機器登入公鑰。
// 公鑰本身為公開資料，完整回傳內容以利設定頁檢視與部署表單顯示。
import { listSshPublicKeys } from "@/server/utils/db.js";
import { jsonResponse } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  return jsonResponse({ keys: await listSshPublicKeys(env.DB) });
}
