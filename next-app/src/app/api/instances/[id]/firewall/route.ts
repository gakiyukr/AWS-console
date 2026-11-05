// POST /api/instances/[id]/firewall：一鍵開防火牆（M5 + Phase 2，SSE 進度）。
// 雲層（Security List 全開）：VNIC → 子網 → 預設安全清單，冪等合併
// TCP／UDP／ICMP（v4+v6）入站與全協定出站。
// 主機層：若 cleanHost 為 true 且執行個體在 RUNNING 狀態，自動透過
// OCI Instance Agent（Run Command）清理主機端 iptables REJECT 規則。
// body: { accountId?, cleanHost? }
import { errorResponse, readJsonBody, sseResponse, toHttpError } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount } from "@/server/utils/oci-account.js";
import { getInstance } from "@/server/utils/oci-compute.js";
import { getPrimaryVnic, openSecurityList } from "@/server/utils/oci-network.js";
import { cleanHostIptables } from "@/server/utils/oci-agent.js";
import { ociRequestJson } from "@/server/utils/oci-request.js";
import { ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 10240;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const { id } = await params;
  const idValidation = validateInput(id, "instanceOcid", "執行個體 OCID");
  if (!idValidation.valid) {
    return errorResponse(400, idValidation.error);
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";
  const shouldCleanHost = body.cleanHost !== false;

  let ctx;
  let displayName = "";
  let instanceState = "";
  let vnicInfo;
  try {
    const resolved = await resolveOciAccount(env, accountId || undefined);
    const instance = await getInstance(resolved, id);
    displayName = String(instance?.displayName || "");
    instanceState = String(instance?.lifecycleState || "").toUpperCase();
    vnicInfo = await getPrimaryVnic(resolved, {
      instanceId: id,
      compartmentOcid: resolved.ociAccount.compartmentOcid,
    });
    if (!vnicInfo) {
      return errorResponse(409, "此執行個體沒有附加的 VNIC。");
    }
    ctx = resolved;
  } catch (error) {
    const httpError = toHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }

  return sseResponse(async (emit) => {
    try {
      // 由 VNIC 的子網取得預設安全清單
      const subnet = await ociRequestJson({
        method: "GET",
        path: `/20160918/subnets/${encodeURIComponent(String(vnicInfo.vnic?.subnetId || ""))}`,
        account: ctx.ociAccount,
        privateKeyPem: ctx.privateKeyPem,
      });
      const securityListId = String(
        subnet?.defaultSecurityListId
        || (Array.isArray(subnet?.securityListIds) ? subnet.securityListIds[0] : "")
        || "",
      );
      if (!securityListId) {
        throw new Error("找不到子網的安全清單，無法設定雲層防火牆。");
      }

      const result = await openSecurityList(
        { account: ctx.ociAccount, privateKeyPem: ctx.privateKeyPem },
        { securityListId, emit },
      );

      const warnings = [...result.warnings];
      let hostCleanSuccess = false;

      // 若指定清理主機端 iptables 且執行個體處於開機狀態，自動以 Cloud Agent 執行清理
      if (shouldCleanHost) {
        if (instanceState === "RUNNING") {
          try {
            emit("progress", { stage: "agent-submit", message: "雲層規則已配置，正在透過 Cloud Agent 清理主機端 iptables…" });
            await cleanHostIptables(
              { account: ctx.ociAccount, privateKeyPem: ctx.privateKeyPem },
              {
                instanceId: id,
                compartmentOcid: ctx.ociAccount.compartmentOcid,
                emit: ({ stage, message }: { stage: string, message: string }) => emit("progress", { stage, message }),
              },
            );
            hostCleanSuccess = true;
          } catch (agentError) {
            const agentErrMsg = ociFailureMessage(agentError);
            warnings.push(`主機端 Cloud Agent 清理未成功（${agentErrMsg}）。雲層規則已生效，其他埠若仍不通請手動於主機端清理 iptables。`);
          }
        } else {
          warnings.push(`執行個體狀態為 ${instanceState}（非開機），已跳過主機端 iptables 清理。請開機後單獨執行「清理主機防火牆」操作。`);
        }
      }

      emit("progress", { stage: "done", message: "防火牆操作完成" });
      emit("result", {
        ok: true,
        added: result.added,
        warnings,
        message: hostCleanSuccess
          ? `安全清單已全開${result.added.length ? `（新增 ${result.added.length} 條雲層規則）` : ""}，主機端 iptables REJECT 規則亦已自動清理！`
          : (result.added.length
              ? `安全清單已全開（新增 ${result.added.length} 條雲層規則）。`
              : "安全清單原本即已全開，未做變更。"),
      });
      try {
        await appendOperationLog(env.DB, {
          action: "open-firewall",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "success",
          detail: {
            added_rules: result.added,
            security_list_id: securityListId,
            host_clean_attempted: shouldCleanHost,
            host_clean_success: hostCleanSuccess,
          },
        });
      } catch {
        // 操作已成功時，稽核日誌失敗不影響結果事件
      }
    } catch (error) {
      const message = ociFailureMessage(error);
      emit("error", { error: message });
      try {
        await appendOperationLog(env.DB, {
          action: "open-firewall",
          ociAccountId: ctx.account.id,
          instanceId: id,
          displayName,
          status: "failure",
          detail: message,
        });
      } catch {
        // 日誌寫入失敗不影響錯誤事件
      }
    }
  });
}
