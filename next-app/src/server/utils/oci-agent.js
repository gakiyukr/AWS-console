// OCI Instance Agent（Run Command）呼叫：主機層指令執行與 iptables 自動化清理。
// 依據 OCI Compute Instance Agent API（version 20180530）實作：
// - CreateInstanceAgentCommand: POST /20180530/instanceAgentCommands
// - GetInstanceAgentCommandExecution: GET /20180530/instanceAgentCommands/{commandId}/instances/{instanceId}
// 所有請求經 oci-request.js 簽章；長操作支援 emit 進度回報與輪詢。
import { ociRequestJson } from "./oci-request.js";
import { OciApiError } from "./oci-error.js";

function request(ctx) {
  return (options) => ociRequestJson({ ...options, account: ctx.account, privateKeyPem: ctx.privateKeyPem });
}

/** 延遲輔助函式 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 產生主機端清理 iptables / ip6tables REJECT 規則的 Shell 腳本。
 * 遵循 OCI 官方最佳實踐：
 * 1. 絕不執行 `iptables -F`（避免誤沖刷 iSCSI 開機磁碟 169.254.0.2:3260 的關鍵鏈導致主機死機）。
 * 2. 針對 Ubuntu (/etc/iptables/rules.v4 & rules.v6) 註解掉 INPUT/FORWARD 的 REJECT 鏈並 reload。
 * 3. 針對 Oracle Linux (/etc/sysconfig/iptables & ip6tables) 註解掉 REJECT 鏈並重載。
 * 4. 針對 firewalld 啟用環境，切換預設 zone 為 trusted。
 * 5. 安全清理記憶體中既有的 REJECT 規則。
 */
export function buildCleanIptablesScript() {
  return `#!/bin/bash
set -u

echo "==> [oci-console] 開始清理主機端 iptables REJECT 規則..."

# 權限判定：ocarun 執行時優先使用 sudo -n（非交談式，避免掛起等待密碼）
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo -n"
else
  SUDO=""
fi

# 1. 處理 Ubuntu / Debian / netfilter-persistent 規則檔
if [ -f /etc/iptables/rules.v4 ]; then
  echo "偵測到 /etc/iptables/rules.v4，註解 REJECT 規則..."
  $SUDO sed -i -E 's/^([[:space:]]*)(-A[[:space:]]+(INPUT|FORWARD)[[:space:]]+.*-j[[:space:]]+REJECT.*)/#\\1\\2/' /etc/iptables/rules.v4 || true
  if command -v iptables-restore >/dev/null 2>&1; then
    $SUDO iptables-restore < /etc/iptables/rules.v4 || true
  fi
fi

if [ -f /etc/iptables/rules.v6 ]; then
  echo "偵測到 /etc/iptables/rules.v6，註解 IPv6 REJECT 規則..."
  $SUDO sed -i -E 's/^([[:space:]]*)(-A[[:space:]]+(INPUT|FORWARD)[[:space:]]+.*-j[[:space:]]+REJECT.*)/#\\1\\2/' /etc/iptables/rules.v6 || true
  if command -v ip6tables-restore >/dev/null 2>&1; then
    $SUDO ip6tables-restore < /etc/iptables/rules.v6 || true
  fi
fi

if command -v netfilter-persistent >/dev/null 2>&1; then
  $SUDO netfilter-persistent reload 2>/dev/null || true
fi

# 2. 處理 Oracle Linux / RHEL / CentOS 規則檔
if [ -f /etc/sysconfig/iptables ]; then
  echo "偵測到 /etc/sysconfig/iptables，註解 REJECT 規則..."
  $SUDO sed -i -E 's/^([[:space:]]*)(-A[[:space:]]+(INPUT|FORWARD)[[:space:]]+.*-j[[:space:]]+REJECT.*)/#\\1\\2/' /etc/sysconfig/iptables || true
  if command -v iptables-restore >/dev/null 2>&1; then
    $SUDO iptables-restore < /etc/sysconfig/iptables || true
  fi
fi

if [ -f /etc/sysconfig/ip6tables ]; then
  echo "偵測到 /etc/sysconfig/ip6tables，註解 IPv6 REJECT 規則..."
  $SUDO sed -i -E 's/^([[:space:]]*)(-A[[:space:]]+(INPUT|FORWARD)[[:space:]]+.*-j[[:space:]]+REJECT.*)/#\\1\\2/' /etc/sysconfig/ip6tables || true
  if command -v ip6tables-restore >/dev/null 2>&1; then
    $SUDO ip6tables-restore < /etc/sysconfig/ip6tables || true
  fi
fi

# 3. 處理 firewalld（若為啟動狀態）
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  echo "偵測到 firewalld 運行中，將預設區域調整為 trusted..."
  $SUDO firewall-cmd --set-default-zone=trusted 2>/dev/null || true
  $SUDO firewall-cmd --reload 2>/dev/null || true
fi

# 4. 精確清理當前執行期殘留的 REJECT 規則（保留 iSCSI / internal 鏈）
for table in iptables ip6tables; do
  if command -v "$table" >/dev/null 2>&1; then
    for chain in INPUT FORWARD; do
      max_loops=30
      while [ $max_loops -gt 0 ]; do
        max_loops=$((max_loops - 1))
        line_num=$($SUDO "$table" -L "$chain" -n --line-numbers 2>/dev/null | grep -E "REJECT" | head -n 1 | awk '{print $1}')
        if [ -n "$line_num" ]; then
          echo "刪除 $table $chain 鏈中 REJECT 規則 #$line_num..."
          $SUDO "$table" -D "$chain" "$line_num" 2>/dev/null || break
        else
          break
        fi
      done
    done
  fi
done

echo "==> [oci-console] 主機端 iptables REJECT 規則清理完畢。"
`;
}

