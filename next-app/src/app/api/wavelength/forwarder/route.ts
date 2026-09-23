// POST /api/wavelength/forwarder：以 SSE 串流為既有 Wavelength 執行個體
// 部署區域型 forwarder（一般區域 t3.nano + iptables 轉送）。
// 事件序列與 deploy 相同：progress… → result|error。
// 共用骨架見 server/utils/deploy-sse-route.js。
import { createDeploySseRoute } from "@/server/utils/deploy-sse-route.js";
import { deployForwarderForExistingWavelengthInstance } from "@/server/utils/wavelength.js";

export const POST = createDeploySseRoute({
  action: "deploy_forwarder",
  registrationType: "forwarder",
  fields: [
    ["region", "region", "地區"],
    ["zone", "zone", "Zone ID"],
    ["vpc_id", "vpcId", "VPC ID"],
    ["instance_id", "instanceId", "執行個體 ID"],
    ["os", "os", "作業系統"],
  ],
  deploy: deployForwarderForExistingWavelengthInstance,
  // 成功時優先記 forwarder 本身，其次記目標執行個體
  successInstanceId: (result) => {
    const forwarder = result.forwarder;
    if (forwarder && typeof forwarder === "object" && "instance_id" in forwarder) {
      const id = forwarder.instance_id;
      if (typeof id === "string") return id;
    }
    return typeof result.target_instance_id === "string" ? result.target_instance_id : null;
  },
  failureInstanceId: body => (typeof body.instance_id === "string" ? body.instance_id : null),
});
