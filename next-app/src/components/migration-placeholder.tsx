import { Card } from "@heroui/react/card";
import { Chip } from "@heroui/react/chip";
import { Construction } from "lucide-react";

interface MigrationPlaceholderProps {
  description: string;
  title: string;
}

export function MigrationPlaceholder({ description, title }: MigrationPlaceholderProps) {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
          <Chip color="warning" size="sm" variant="soft">
            遷移中
          </Chip>
        </div>
        <p className="text-sm text-muted sm:text-base">{description}</p>
      </section>

      <Card variant="secondary">
        <Card.Content className="grid min-h-72 place-items-center px-6 py-12 text-center">
          <div className="max-w-sm">
            <span className="mx-auto mb-4 grid size-11 place-items-center rounded-lg bg-default text-muted">
              <Construction aria-hidden="true" size={21} />
            </span>
            <h2 className="text-sm font-semibold">暫時無法使用</h2>
            <p className="mt-1 text-sm text-muted">此功能正在遷移，請稍後再試。</p>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
