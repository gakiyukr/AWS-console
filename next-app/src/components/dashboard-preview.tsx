import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@heroui/react/chip";
import { Plus, RefreshCw, Server } from "lucide-react";

const statistics = [
  { label: "運行中", value: "-", detail: "等待 API 遷移" },
  { label: "已停止", value: "-", detail: "等待 API 遷移" },
  { label: "Wavelength", value: "-", detail: "等待 API 遷移" },
  { label: "涵蓋地區", value: "-", detail: "等待 API 遷移" },
];

export function DashboardPreview() {
  return (
    <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <h1 className="text-2xl font-semibold sm:text-3xl">機器總覽</h1>
              <Chip color="accent" size="sm" variant="soft">預覽</Chip>
            </div>
            <p className="text-sm text-muted sm:text-base">
              管理 D1 清單中所有 EC2 執行個體的電源狀態
            </p>
          </div>
          <div className="flex gap-2">
            <Button isDisabled variant="secondary">
              <RefreshCw aria-hidden="true" size={17} />
              重新整理
            </Button>
            <Button isDisabled variant="primary">
              <Plus aria-hidden="true" size={17} />
              新增機器
            </Button>
          </div>
        </section>

        <section aria-label="機器統計" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {statistics.map((item) => (
            <Card key={item.label} variant="secondary">
              <Card.Header>
                <Card.Description>{item.label}</Card.Description>
                <Card.Title className="text-3xl">{item.value}</Card.Title>
              </Card.Header>
              <Card.Content>
                <p className="text-xs text-muted">{item.detail}</p>
              </Card.Content>
            </Card>
          ))}
        </section>

        <section className="overflow-hidden rounded-lg border border-divider bg-surface">
          <div className="flex items-center justify-between border-b border-divider px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold">執行個體</h2>
              <p className="text-xs text-muted">API 契約完成後接入正式 D1 資料</p>
            </div>
            <Chip color="warning" size="sm" variant="soft">
              遷移中
            </Chip>
          </div>
          <div className="grid min-h-64 place-items-center px-6 py-12 text-center">
            <div className="max-w-sm">
              <span className="mx-auto mb-4 grid size-11 place-items-center rounded-lg bg-default text-muted">
                <Server aria-hidden="true" size={21} />
              </span>
              <h3 className="text-sm font-semibold">尚未載入機器資料</h3>
              <p className="mt-1 text-sm text-muted">
                機器 API 完成遷移前，此清單暫停操作。
              </p>
            </div>
          </div>
        </section>
    </div>
  );
}
