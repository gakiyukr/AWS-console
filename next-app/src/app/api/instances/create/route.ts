// POST /api/instances/create：建立執行個體（LaunchInstance）。
// 回應為 PROVISIONING 過渡態；前端輪詢 GET /api/instances/[id] 直到 RUNNING。
// 需要的 IAM：manage instance-family + virtual-network-family（PLAN §8）。
import { errorResponse, jsonResponse, readJsonBody } from "@/server/utils/http.js";
import { validateInput } from "@/server/utils/validate.js";
import { resolveOciAccount, toOciAccountHttpError } from "@/server/utils/oci-account.js";
import { launchInstance } from "@/server/utils/oci-launch.js";
import { enableInstanceIpv6, getPrimaryVnic } from "@/server/utils/oci-network.js";
import { OciApiError, ociFailureMessage } from "@/server/utils/oci-error.js";
import { appendOperationLog } from "@/server/utils/db.js";
import { getEnv } from "@/server/env";
import { requireApiSession } from "@/server/api-guard";

const MAX_BODY_BYTES = 20480;
const MIN_BOOT_VOLUME_GB = 50;
const MAX_BOOT_VOLUME_GB = 200;
// Always Free A1.Flex 的合理設定範圍；其他 Flex shape 放寬（OCI 端仍會驗證）
const A1_MAX_OCPUS = 4;
const A1_MAX_MEMORY_GB = 24;

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const env = await getEnv();

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, "請求內容過大。");
  }
  const body = /** @type {Record<string, unknown>} */ (await readJsonBody(request)) ?? {};
  const accountId = typeof body.accountId === "string" || typeof body.accountId === "number"
    ? String(body.accountId)
    : "";

  // ─── 輸入驗證 ───────────────────────────────────────────────
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName || displayName.length > 255) {
    return errorResponse(400, "名稱必須為 1 至 255 個字元");
  }
  const availabilityDomain = typeof body.availabilityDomain === "string" ? body.availabilityDomain.trim() : "";
  if (!availabilityDomain || availabilityDomain.length > 255) {
    return errorResponse(400, "Availability Domain 格式無效");
  }
  const shape = typeof body.shape === "string" ? body.shape.trim() : "";
  const shapeValidation = validateInput(shape, "shape", "Shape");
  if (!shapeValidation.valid) {
    return errorResponse(400, shapeValidation.error);
  }
  const imageOcid = typeof body.imageOcid === "string" ? body.imageOcid.trim() : "";
  const imageValidation = validateInput(imageOcid, "ocid", "映像 OCID");
  if (!imageValidation.valid) {
    return errorResponse(400, "映像 OCID 格式無效");
  }
  const subnetOcid = typeof body.subnetOcid === "string" ? body.subnetOcid.trim() : "";
  const subnetValidation = validateInput(subnetOcid, "ocid", "子網 OCID");
  if (!subnetValidation.valid) {
    return errorResponse(400, "子網 OCID 格式無效");
  }
  const sshPublicKey = typeof body.sshPublicKey === "string" ? body.sshPublicKey.trim() : "";
  if (!sshPublicKey.startsWith("ssh-") || sshPublicKey.length > 4096) {
    return errorResponse(400, "SSH 公鑰格式無效（需為 OpenSSH 格式：ssh-ed25519 / ssh-rsa 開頭）");
  }
  const bootVolumeSizeInGBs = Number(body.bootVolumeSizeInGBs ?? 50);
  if (!Number.isInteger(bootVolumeSizeInGBs) || bootVolumeSizeInGBs < MIN_BOOT_VOLUME_GB || bootVolumeSizeInGBs > MAX_BOOT_VOLUME_GB) {
    return errorResponse(400, `開機磁碟大小須為 ${MIN_BOOT_VOLUME_GB}–${MAX_BOOT_VOLUME_GB} GB`);
  }
  const assignPublicIp = body.assignPublicIp !== false;
  // 開機即啟用 IPv6：launch 成功後對 primary VNIC 執行完整開通（冪等）
  const enableIpv6 = body.ipv6 === true;

  let ocpus: number | undefined;
  let memoryInGBs: number | undefined;
  if (shape.endsWith(".Flex")) {
    ocpus = Number(body.ocpus ?? 1);
    memoryInGBs = Number(body.memoryInGBs ?? 6);
    const maxOcpus = shape === "VM.Standard.A1.Flex" ? A1_MAX_OCPUS : 64;
    const maxMemory = shape === "VM.Standard.A1.Flex" ? A1_MAX_MEMORY_GB : 1024;
    if (!Number.isInteger(ocpus) || ocpus < 1 || ocpus > maxOcpus) {
      return errorResponse(400, `OCPU 數須為 1–${maxOcpus}`);
    }
    if (!Number.isInteger(memoryInGBs) || memoryInGBs < 1 || memoryInGBs > maxMemory) {
      return errorResponse(400, `記憶體須為 1–${maxMemory} GB`);
    }
  }

  // ─── 組 LaunchInstanceDetails 並送出 ────────────────────────
  try {
    const { account, ociAccount, privateKeyPem } = await resolveOciAccount(env, accountId || undefined);
    const instance = await launchInstance(
      { account: ociAccount, privateKeyPem },
      {
        availabilityDomain,
        compartmentId: ociAccount.compartmentOcid,
        displayName,
        shape,
        ...(shape.endsWith(".Flex") ? { shapeConfig: { ocpus, memoryInGBs } } : {}),
        sourceDetails: {
          sourceType: "image",
          imageId: imageOcid,
          bootVolumeSizeInGBs,
        },
        createVnicDetails: {
          subnetId: subnetOcid,
          assignPublicIp,
        },
        metadata: {
          ssh_authorized_keys: sshPublicKey,
        },
        freeformTags: {
          managedBy: "oci-console",
        },
      },
    );

    const instanceId = String(instance?.id || "");
    let ipv6Warning: string | null = null;
    let ipv6Address = "";
    if (enableIpv6) {
      try {
        // primary VNIC 於 launch 後數秒內出現；輪詢等待後執行冪等開通
        let vnicInfo = null;
        for (let attempt = 0; attempt < 12 && !vnicInfo; attempt += 1) {
          vnicInfo = await getPrimaryVnic(
            { account: ociAccount, privateKeyPem },
            { instanceId, compartmentOcid: ociAccount.compartmentOcid },
          );
          if (!vnicInfo) {
            await new Promise(resolve => setTimeout(resolve, 5_000));
          }
        }
        if (!vnicInfo) {
          throw new Error("等待 primary VNIC 逾時");
        }
        const v6Result = await enableInstanceIpv6(
          { account: ociAccount, privateKeyPem },
          {
            compartmentOcid: ociAccount.compartmentOcid,
            vnicId: vnicInfo.vnicId,
            vnic: vnicInfo.vnic,
            emit: () => {},
          },
        );
        ipv6Address = v6Result.ipv6Address;
        if (v6Result.warnings.length > 0) {
          ipv6Warning = v6Result.warnings.join("；");
        }
      } catch (error) {
        ipv6Warning = `IPv6 開通失敗（執行個體已建立）：${error instanceof Error ? error.message : String(error)}；可稍後用總覽頁的 IPv6 按鈕重試。`;
      }
    }
    try {
      await appendOperationLog(env.DB, {
        action: "create-instance",
        ociAccountId: account.id,
        instanceId,
        displayName,
        status: "success",
        detail: {
          shape,
          availability_domain: availabilityDomain,
          image: imageOcid,
          subnet: subnetOcid,
          boot_volume_gb: bootVolumeSizeInGBs,
          ocpus: ocpus ?? null,
          memory_gb: memoryInGBs ?? null,
        },
      });
    } catch {
      // 建立已成功時，稽核日誌失敗不影響結果
    }

    return jsonResponse({
      ok: true,
      instanceId,
      displayName,
      lifecycleState: String(instance?.lifecycleState || "PROVISIONING"),
      ...(enableIpv6 ? { ipv6Address: ipv6Address || null } : {}),
      ...(ipv6Warning ? { ipv6Warning } : {}),
      message: ipv6Warning
        ? `「${displayName}」建立中（PROVISIONING）；${ipv6Warning}`
        : ipv6Address
          ? `「${displayName}」建立中（PROVISIONING），IPv6 已指派：${ipv6Address}`
          : `「${displayName}」建立中（PROVISIONING），總覽頁會自動更新狀態。`,
    });
  } catch (error) {
    if (error instanceof OciApiError) {
      try {
        await appendOperationLog(env.DB, {
          action: "create-instance",
          ociAccountId: null,
          instanceId: null,
          displayName,
          status: "failure",
          detail: ociFailureMessage(error),
        });
      } catch {
        // 日誌寫入失敗不影響錯誤回應
      }
      return errorResponse(error.statusCode, ociFailureMessage(error));
    }
    const httpError = toOciAccountHttpError(error);
    return errorResponse(httpError.status, httpError.status === 500 ? ociFailureMessage(error) : httpError.body.error);
  }
}
