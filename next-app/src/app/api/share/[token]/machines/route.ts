// GET /api/share/:token/machines：公開端點（token 即憑證，無 session）。
// 回傳連結綁定機器的即時狀態與公網 IP；欄位刻意精簡，不暴露
// instanceId、AWS 帳號等內部資訊。token 無效或連結停用一律 404，
// 不洩漏連結存在性。多 AWS 帳號依帳號分組解析憑證，單一帳號查詢
// 失敗時該組列降級為「查詢失敗」，與 /api/machines 的行為一致。
import { getShareLinkByToken, listMachines } from "@/server/utils/db.js";
import { errorResponse, jsonResponse } from "@/server/utils/http.js";
import { getActiveCaptchaProviders, isShareCaptchaEnabled } from "@/server/utils/cap.js";
import { mergeMachineStates } from "@/server/utils/power.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const env = await getEnv();
  const link = await getShareLinkByToken(env.DB, token);
  if (!link || !link.enabled) {
    return errorResponse(404, "找不到此分享連結，或連結已被停用。");
  }

  const cooldownMs = link.cooldownMinutes * 60_000;
  const machines = (await listMachines(env.DB)).filter(machine =>
    link.machines.some(bound => bound.id === machine.id));

  // 依 AWS 帳號分組合併即時狀態；帳號層級失敗僅降級該組，不拖垮整體回應。
  const groups = new Map<number | null, typeof machines>();
  for (const machine of machines) {
    const key = machine.awsAccountId || null;
    groups.set(key, [...(groups.get(key) || []), machine]);
  }
  const rows = new Map<number, Record<string, unknown>>();
  await Promise.all([...groups.entries()].map(async ([accountId, accountMachines]) => {
    try {
      const { awsEnv } = await resolveAwsAccount(env, accountId);
      for (const machine of await mergeMachineStates(awsEnv, accountMachines)) {
        rows.set(machine.id, machine);
      }
    } catch {
      for (const machine of accountMachines) {
        rows.set(machine.id, {
          ...machine,
          state: "查詢失敗",
          publicDnsName: "查詢失敗",
          publicIpAddress: "查詢失敗",
        });
      }
    }
  }));

  const captchaEnabled = await isShareCaptchaEnabled(env.DB);
  const activeProviders = captchaEnabled ? await getActiveCaptchaProviders(env) : [];
  const isCaptchaActive = captchaEnabled && activeProviders.length > 0;
  const capProvider = activeProviders.find(p => p.provider === "cap");

  return jsonResponse({
    link: { name: link.name, cooldownMinutes: link.cooldownMinutes },
    captchaEnabled: isCaptchaActive,
    captchaProviders: isCaptchaActive ? activeProviders.map(p => ({
      provider: p.provider,
      name: p.name,
      endpoint: p.endpoint || undefined,
      siteKey: p.siteKey,
    })) : [],
    captcha: isCaptchaActive && capProvider ? {
      endpoint: capProvider.endpoint,
      siteKey: capProvider.siteKey,
    } : null,
    machines: machines.map(machine => {
      const row = rows.get(machine.id) || {};
      const lastTriggeredAt = link.machines.find(bound => bound.id === machine.id)?.lastTriggeredAt ?? null;
      const cooldownUntil = cooldownMs > 0 && lastTriggeredAt
        ? lastTriggeredAt + cooldownMs
        : null;
      return {
        id: machine.id,
        name: row.name || machine.name,
        state: row.state ?? null,
        publicIpAddress: row.publicIpAddress ?? null,
        cooldownUntil,
      };
    }),
  });
}
