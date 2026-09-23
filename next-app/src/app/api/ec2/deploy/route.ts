// POST /api/ec2/deploy：以 SSE 串流部署一般區域 EC2。
// 共用骨架見 server/utils/deploy-sse-route.js。
// 注意：一般 EC2 部署與 Wavelength 共用部署骨架，故業務函式位於 wavelength.js。
import { createDeploySseRoute } from "@/server/utils/deploy-sse-route.js";
import { deployRegionalEc2Instance } from "@/server/utils/wavelength.js";

export const POST = createDeploySseRoute({
  action: "deploy_regional",
  registrationType: "regional",
  fields: [
    ["region", "region", "地區"],
    ["vpc_id", "vpcId", "VPC ID"],
    ["os", "os", "作業系統"],
  ],
  deploy: deployRegionalEc2Instance,
  successInstanceId: result => (typeof result.instance_id === "string" ? result.instance_id : null),
  failureInstanceId: () => null,
});
