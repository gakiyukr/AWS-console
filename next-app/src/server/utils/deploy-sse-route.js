// SSE 部署路由的共用骨架：三條部署路由（一般 EC2、Wavelength、
// 既有 WL 附加 forwarder）原本各自複製同一段約 60 行的編排——
// 驗證輸入 → 解析憑證 → 解析 AWS 帳號 → 串流部署 → 登錄機器 →
// 剝除敏感欄位寫入稽核 → emit result／error。
// 差異僅在部署函式、驗證欄位、日誌 action 與登錄類型，故集中於此，
// 讓日誌語意或錯誤處理的變更只需改一處。
import { requireApiSession } from "../api-guard";
import { getEnv } from "../env";
import { resolveAwsAccount } from "./aws-account.js";
import { appendOperationLog } from "./db.js";
import { resolveRequestCredential } from "./deploy-credential.js";
import { registerDeploymentMachines } from "./deployment-registration.js";
import { summarizeDeployResult } from "./deploy-log.js";
import { errorResponse, jsonResponse, readJsonBody, sseResponse, toHttpError } from "./http.js";
import { validateInput } from "./validate.js";

/**
 * @typedef {object} DeploySseRouteOptions
 * @property {string} action 操作日誌的 action 名稱，例如 deploy_regional
 * @property {string} registrationType 機器登錄類型，傳給 registerDeploymentMachines
 * @property {ReadonlyArray<readonly [string, string, string]>} fields 驗證欄位：
 *   [body 的鍵名, 驗證器類型, 錯誤訊息中的欄位名稱]
 * @property {(awsEnv: unknown, body: Record<string, unknown>,
 *   onProgress: (stage: string, details?: Record<string, unknown>) => void)
 *   => Promise<Record<string, unknown>>} deploy 實際執行部署的業務函式
 * @property {(result: Record<string, unknown>, body: Record<string, unknown>) => string | null}
 *   successInstanceId 成功時寫入日誌的 instanceId（各部署結果欄位位置不同）
 * @property {(body: Record<string, unknown>) => string | null} failureInstanceId
 *   失敗時寫入日誌的 instanceId
 */

/**
 * 建立一條部署路由的 POST handler。
 * 回傳的函式即 Next.js Route Handler，可直接 export 為 POST。
 * @param {DeploySseRouteOptions} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createDeploySseRoute(options) {
  return async function POST(request) {
    const denied = await requireApiSession(request);
    if (denied) return denied;

    const env = await getEnv();
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") {
      return errorResponse(400, "請求內容無效。");
    }

    for (const [key, type, label] of options.fields) {
      const validation = validateInput(body[key], type, label);
      if (!validation.valid) {
        return errorResponse(400, validation.error);
      }
    }

    const credentialResolution = await resolveRequestCredential(env.DB, body);
    if (credentialResolution.error) {
      return errorResponse(400, credentialResolution.error);
    }
    body.credential = credentialResolution.credential;

    let accountContext;
    try {
      accountContext = await resolveAwsAccount(env, body.account_id);
    } catch (error) {
      const httpError = toHttpError(error);
      return jsonResponse(httpError.body, { status: httpError.status });
    }
    const { account, awsEnv } = accountContext;

    return sseResponse(async (emit) => {
      try {
        const result = await options.deploy(awsEnv, body, (stage, details = {}) => {
          emit("progress", { stage, ...details });
        });
        const management = await registerDeploymentMachines(
          env.DB,
          options.registrationType,
          body.region,
          result,
          account.id,
        );
        const response = { ...result, management };
        await writeLog(env.DB, {
          action: options.action,
          region: body.region,
          instanceId: options.successInstanceId(result, body),
          status: "success",
          detail: summarizeDeployResult(response),
          awsAccountId: account.id,
        });
        emit("result", response);
      } catch (error) {
        const httpError = toHttpError(error);
        await writeLog(env.DB, {
          action: options.action,
          region: body.region,
          instanceId: options.failureInstanceId(body),
          status: "failure",
          detail: httpError.body?.error || String(error),
          awsAccountId: account.id,
        });
        emit("error", httpError.body);
      }
    });
  };
}

/**
 * 稽核寫入失敗不可掩蓋 AWS 已完成的部署結果，故一律吞掉錯誤；
 * 包成函式讓三條路由不必各自重複 try/catch。
 * @param {D1Database} db
 * @param {Record<string, unknown>} entry
 */
async function writeLog(db, entry) {
  try {
    await appendOperationLog(db, entry);
  } catch {
    // 日誌寫入失敗不影響部署結果
  }
}
