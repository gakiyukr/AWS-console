// 部署流程與機器總覽的整合層：將新建立的執行個體登錄到 D1，
// 讓既有的電源管理功能能立即接管 Wavelength、區域 EC2 與 forwarder。
import { createMachine } from "./db.js";

function addCandidate(candidates, instanceId, isWavelength) {
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    return;
  }
  if (candidates.some((candidate) => candidate.instanceId === instanceId)) {
    return;
  }
  candidates.push({ instanceId, isWavelength });
}

/**
 * 依部署結果找出應納入電源管理清單的執行個體。
 * forwarder 流程同時保留目標 Wavelength 執行個體與新建立的區域型 forwarder。
 */
export function collectDeploymentMachines(deploymentType, result) {
  const candidates = [];

  switch (deploymentType) {
    case "wavelength":
      addCandidate(candidates, result?.instance_id, true);
      addCandidate(candidates, result?.forwarder?.instance_id, false);
      break;
    case "regional":
      addCandidate(candidates, result?.instance_id, false);
      break;
    case "forwarder":
      addCandidate(candidates, result?.target_instance_id, true);
      addCandidate(candidates, result?.forwarder?.instance_id, false);
      break;
    default:
      throw new Error("不支援的部署類型");
  }

  return candidates;
}

/**
 * 登錄部署產生的執行個體。資料庫同步失敗不能掩蓋 AWS 已成功建立資源的結果，
 * 因此逐筆回報登錄狀態，並交由呼叫端在 SSE 結果中揭露。
 */
export async function registerDeploymentMachines(db, deploymentType, region, result, awsAccountId = null) {
  const candidates = collectDeploymentMachines(deploymentType, result);

  if (!db) {
    return candidates.map((candidate) => ({
      ...candidate,
      registration: "unavailable",
    }));
  }

  return Promise.all(candidates.map(async (candidate) => {
    try {
      const created = await createMachine(db, {
        awsAccountId,
        region,
        instanceId: candidate.instanceId,
        // 留空可在首次狀態同步時採用 AWS 的 Name 標籤。
        name: "",
        isWavelength: candidate.isWavelength,
      });
      return {
        ...candidate,
        registration: created ? "created" : "existing",
        ...(created ? { id: created.id } : {}),
      };
    } catch {
      return {
        ...candidate,
        registration: "failed",
      };
    }
  }));
}
