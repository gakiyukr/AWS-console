'use client'

// 建立執行個體（Phase 2）：單頁表單——名稱／AD／shape（Flex 需 ocpu／記憶體）／
// 映像（依 shape 相容清單，前端依 OS 分組）／開機磁碟／VCN 子網／SSH 公鑰。
// 送出後為 PROVISIONING 過渡態，總覽頁會自動輪詢到 RUNNING。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@/components/chip";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { CustomSelect } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface OciAccountOption {
  id: number
  name: string
  region: string
}

interface CreateOptions {
  availabilityDomains: Array<{ name: string }>
  shapes: Array<{ shape: string, isFlex: boolean, defaultOcpus: number, defaultMemoryInGBs: number }>
  networks: Array<{
    vcnId: string
    vcnName: string
    cidrBlock: string
    subnets: Array<{
      id: string
      displayName: string
      cidrBlock: string
      prohibitPublicIpOnLaunch: boolean
    }>
  }>
  compartmentOcid: string
  region: string
}

interface OciImage {
  id: string
  displayName: string
  os: string
  osVersion: string
  sizeInGBs: number
  timeCreated: string | null
}

// Always Free 形狀的提示徽章
const FREE_SHAPES = new Set(["VM.Standard.A1.Flex", "VM.Standard.E2.1.Micro"]);
const FREE_TIER_HINTS: Record<string, string> = {
  "VM.Standard.A1.Flex": "Always Free：帳號內合計最多 4 OCPU / 24 GB 記憶體",
  "VM.Standard.E2.1.Micro": "Always Free：每月 2 台（x86 微型）",
};

const DEFAULT_BOOT_VOLUME_GB = 50;
const MAX_BOOT_VOLUME_GB = 200;

