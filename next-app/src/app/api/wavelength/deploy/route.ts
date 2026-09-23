// POST /api/wavelength/deploy：以 SSE 串流部署 Wavelength 執行個體。
// 事件序列：progress…（各階段）→ result（成功）或 error（失敗）。
// 共用骨架見 server/utils/deploy-sse-route.js。
import { createDeploySseRoute } from "@/server/utils/deploy-sse-route.js";
import { deployWavelengthInstance } from "@/server/utils/wavelength.js";

export const POST = createDeploySseRoute({
  action: "deploy_wavelength",
  registrationType: "wavelength",
  fields: [
    ["region", "region", "地區"],
    ["zone", "zone", "Zone ID"],
    ["vpc_id", "vpcId", "VPC ID"],
    ["instance_type", "instanceType", "執行個體類型"],
    ["os", "os", "作業系統"],
  ],
  deploy: deployWavelengthInstance,
  successInstanceId: result => (typeof result.instance_id === "string" ? result.instance_id : null),
  failureInstanceId: () => null,
});
