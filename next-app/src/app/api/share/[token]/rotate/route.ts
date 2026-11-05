// POST /api/share/:token/rotate：公開觸發更換公網 IP（SSE 進度串流）。
// token 即憑證，機器必須為連結綁定對象。進入 AWS 流程前先以條件式
// UPDATE 原子搶取「連結×機器」冷卻鎖（搶鎖即寫入 last_triggered_at），
// 防止併發連點造成重複 stop/start；搶鎖失敗一律 429 並回報剩餘時間。
// 換 IP 途中失敗時冷卻仍生效——操作已實際擾動機器，不應被連續重試。
import {
  appendOperationLog,
  claimShareRotation,
  consumeCapToken,
  getCapTokenExpiry,
  getMachineById,
  getShareLinkByToken,
  getShareLinkMachineBinding,
  touchShareLinkUsed,
} from "@/server/utils/db.js";
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { deriveCapTokenKey, isShareCaptchaEnabled } from "@/server/utils/cap.js";
import { rotateIpFailureMessage, rotatePublicIp } from "@/server/utils/power.js";
import { syncMachineDdns } from "@/server/utils/ddns.js";
import { resolveAwsAccount } from "@/server/utils/aws-account.js";
import { getEnv } from "@/server/env";

const MAX_BODY_BYTES = 10240;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const env = await getEnv();
  const link = await getShareLinkByToken(env.DB, token);
  if (!link || !link.enabled) {
    return errorResponse(404, "找不到此分享連結，或連結已被停用。");
  }

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const body = await readJsonBody(request);
  const machineId = Number(body?.machineId);
  if (!Number.isInteger(machineId) || machineId <= 0) {
    return errorResponse(400, "請指定要更換 IP 的機器。");
  }
  if (!link.machines.some(bound => bound.id === machineId)) {
    return errorResponse(403, "此連結未綁定該機器。");
  }
  const machine = await getMachineById(env.DB, machineId);
  if (!machine) {
    return errorResponse(404, "指定的機器不在清單內。");
  }

  const now = Date.now();
  const cooldownMs = link.cooldownMinutes * 60_000;

  // 人機驗證閘門（後台開關開啟時）：先唯讀查驗憑證、搶到冷卻鎖後才
  // 原子單次消費——429 冷卻中的重試可沿用同一憑證，不會被白白燒掉。
  const captchaEnabled = await isShareCaptchaEnabled(env.DB);
  let capTokenKey: string | null = null;
  if (captchaEnabled) {
    capTokenKey = await deriveCapTokenKey(body?.captchaToken);
    const capTokenExpiresAt = capTokenKey ? await getCapTokenExpiry(env.DB, capTokenKey) : null;
    if (!capTokenKey || !capTokenExpiresAt || capTokenExpiresAt <= now) {
      return errorResponse(403, "請先完成人機驗證；若已完成，憑證可能已失效，請重新驗證。");
    }
  }

  const claimed = await claimShareRotation(env.DB, link.id, machineId, now, cooldownMs);
  if (!claimed) {
    const binding = await getShareLinkMachineBinding(env.DB, link.id, machineId);
    const remainingMs = binding?.lastTriggeredAt
      ? binding.lastTriggeredAt + cooldownMs - now
      : 0;
    return errorResponse(429, remainingMs > 0
      ? `更換太頻繁，請約 ${Math.max(1, Math.ceil(remainingMs / 60_000))} 分鐘後再試。`
      : "更換太頻繁，請稍後再試。");
  }

  let awsEnv;
  try {
    if (captchaEnabled && capTokenKey && !await consumeCapToken(env.DB, capTokenKey, now)) {
      // 併發下憑證已被其他請求搶先消費
      return errorResponse(403, "人機驗證已使用，請重新驗證。");
    }
    ({ awsEnv } = await resolveAwsAccount(env, machine.awsAccountId));
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.body.error);
  }

  const cooldownUntil = cooldownMs > 0 ? now + cooldownMs : null;
  return sseResponse(async (emit) => {
    try {
      const { newIpAddress } = await rotatePublicIp(awsEnv, machine, {
        onProgress: (stage, details = {}) => emit("progress", { stage, ...details }),
        waitForNewIp: true,
      });
      try {
        await touchShareLinkUsed(env.DB, link.id);
      } catch {
        // 使用時間更新失敗不影響結果
      }
      if (machine.platform === "ec2" && !machine.isWavelength && machine.ddnsHostname) {
        try {
          const result = await syncMachineDdns(awsEnv, env.DB, machine, { knownIp: newIpAddress });
          if (result.status === "updated" || result.status === "created") {
            try {
              await appendOperationLog(env.DB, {
                action: "ddns-sync",
                region: machine.region,
                instanceId: machine.instanceId,
                status: "success",
                detail: { hostname: result.hostname, ip: result.ip, trigger: "share-rotate" },
                awsAccountId: machine.awsAccountId,
              });
            } catch {
              // 日誌失敗不影響回應
            }
          }
        } catch (error) {
          try {
            await appendOperationLog(env.DB, {
              action: "ddns-sync",
              region: machine.region,
              instanceId: machine.instanceId,
              status: "failure",
              detail: { trigger: "share-rotate", error: error instanceof Error ? error.message : String(error) },
              awsAccountId: machine.awsAccountId,
            });
          } catch {
            // 日誌失敗不影響回應
          }
        }
      }
      try {
        await appendOperationLog(env.DB, {
          action: "share-reboot-ip",
          region: machine.region,
          instanceId: machine.instanceId,
          status: "success",
          detail: { share_link_id: link.id, share_link_name: link.name },
          awsAccountId: machine.awsAccountId,
        });
      } catch {
        // 稽核寫入失敗不掩蓋已完成的換 IP 結果
      }
      emit("result", {
        ok: true,
        machineId,
        newIpAddress,
        cooldownUntil,
        message: newIpAddress
          ? `已更換公網 IP：${newIpAddress}`
          : "已停止並重新啟動；新公網 IP 稍後重新整理即可查看。",
      });
    } catch (error) {
      const rotateError = error as { message?: string; recoveryRequested?: boolean } | null;
      try {
        await appendOperationLog(env.DB, {
          action: "share-reboot-ip",
          region: machine.region,
          instanceId: machine.instanceId,
          status: "failure",
          detail: {
            share_link_id: link.id,
            share_link_name: link.name,
            error: rotateError?.message || String(error),
            recovery_requested: Boolean(rotateError?.recoveryRequested),
          },
          awsAccountId: machine.awsAccountId,
        });
      } catch {
        // 稽核寫入失敗不影響錯誤回報
      }
      emit("error", { error: rotateIpFailureMessage(error) });
    }
  });
}
