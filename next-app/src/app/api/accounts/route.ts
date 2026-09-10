// GET /api/accounts：回傳 AWS 帳號清單；密文欄位不出伺服器。
import { listAwsAccounts } from "@/server/utils/db.js";
import { jsonResponse } from "@/server/utils/http.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

function publicAccount(account: Record<string, unknown>) {
  const safe = { ...account };
  delete safe.credentialCiphertext;
  delete safe.credentialIv;
  return safe;
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();
  const accounts = await listAwsAccounts(env.DB);
  return jsonResponse({ accounts: accounts.map(publicAccount) });
}
