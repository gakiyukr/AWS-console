// POST /api/lightsail/deploy：以 SSE 串流部署 Lightsail 執行個體。
// 使用與 EC2 相同的共用骨架（deploy-sse-route.js）。
import { createDeploySseRoute } from "@/server/utils/deploy-sse-route.js";
import { deployLightsailInstance } from "@/server/utils/lightsail-deploy.js";

export const POST = createDeploySseRoute({
  action: "deploy_lightsail",
  registrationType: "lightsail",
  fields: [
    ["region", "region", "地區"],
    ["blueprint_id", "string", "作業系統映像"],
    ["bundle_id", "string", "規格方案"],
    ["instance_name", "string", "執行個體名稱"],
  ],
  deploy: deployLightsailInstance as (awsEnv: unknown, body: Record<string, unknown>, onProgress: (stage: string, details?: Record<string, unknown>) => void) => Promise<Record<string, unknown>>,
  successInstanceId: result => (typeof result.instance_id === "string" ? result.instance_id : null),
  failureInstanceId: () => null,
});
