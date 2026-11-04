'use client'

// 機器操作的確認對話框：兩個平台總覽頁共用。文案依平台微調
// （Lightsail 的「終止」是 DeleteInstance，機器會永久刪除）。
import type { ReactNode } from "react";
import { Button } from "@heroui/react/button";
import { Modal } from "@heroui/react/modal";
import type { MachineRow } from "@/components/machine-table";

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  confirmLabel: string
  pending?: boolean
  danger?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  pending = false,
  danger = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal.Root isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => onOpenChange(false)}>取消</Button>
              <Button variant={danger ? "danger" : "primary"} isDisabled={pending} onPress={onConfirm}>
                {confirmLabel}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

/** 顯示機器名稱；目標為 null 時（關閉動畫期間）留空。 */
export function MachineName({ machine }: { machine: MachineRow | null }) {
  return <span className="font-medium">{machine?.name || ""}</span>;
}
