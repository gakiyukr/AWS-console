'use client'

// 保留公網 IP 管理（Phase 2）：清單、申請、綁定、解綁與釋放。
import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Globe,
  Link as LinkIcon,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Chip } from "@/components/chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NoSsr } from "@/components/no-ssr";
import { Table } from "@/components/table-lazy";
import { readError, readJson, toastDanger } from "@/lib/api-client";
import { truncateOcid } from "@/lib/ocid";
import { CustomSelect } from "@/components/ui/select";

interface OciAccountOption {
  id: number
  name: string
  region: string
}

interface ReservedIpRow {
  id: string
  ipAddress: string
  displayName: string
  lifecycleState: string
  assignedEntityId: string | null
  assignedEntityType: string | null
  privateIpId: string | null
  timeCreated: string | null
}

export default function ReservedIpsPage() {
  const [accounts, setAccounts] = useState<OciAccountOption[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [ips, setIps] = useState<ReservedIpRow[]>([]);
  const [region, setRegion] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // 申請對話框狀態
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);

  // 綁定對話框狀態
  const [attachTarget, setAttachTarget] = useState<ReservedIpRow | null>(null);
  const [targetPrivateIpId, setTargetPrivateIpId] = useState("");
  const [attaching, setAttaching] = useState(false);

  // 釋放對話框狀態
  const [deleteTarget, setDeleteTarget] = useState<ReservedIpRow | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const loadReservedIps = useCallback(async (targetAccountId: string) => {
    setLoading(true);
    try {
      const query = targetAccountId ? `?account_id=${targetAccountId}` : "";
      const response = await fetch(`/api/reserved-ips${query}`);
      if (!response.ok) throw new Error(await readError(response));
      const payload = await readJson<{ reservedIps: ReservedIpRow[], region: string }>(response);
      setIps(payload.reservedIps);
      setRegion(payload.region || "");
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入保留 IP 失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function init() {
      const loaded = await loadAccounts();
      const defaultId = loaded.find(account => account.id)?.id;
      if (typeof defaultId === "number") {
        setAccountId(String(defaultId));
        await loadReservedIps(String(defaultId));
      } else {
        setLoading(false);
      }
    }
    void init();
  }, [loadAccounts, loadReservedIps]);

  function handleAccountChange(newId: string) {
    setAccountId(newId);
    void loadReservedIps(newId);
  }

  // 建立保留 IP
  async function handleCreate() {
    setCreating(true);
    try {
      const response = await fetch("/api/reserved-ips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          displayName: createName.trim() || undefined,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("保留公網 IP 申請成功");
      setCreateOpen(false);
      setCreateName("");
      await loadReservedIps(accountId);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "申請保留 IP 失敗");
    } finally {
      setCreating(false);
    }
  }

  // 綁定保留 IP
  async function handleAttach() {
    if (!attachTarget) return;
    if (!targetPrivateIpId.trim()) {
      toastDanger("請輸入目標 Private IP OCID");
      return;
    }
    setAttaching(true);
    try {
      const response = await fetch(`/api/reserved-ips/${encodeURIComponent(attachTarget.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          privateIpId: targetPrivateIpId.trim(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("保留 IP 綁定成功");
      setAttachTarget(null);
      setTargetPrivateIpId("");
      await loadReservedIps(accountId);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "綁定失敗");
    } finally {
      setAttaching(false);
    }
  }

  // 解綁保留 IP
  async function handleDetach(row: ReservedIpRow) {
    try {
      const response = await fetch(`/api/reserved-ips/${encodeURIComponent(row.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          privateIpId: "",
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("已成功解綁保留 IP");
      await loadReservedIps(accountId);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "解綁失敗");
    }
  }

  // 釋放保留 IP
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/reserved-ips/${encodeURIComponent(deleteTarget.id)}?account_id=${accountId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("保留公網 IP 已成功釋放");
      setDeleteTarget(null);
      await loadReservedIps(accountId);
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "釋放失敗");
    } finally {
      setDeleting(false);
    }
  }

  function copyText(value: string) {
    void navigator.clipboard.writeText(value).then(
      () => toast.success("已複製"),
      () => toastDanger("複製失敗"),
    );
  }

  const selectedAccount = accounts.find(account => String(account.id) === accountId);
  const assignedCount = ips.filter(ip => Boolean(ip.assignedEntityId || ip.privateIpId)).length;
  const unassignedCount = ips.length - assignedCount;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">保留公網 IP</h2>
          <p className="text-sm text-muted">
            {selectedAccount
              ? `獨立於執行個體的靜態 IP 池 · ${selectedAccount.region}${region ? ` (${region})` : ""}`
              : "管理 OCI 帳號的 Reserved Public IPs"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onPress={() => setCreateOpen(true)}>
            <Plus aria-hidden size={16} />
            申請保留 IP
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="重新整理"
            isDisabled={loading}
            onPress={() => loadReservedIps(accountId)}
          >
            <RefreshCw aria-hidden size={16} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {accounts.length > 0 ? (
        <div className="flex items-center gap-2">
          <label htmlFor="reserved-ip-account-select" className="text-xs font-medium text-muted shrink-0">OCI 帳號：</label>
          <div className="w-56">
            <CustomSelect
              id="reserved-ip-account-select"
              value={accountId}
              options={accounts.map(account => ({
                value: String(account.id),
                label: `${account.name} (${account.region})`,
              }))}
              onChange={handleAccountChange}
            />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="保留 IP 總數" value={ips.length} />
        <StatCard label="已指派" value={assignedCount} tone="primary" />
        <StatCard label="閒置未指派" value={unassignedCount} />
      </div>

      <Card>
        <Card.Content className="p-0">
          <NoSsr fallback={<div className="p-8 text-center text-sm text-muted">載入中…</div>}>
            <Table.Root aria-label="保留 IP 清單表格">
              <Table.ScrollContainer>
                <Table.Content>
                  <Table.Header>
                    <Table.Column isRowHeader>IP 位址</Table.Column>
                    <Table.Column>名稱</Table.Column>
                    <Table.Column>狀態</Table.Column>
                    <Table.Column>指派目標 (Private IP)</Table.Column>
                    <Table.Column>建立時間</Table.Column>
                    <Table.Column className="text-right">操作</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {loading ? (
                      <Table.Row>
                        <Table.Cell colSpan={6} className="py-8 text-center text-sm text-muted">
                          <Loader2 aria-hidden size={20} className="mx-auto animate-spin" />
                          <p className="mt-2">正在載入保留 IP 清單…</p>
                        </Table.Cell>
                      </Table.Row>
                    ) : ips.length === 0 ? (
                      <Table.Row>
                        <Table.Cell colSpan={6} className="py-8 text-center text-sm text-muted">
                          此 Compartment 內尚未配置保留公網 IP。
                        </Table.Cell>
                      </Table.Row>
                    ) : (
                      ips.map(row => {
                        const isAssigned = Boolean(row.assignedEntityId || row.privateIpId);
                        return (
                          <Table.Row key={row.id}>
                            <Table.Cell className="font-mono text-xs font-semibold">
                              <div className="flex items-center gap-1.5">
                                <Globe size={13} className="text-muted" />
                                <span>{row.ipAddress}</span>
                                <button
                                  type="button"
                                  onClick={() => copyText(row.ipAddress)}
                                  className="text-muted hover:text-foreground"
                                  title="複製 IP"
                                >
                                  <Copy size={11} />
                                </button>
                              </div>
                            </Table.Cell>
                            <Table.Cell className="text-xs">
                              {row.displayName || <span className="text-muted">（未命名）</span>}
                            </Table.Cell>
                            <Table.Cell>
                              <Chip size="sm" variant={isAssigned ? "primary" : "secondary"}>
                                {row.lifecycleState}
                              </Chip>
                            </Table.Cell>
                            <Table.Cell className="font-mono text-xs text-muted">
                              {row.privateIpId ? (
                                <span title={row.privateIpId}>{truncateOcid(row.privateIpId, 16)}</span>
                              ) : (
                                <span>未指派</span>
                              )}
                            </Table.Cell>
                            <Table.Cell className="text-xs text-muted">
                              {row.timeCreated ? new Date(row.timeCreated).toLocaleString("zh-TW", { hour12: false }) : "—"}
                            </Table.Cell>
                            <Table.Cell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                {isAssigned ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="解綁 IP"
                                    onPress={() => handleDetach(row)}
                                  >
                                    <Unlink size={14} />
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="指派至執行個體"
                                    onPress={() => {
                                      setAttachTarget(row);
                                      setTargetPrivateIpId("");
                                    }}
                                  >
                                    <LinkIcon size={14} />
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-danger"
                                  aria-label="釋放 IP"
                                  onPress={() => setDeleteTarget(row)}
                                >
                                  <Trash2 size={14} />
                                </Button>
                              </div>
                            </Table.Cell>
                          </Table.Row>
                        );
                      })
                    )}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table.Root>
          </NoSsr>
        </Card.Content>
      </Card>

      {/* 申請對話框 */}
      <ConfirmDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="申請新的保留公網 IP"
        confirmLabel="立即申請"
        pending={creating}
        onConfirm={handleCreate}
      >
        <div className="grid gap-3 text-sm">
          <p className="text-muted text-xs">
            將在當前 Compartment 內分配一個獨立於任何執行個體的靜態 Public IP，可長期保留並隨時綁定至主機。
          </p>
          <div>
            <label htmlFor="create-reserved-ip-name" className="text-xs font-medium">顯示名稱（選填）</label>
            <Input
              id="create-reserved-ip-name"
              placeholder="例：prod-web-ip"
              value={createName}
              onChange={event => setCreateName(event.target.value)}
              className="mt-1"
            />
          </div>
        </div>
      </ConfirmDialog>

      {/* 綁定對話框 */}
      <ConfirmDialog
        open={attachTarget !== null}
        onOpenChange={open => { if (!open) setAttachTarget(null); }}
        title={`綁定保留 IP (${attachTarget?.ipAddress || ""})`}
        confirmLabel="確認綁定"
        pending={attaching}
        onConfirm={handleAttach}
      >
        <div className="grid gap-3 text-sm">
          <p className="text-muted text-xs">
            請輸入目標執行個體之主要 Private IP OCID（例如從執行個體清單或 VNIC 取得）：
          </p>
          <div>
            <label htmlFor="attach-target-private-ip" className="text-xs font-medium">Private IP OCID</label>
            <Input
              id="attach-target-private-ip"
              placeholder="ocid1.privateip.oc1..."
              value={targetPrivateIpId}
              onChange={event => setTargetPrivateIpId(event.target.value)}
              className="mt-1"
            />
          </div>
        </div>
      </ConfirmDialog>

      {/* 釋放對話框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={open => { if (!open) setDeleteTarget(null); }}
        title={`確認釋放保留 IP (${deleteTarget?.ipAddress || ""})`}
        confirmLabel="確認釋放"
        pending={deleting}
        onConfirm={handleDelete}
      >
        <div className="grid gap-2 text-sm">
          <p>確定要釋放此保留公網 IP 嗎？</p>
          <p className="text-xs text-danger">
            此操作不可逆。該 IP 將歸還至 Oracle 資源池，之後將無法重新取回相同的 IP 位址。
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string, value: number, tone?: "primary" }) {
  return (
    <Card>
      <Card.Content className="p-4">
        <p className="text-xs text-muted">{label}</p>
        <p className={`text-2xl font-bold ${tone === "primary" ? "text-[var(--accent)]" : ""}`}>{value}</p>
      </Card.Content>
    </Card>
  );
}