export default function NewInstancePage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<OciAccountOption[]>([]);
  const [accountId, setAccountId] = useState("");
  const [options, setOptions] = useState<CreateOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [images, setImages] = useState<OciImage[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [ad, setAd] = useState("");
  const [shape, setShape] = useState("");
  const [ocpus, setOcpus] = useState(1);
  const [memoryInGBs, setMemoryInGBs] = useState(6);
  const [imageOs, setImageOs] = useState("");
  const [imageVersion, setImageVersion] = useState("");
  const [imageId, setImageId] = useState("");
  const [bootVolumeGB, setBootVolumeGB] = useState(DEFAULT_BOOT_VOLUME_GB);
  const [vcnId, setVcnId] = useState("");
  const [subnetId, setSubnetId] = useState("");
  const [assignPublicIp, setAssignPublicIp] = useState(true);
  const [sshPublicKey, setSshPublicKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/oci-accounts");
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ accounts: OciAccountOption[] }>(response);
      setAccounts(payload.accounts);
      return payload.accounts;
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入 OCI 帳號失敗");
      return [];
    }
  }, []);

  const loadOptions = useCallback(async (targetAccountId: string) => {
    setOptionsLoading(true);
    setImages([]);
    try {
      const query = targetAccountId ? `?account_id=${targetAccountId}` : "";
      const response = await fetch(`/api/instances/create-options${query}`);
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<CreateOptions>(response);
      setOptions(payload);

      // 預設值：第一個 AD；shape 優先 A1.Flex，其次 E2.1.Micro，最後第一個
      const firstAd = payload.availabilityDomains[0]?.name || "";
      setAd(firstAd);
      const preferredShape
        = payload.shapes.find(item => item.shape === "VM.Standard.A1.Flex")
          ?? payload.shapes.find(item => FREE_SHAPES.has(item.shape))
          ?? payload.shapes[0];
      if (preferredShape) {
        setShape(preferredShape.shape);
        setOcpus(preferredShape.isFlex ? Math.min(preferredShape.defaultOcpus || 1, 4) : 1);
        setMemoryInGBs(preferredShape.isFlex ? Math.min(Math.max(preferredShape.defaultMemoryInGBs || 6, 1), 24) : preferredShape.defaultMemoryInGBs || 1);
      }
      // 預設網路：第一個有子網的 VCN → 第一個（可配公網 IP 的）子網
      const firstNetwork = payload.networks.find(network => network.subnets.length > 0);
      if (firstNetwork) {
        setVcnId(firstNetwork.vcnId);
        const preferredSubnet = firstNetwork.subnets.find((subnet: { prohibitPublicIpOnLaunch: boolean }) => !subnet.prohibitPublicIpOnLaunch) ?? firstNetwork.subnets[0];
        setSubnetId(preferredSubnet.id);
        setAssignPublicIp(!preferredSubnet.prohibitPublicIpOnLaunch);
      } else {
        setVcnId("");
        setSubnetId("");
      }
      return preferredShape?.shape || "";
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入建機選項失敗");
      return "";
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  const loadImages = useCallback(async (targetAccountId: string, targetShape: string) => {
    if (!targetShape) return;
    setImagesLoading(true);
    try {
      const params = new URLSearchParams({ shape: targetShape });
      if (targetAccountId) params.set("account_id", targetAccountId);
      const response = await fetch(`/api/instances/create-options/images?${params.toString()}`);
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ images: OciImage[] }>(response);
      setImages(payload.images);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入映像清單失敗");
    } finally {
      setImagesLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const loaded = await loadAccounts();
      if (cancelled) return;
      const defaultId = loaded[0]?.id;
      if (typeof defaultId === "number") {
        setAccountId(String(defaultId));
        await loadOptions(String(defaultId));
      } else {
        setOptionsLoading(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // shape 變更 → 重載映像並重設選擇
  useEffect(() => {
    if (!shape || !accountId) return;
    let cancelled = false;
    async function reload() {
      await loadImages(accountId, shape);
      if (cancelled) return;
      setImageOs("");
      setImageVersion("");
      setImageId("");
    }
    void reload();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // 映像 OS 分組（不對 OS 名稱寫死）
  const osList = useMemo(() => {
    const seen = new Map<string, number>();
    for (const image of images) {
      if (image.os) seen.set(image.os, (seen.get(image.os) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([os]) => os);
  }, [images]);

  // 未（或尚不可）選擇時以 render 派生預設值，避免 effect 內同步 setState
  const effectiveOs = imageOs && osList.includes(imageOs)
    ? imageOs
    : (osList.find(os => os.includes("Ubuntu")) || osList[0] || "");
  const versionList = useMemo(() => {
    const seen = new Set<string>();
    for (const image of images) {
      if (image.os === effectiveOs && image.osVersion) seen.add(image.osVersion);
    }
    return [...seen];
  }, [images, effectiveOs]);
  const effectiveVersion = imageVersion && versionList.includes(imageVersion)
    ? imageVersion
    : (versionList[0] || "");
  const variantList = useMemo(
    () => images.filter(image => image.os === effectiveOs && image.osVersion === effectiveVersion),
    [images, effectiveOs, effectiveVersion],
  );
  const effectiveImageId = imageId && variantList.some(image => image.id === imageId)
    ? imageId
    : (variantList[0]?.id || "");

  const selectedImage = images.find(image => image.id === effectiveImageId) || null;
  const selectedShape = options?.shapes.find(item => item.shape === shape) || null;
  const selectedVcn = options?.networks.find(network => network.vcnId === vcnId) || null;
  const selectedSubnet = selectedVcn?.subnets.find(subnet => subnet.id === subnetId) || null;
  // 私有子網無法配公網 IP
  const canAssignPublicIp = Boolean(selectedSubnet && !selectedSubnet.prohibitPublicIpOnLaunch);
  const minBootGB = Math.max(DEFAULT_BOOT_VOLUME_GB, selectedImage?.sizeInGBs ? selectedImage.sizeInGBs + 1 : DEFAULT_BOOT_VOLUME_GB);

  function onVcnChange(nextVcnId: string) {
    setVcnId(nextVcnId);
    const network = options?.networks.find(item => item.vcnId === nextVcnId);
    const preferredSubnet = network?.subnets.find(subnet => !subnet.prohibitPublicIpOnLaunch) ?? network?.subnets[0];
    setSubnetId(preferredSubnet?.id || "");
    setAssignPublicIp(preferredSubnet ? !preferredSubnet.prohibitPublicIpOnLaunch : true);
  }

  function onSubnetChange(nextSubnetId: string) {
    setSubnetId(nextSubnetId);
    const subnet = selectedVcn?.subnets.find(item => item.id === nextSubnetId);
    setAssignPublicIp(subnet ? !subnet.prohibitPublicIpOnLaunch : true);
  }

  const sshKeyValid = /^\s*ssh-(ed25519|rsa|dss|ecdsa)\b/.test(sshPublicKey) || /^\s*ecdsa-sha2-\b/.test(sshPublicKey);
  const canSubmit = Boolean(
    accountId
    && displayName
    && ad
    && shape
    && effectiveImageId
    && subnetId
    && sshKeyValid
    && bootVolumeGB >= minBootGB
    && bootVolumeGB <= MAX_BOOT_VOLUME_GB
    && !submitting,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/instances/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          displayName,
          availabilityDomain: ad,
          shape,
          ...(selectedShape?.isFlex ? { ocpus, memoryInGBs } : {}),
          imageOcid: effectiveImageId,
          bootVolumeSizeInGBs: bootVolumeGB,
          subnetOcid: subnetId,
          assignPublicIp: canAssignPublicIp ? assignPublicIp : false,
          sshPublicKey,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ message?: string }>(response);
      toast.success(payload.message || "建立已送出");
      router.push("/instances");
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "建立執行個體失敗");
      setSubmitting(false);
    }
  }



  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link href="/instances" aria-label="回執行個體總覽" className="text-muted hover:text-foreground">
          <ArrowLeft aria-hidden size={20} />
        </Link>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">建立執行個體</h2>
          <p className="text-sm text-muted">
            {options ? `${options.region} · compartment 即時選項` : "載入 compartment 選項中"}
          </p>
        </div>
      </div>

      {accounts.length === 0 && !optionsLoading ? (
        <Card>
          <Card.Content className="grid gap-2 p-8 text-center">
            <p className="text-sm text-muted">尚未設定 OCI 帳號。</p>
            <div><Link href="/accounts" className="text-sm underline underline-offset-4">前往帳號管理新增</Link></div>
          </Card.Content>
        </Card>
      ) : (
        <form className="grid gap-4" onSubmit={submit}>
          {/* 基本設定 */}
          <Card>
            <Card.Content className="grid gap-4 p-6">
              <h3 className="text-base font-semibold">基本設定</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label htmlFor="new-account" className="text-sm font-medium">OCI 帳號</label>
                  <CustomSelect
                    id="new-account"
                    value={accountId}
                    placeholder="請選擇 OCI 帳號"
                    disabled={optionsLoading || submitting}
                    options={accounts.map(account => ({
                      value: String(account.id),
                      label: account.name,
                    }))}
                    onChange={async val => {
                      setAccountId(val);
                      await loadOptions(val);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="new-name" className="text-sm font-medium">名稱</Label>
                  <Input
                    id="new-name"
                    placeholder="my-a1-instance"
                    value={displayName}
                    onChange={event => setDisplayName(event.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="new-ad" className="text-sm font-medium">Availability Domain</label>
                  <CustomSelect
                    id="new-ad"
                    value={ad}
                    placeholder="請選擇 Availability Domain"
                    disabled={submitting || optionsLoading}
                    options={(options?.availabilityDomains || []).map(domain => ({
                      value: domain.name,
                      label: domain.name,
                    }))}
                    onChange={setAd}
                  />
                </div>
              </div>
            </Card.Content>
          </Card>

          {/* Shape 與映像 */}
          <Card>
            <Card.Content className="grid gap-4 p-6">
              <h3 className="text-base font-semibold">Shape 與映像</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label htmlFor="new-shape" className="text-sm font-medium">Shape</label>
                  <CustomSelect
                    id="new-shape"
                    value={shape}
                    placeholder="請選擇 Shape"
                    disabled={submitting || optionsLoading}
                    options={(options?.shapes || []).map(item => ({
                      value: item.shape,
                      label: item.shape,
                    }))}
                    onChange={setShape}
                  />
                  {FREE_TIER_HINTS[shape] ? (
                    <p className="text-xs text-muted">
                      <Chip variant="secondary" size="sm">Always Free</Chip>{" "}{FREE_TIER_HINTS[shape]}
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-2" />
                {selectedShape?.isFlex ? (
                  <>
                    <div className="grid gap-2">
                      <Label htmlFor="new-ocpus" className="text-sm font-medium">OCPU</Label>
                      <Input
                        id="new-ocpus"
                        type="number"
                        min={1}
                        max={shape === "VM.Standard.A1.Flex" ? 4 : 64}
                        value={ocpus}
                        onChange={event => setOcpus(Number(event.target.value))}
                        disabled={submitting}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="new-memory" className="text-sm font-medium">記憶體（GB）</Label>
                      <Input
                        id="new-memory"
                        type="number"
                        min={1}
                        max={shape === "VM.Standard.A1.Flex" ? 24 : 1024}
                        value={memoryInGBs}
                        onChange={event => setMemoryInGBs(Number(event.target.value))}
                        disabled={submitting}
                      />
                    </div>
                  </>
                ) : null}
                <div className="grid gap-2 sm:col-span-2">
                  <label htmlFor="new-image-os" className="text-sm font-medium">作業系統</label>
                  <CustomSelect
                    id="new-image-os"
                    value={imageOs}
                    placeholder="請選擇作業系統"
                    disabled={submitting || imagesLoading || osList.length === 0}
                    options={osList.map(os => ({ value: os, label: os }))}
                    onChange={val => {
                      setImageOs(val);
                      setImageVersion("");
                      setImageId("");
                    }}
                  />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <label htmlFor="new-image-version" className="text-sm font-medium">版本</label>
                  <CustomSelect
                    id="new-image-version"
                    value={effectiveVersion}
                    placeholder="請選擇版本"
                    disabled={submitting || imagesLoading || versionList.length === 0}
                    options={versionList.map(version => ({ value: version, label: version }))}
                    onChange={val => {
                      setImageVersion(val);
                      setImageId("");
                    }}
                  />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <label htmlFor="new-image" className="text-sm font-medium">映像</label>
                  <CustomSelect
                    id="new-image"
                    value={effectiveImageId}
                    placeholder={imagesLoading ? "載入映像清單中..." : "請選擇映像"}
                    disabled={submitting || imagesLoading || variantList.length === 0}
                    options={variantList.map(image => ({
                      value: image.id,
                      label: image.displayName,
                    }))}
                    onChange={setImageId}
                  />
                  {imagesLoading ? (
                    <p className="flex items-center gap-2 text-xs text-muted">
                      <Loader2 aria-hidden size={12} className="animate-spin" />載入映像清單…
                    </p>
                  ) : selectedImage ? (
                    <p className="text-xs text-muted">
                      映像需求約 {selectedImage.sizeInGBs || "?"} GB；發布時間
                      {selectedImage.timeCreated ? ` ${new Date(selectedImage.timeCreated).toLocaleDateString("zh-TW")}` : "—"}
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="new-boot" className="text-sm font-medium">開機磁碟（GB）</Label>
                  <Input
                    id="new-boot"
                    type="number"
                    min={minBootGB}
                    max={MAX_BOOT_VOLUME_GB}
                    value={bootVolumeGB}
                    onChange={event => setBootVolumeGB(Number(event.target.value))}
                    disabled={submitting}
                  />
                  <p className="text-xs text-muted">{minBootGB}–{MAX_BOOT_VOLUME_GB} GB（Always Free 合計 200 GB）</p>
                </div>
              </div>
            </Card.Content>
          </Card>

          {/* 網路與存取 */}
          <Card>
            <Card.Content className="grid gap-4 p-6">
              <h3 className="text-base font-semibold">網路與存取</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label htmlFor="new-vcn" className="text-sm font-medium">VCN</label>
                  <CustomSelect
                    id="new-vcn"
                    value={vcnId}
                    placeholder="請選擇 VCN"
                    disabled={submitting || optionsLoading}
                    options={(options?.networks || []).map(network => ({
                      value: network.vcnId,
                      label: `${network.vcnName} (${network.cidrBlock})`,
                    }))}
                    onChange={onVcnChange}
                  />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="new-subnet" className="text-sm font-medium">子網</label>
                  <CustomSelect
                    id="new-subnet"
                    value={subnetId}
                    placeholder={!vcnId ? "請先選擇 VCN" : "請選擇子網"}
                    disabled={submitting || optionsLoading || !vcnId}
                    options={(selectedVcn?.subnets || []).map(subnet => ({
                      value: subnet.id,
                      label: `${subnet.displayName} (${subnet.cidrBlock})`,
                    }))}
                    onChange={onSubnetChange}
                  />
                  {selectedSubnet?.prohibitPublicIpOnLaunch ? (
                    <p className="text-xs text-muted">此為私有子網，無法配置公網 IP。</p>
                  ) : null}
                </div>
                {canAssignPublicIp ? (
                  <div className="flex items-center justify-between rounded-lg border border-divider p-3 sm:col-span-2">
                    <div className="space-y-0.5 pr-3">
                      <Label htmlFor="assign-public-ip-switch" className="text-sm font-medium cursor-pointer">配置臨時公網 IP</Label>
                      <p className="text-xs text-muted">建立時自動向 OCI 申請臨時公網 IP 位址</p>
                    </div>
                    <Switch
                      id="assign-public-ip-switch"
                      checked={assignPublicIp}
                      onCheckedChange={setAssignPublicIp}
                      disabled={submitting}
                    />
                  </div>
                ) : null}
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="new-ssh" className="text-sm font-medium">SSH 公鑰</Label>
                  <Textarea
                    id="new-ssh"
                    className="min-h-24 font-mono text-xs"
                    spellCheck={false}
                    placeholder={"ssh-ed25519 AAAA… user@host"}
                    value={sshPublicKey}
                    onChange={event => setSshPublicKey(event.target.value)}
                    disabled={submitting}
                  />
                  <p className="text-xs text-muted">OpenSSH 格式（ssh-ed25519 / ssh-rsa 開頭）；會寫入主機的 authorized_keys。</p>
                </div>
              </div>
            </Card.Content>
          </Card>

          <div className="flex justify-end gap-2">
            <Link href="/instances">
              <Button variant="secondary" isDisabled={submitting}>取消</Button>
            </Link>
            <Button type="submit" isDisabled={!canSubmit}>
              {submitting ? <Loader2 aria-hidden size={16} className="animate-spin" /> : <Plus aria-hidden size={16} />}
              建立執行個體
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