/**
 * 建立並下發 Instance Agent 指令（Run Command）。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{
 *   instanceId: string,
 *   compartmentOcid: string,
 *   scriptText: string,
 *   displayName?: string,
 *   timeoutSeconds?: number,
 * }} options
 * @returns {Promise<any>} 回傳建立的 instanceAgentCommand 物件（含 id）
 */
export async function createInstanceAgentCommand(ctx, {
  instanceId,
  compartmentOcid,
  scriptText,
  displayName = "oci-console-clean-iptables",
  timeoutSeconds = 60,
}) {
  const api = request(ctx);
  return api({
    method: "POST",
    path: "/20180530/instanceAgentCommands",
    body: {
      compartmentId: compartmentOcid,
      displayName,
      executionTimeOutInSeconds: timeoutSeconds,
      target: {
        instanceId,
      },
      content: {
        source: {
          sourceType: "TEXT",
          text: scriptText,
        },
        output: {
          outputType: "TEXT",
        },
      },
    },
  });
}

/**
 * 查詢特定執行個體上的指令執行狀態。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{ commandId: string, instanceId: string }} options
 * @returns {Promise<any>} 回傳 InstanceAgentCommandExecution 物件
 */
export async function getInstanceAgentCommandExecution(ctx, { commandId, instanceId }) {
  const api = request(ctx);
  return api({
    method: "GET",
    path: `/20180530/instanceAgentCommands/${encodeURIComponent(commandId)}/instances/${encodeURIComponent(instanceId)}`,
  });
}

/**
 * 輪詢指令執行狀態直到結束或逾時。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{ commandId: string, instanceId: string, emit?: Function, maxAttempts?: number, pollIntervalMs?: number }} options
 */
export async function pollCommandExecution(ctx, {
  commandId,
  instanceId,
  emit,
  maxAttempts = 15,
  pollIntervalMs = 3000,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let execution;
    try {
      execution = await getInstanceAgentCommandExecution(ctx, { commandId, instanceId });
    } catch (error) {
      // 剛送出前幾秒可能回 404 NotAuthorizedOrNotFound（Agent 尚未向中心回報），容忍前三次重試
      if (attempt <= 3 && error instanceof OciApiError && error.status === 404) {
        emit?.({ stage: "agent-exec", message: `等待 Cloud Agent 接收指令（重試 ${attempt}/${maxAttempts}）…` });
        await delay(pollIntervalMs);
        continue;
      }
      throw error;
    }

    const lifecycleState = String(execution?.lifecycleState || "").toUpperCase();
    const deliveryState = String(execution?.deliveryState || "").toUpperCase();

    if (lifecycleState === "SUCCEEDED") {
      const exitCode = typeof execution?.exitCode === "number" ? execution.exitCode : 0;
      if (exitCode === 0) {
        return {
          ok: true,
          lifecycleState,
          deliveryState,
          exitCode,
          output: execution?.content?.text || execution?.message || "指令執行成功",
        };
      }
      throw new OciApiError(`主機端腳本執行失敗（離開代碼：${exitCode}）：${execution?.content?.text || execution?.message || ""}`, 500);
    }

    if (lifecycleState === "FAILED") {
      throw new OciApiError(`Cloud Agent 執行失敗：${execution?.message || execution?.content?.text || "未知原因"}`, 500);
    }

    if (lifecycleState === "TIMED_OUT") {
      throw new OciApiError("Cloud Agent 執行逾時（主機端未能在時限內完成）", 504);
    }

    if (lifecycleState === "CANCELED") {
      throw new OciApiError("Cloud Agent 指令已被取消", 409);
    }

    emit?.({
      stage: "agent-exec",
      message: `主機端執行中（狀態：${lifecycleState || deliveryState || "處理中"}，第 ${attempt}/${maxAttempts} 次檢查）…`,
    });

    await delay(pollIntervalMs);
  }

  throw new OciApiError("等待 Cloud Agent 執行結果逾時，請至 OCI 主控台或稍後於主機端確認狀態。", 504);
}

/**
 * 完整執行主機端 iptables 清理流程（長操作，支援 SSE 進度推送）。
 * @param {{ account: object, privateKeyPem: string }} ctx
 * @param {{
 *   instanceId: string,
 *   compartmentOcid: string,
 *   emit?: (progress: { stage: string, message: string }) => void,
 *   timeoutSeconds?: number,
 * }} options
 */
export async function cleanHostIptables(ctx, {
  instanceId,
  compartmentOcid,
  emit,
  timeoutSeconds = 60,
}) {
  emit?.({ stage: "agent-submit", message: "產生清理腳本並向 Oracle Cloud Agent 下發指令…" });

  const scriptText = buildCleanIptablesScript();
  const command = await createInstanceAgentCommand(ctx, {
    instanceId,
    compartmentOcid,
    scriptText,
    displayName: `clean-iptables-${Date.now().toString(36)}`,
    timeoutSeconds,
  });

  const commandId = String(command?.id || "");
  if (!commandId) {
    throw new OciApiError("建立 Cloud Agent 指令失敗：未回傳指令 OCID", 500);
  }

  emit?.({ stage: "agent-exec", message: "指令已下發至 Cloud Agent，等待主機端回報…" });

  const result = await pollCommandExecution(ctx, {
    commandId,
    instanceId,
    emit,
  });

  return {
    ok: true,
    commandId,
    output: result.output,
  };
}
