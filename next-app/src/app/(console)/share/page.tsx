'use client'

// 分享連結管理：建立「一鍵換 IP」的對外連結、綁定機器、啟停用與刪除。
// token 以明文儲存（URL 即憑證），因此清單隨時可複製完整連結；
// 訪客側行為與冷卻機制見 /share/[token] 公開頁與 /api/share/* 端點。
import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Link2, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "@heroui/react/toast";
import { Chip } from "@/components/chip";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Modal } from "@heroui/react/modal";
import { readError, readJson, toastDanger } from "@/lib/api-client";

interface ShareLinkMachine {
  id: number
  name: string
  region: string
}

interface ShareLinkRow {
  id: number
  name: string
  token: string
  cooldownMinutes: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  machines: ShareLinkMachine[]
}

// GET /api/machines 的列（建立表單的候選機器）
interface MachineOption {
  id: number
  name: string
  state: string | null
  platform: string
}

// D1 datetime('now') 為 UTC 且無時區標記，補成 ISO 格式再轉本地時間
function formatDatetime(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW");
}

function cooldownLabel(minutes: number) {
  return minutes > 0 ? `${minutes} 分鐘` : "不限";
}

export default function ShareLinksPage() {
  const [links, setLinks] = useState<ShareLinkRow[]>([]);
  const [machines, setMachines] = useState<MachineOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", cooldownMinutes: "5" });
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<ShareLinkRow | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 後台設定：分享頁人機驗證（Cap）開關；null 代表仍在載入
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean | null>(null);

  async function loadData() {
    try {
      const [linksResponse, machinesResponse, settingsResponse] = await Promise.all([
        fetch("/api/share-links"),
        fetch("/api/machines"),
        fetch("/api/share-settings"),
      ]);
      if (!linksResponse.ok) throw new Error("載入分享連結失敗");
      if (!machinesResponse.ok) throw new Error("載入機器清單失敗");
      if (!settingsResponse.ok) throw new Error("載入分享設定失敗");
      const linksPayload = await readJson<{ links?: ShareLinkRow[] }>(linksResponse);
      const machinesPayload = await readJson<MachineOption[]>(machinesResponse);
      const settingsPayload = await readJson<{ captchaEnabled?: boolean }>(settingsResponse);
      setLinks(linksPayload.links || []);
      setMachines(machinesPayload);
      setCaptchaEnabled(Boolean(settingsPayload.captchaEnabled));
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "載入分享連結失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadData();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleSelected(id: number) {
    setSelectedIds(previous =>
      previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  }

  async function createLink() {
    setCreating(true);
    try {
      const response = await fetch("/api/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          cooldownMinutes: Number(form.cooldownMinutes),
          machineIds: selectedIds,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await readJson<{ link?: { url?: string } }>(response);
      toast.success(`分享連結已建立：${payload.link?.url || ""}`);
      setCreateOpen(false);
      setForm({ name: "", cooldownMinutes: "5" });
      setSelectedIds([]);
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "建立分享連結失敗");
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(link: ShareLinkRow) {
    try {
      const response = await fetch(`/api/share-links/${link.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !link.enabled }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success(link.enabled ? "連結已停用" : "連結已啟用");
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "更新分享連結失敗");
    }
  }

  function requestDelete(link: ShareLinkRow) {
    setDeleteTarget(link);
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    const link = deleteTarget;
    if (!link) return;
    setDeleteOpen(false);
    setDeleteTarget(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/share-links/${link.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      toast.success("分享連結已刪除");
      await loadData();
    } catch (error) {
      toastDanger(error instanceof Error ? error.message : "刪除分享連結失敗");
    } finally {
      setDeleting(false);
    }
  }

  function copyLink(link: ShareLinkRow) {
    void navigator.clipboard?.writeText(`${window.location.origin}/share/${link.token}`);
    toast.success("已複製分享連結");
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">分享連結</h2>
          <p className="text-sm text-muted">
            發布對外的一鍵換 IP 網頁；持有連結的訪客可對綁定機器執行關機再開機以更換公網 IP
          </p>
        </div>
        <Button onPress={() => setCreateOpen(true)}>
          <Plus aria-hidden size={16} className="mr-2" />
          新增連結
        </Button>
      </div>

      {captchaEnabled !== null ? (
        <Card>
          <Card.Content className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div className="flex items-start gap-3">
              <ShieldCheck aria-hidden size={20} className="mt-0.5" />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">人機驗證</h3>
                  <Chip variant={captchaEnabled ? "primary" : "soft"} size="sm">
                    {captchaEnabled ? "已啟用" : "未啟用"}
                  </Chip>
                </div>
                <p className="mt-1 max-w-xl text-sm text-muted">
                  啟用後訪客須通過 Cap（工作量證明）人機驗證才能點擊「一鍵換 IP」。
                  啟用開關與密鑰請到「設定」頁管理。
                </p>
              </div>
            </div>
            <Link
              href="/settings"
              className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-default"
            >
              前往設定
            </Link>
          </Card.Content>
        </Card>
      ) : null}

      {loading ? (
        <div className="flex py-8 text-sm text-muted">
          <Loader2 aria-hidden size={16} className="mr-2 animate-spin" />載入中...
        </div>
      ) : links.length === 0 ? (
        <div className="border-y py-10 text-center text-sm text-muted">尚未建立任何分享連結</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {links.map(link => (
            <Card key={link.id}>
              <Card.Content className="grid gap-3 p-6">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="min-w-0 truncate text-base font-semibold">{link.name}</h4>
                  <Chip variant={link.enabled ? "primary" : "soft"} size="sm">
                    {link.enabled ? "啟用中" : "已停用"}
                  </Chip>
                </div>
                <button
                  type="button"
                  title="點擊複製連結"
                  className="flex min-w-0 items-center gap-2 self-start font-mono text-xs underline-offset-4 hover:underline"
                  onClick={() => copyLink(link)}
                >
                  <Copy aria-hidden size={14} className="shrink-0" />
                  <span className="truncate">/share/{link.token}</span>
                </button>
                <div className="grid gap-1 text-xs text-muted">
                  <span>綁定機器：{link.machines.map(machine => machine.name).join("、") || "—"}</span>
                  <span>冷卻時間：{cooldownLabel(link.cooldownMinutes)}</span>
                  <span>建立時間：{formatDatetime(link.createdAt)}</span>
                  <span>最後使用：{formatDatetime(link.lastUsedAt)}</span>
                </div>
                <div className="flex justify-end gap-2 border-t pt-3">
                  <Button variant="secondary" size="sm" onPress={() => toggleEnabled(link)}>
                    {link.enabled ? "停用" : "啟用"}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="刪除連結" onPress={() => requestDelete(link)}>
                    <Trash2 aria-hidden size={16} />
                  </Button>
                </div>
              </Card.Content>
            </Card>
          ))}
        </div>
      )}

      {/* 新增連結 */}
      <Modal.Root isOpen={createOpen} onOpenChange={setCreateOpen}>
        <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>新增分享連結</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="grid gap-4">
              <div className="grid gap-2">
                <label htmlFor="share-link-name" className="text-sm font-medium">連結名稱</label>
                <Input
                  id="share-link-name"
                  placeholder="例如： 換 IP 用"
                  value={form.name}
                  onChange={event => setForm(previous => ({ ...previous, name: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <label htmlFor="share-link-cooldown" className="text-sm font-medium">冷卻分鐘數</label>
                <Input
                  id="share-link-cooldown"
                  type="number"
                  min={0}
                  max={1440}
                  value={form.cooldownMinutes}
                  onChange={event => setForm(previous => ({ ...previous, cooldownMinutes: event.target.value }))}
                />
                <p className="text-xs text-muted">
                  同一台機器更換 IP 後，須等待此分鐘數才能再次由訪客觸發（0 表示不限）。
                </p>
              </div>
              <div className="grid gap-2">
                <span className="text-sm font-medium">綁定機器</span>
                {machines.length === 0 ? (
                  <p className="text-xs text-muted">機器清單是空的，請先到 EC2 或 Lightsail 頁新增機器。</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                    {machines.map(machine => (
                      <label
                        key={machine.id}
                        className="flex h-9 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-default"
                      >
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={selectedIds.includes(machine.id)}
                          onChange={() => toggleSelected(machine.id)}
                        />
                        <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                        <Chip variant="soft" size="sm">
                          {machine.platform === "lightsail" ? "Lightsail" : "EC2"}
                        </Chip>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setCreateOpen(false)}>取消</Button>
              <Button isDisabled={creating || !form.name || selectedIds.length === 0} onPress={createLink}>
                {creating ? <Loader2 aria-hidden size={16} className="mr-2 animate-spin" /> : <Link2 aria-hidden size={16} className="mr-2" />}
                建立
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* 刪除確認 */}
      <Modal.Root isOpen={deleteOpen} onOpenChange={setDeleteOpen}>
        <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>刪除分享連結</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              確定要刪除連結「{deleteTarget?.name}」嗎？持有舊網址的訪客將無法再開啟頁面；機器本身不受影響。
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setDeleteOpen(false)}>取消</Button>
              <Button variant="danger" isDisabled={deleting} onPress={confirmDelete}>刪除</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </div>
  );
}
