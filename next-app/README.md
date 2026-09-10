# AWS 主控台 Next.js 遷移版本

這是現有 Nuxt 應用程式的平行遷移版本，使用 Next.js App Router、React 19、HeroUI v3 與 OpenNext for Cloudflare。正式切換前，既有 Nuxt Worker 仍是唯一正式版本。

## 本機開發

```bash
pnpm install
pnpm dev
```

預設開發網址為 `http://127.0.0.1:3000`。

如需在本機存取 Cloudflare binding，先將 `.dev.vars.example` 複製為 `.dev.vars`，並填入僅供本機測試的密鑰。

## 驗證

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm exec opennextjs-cloudflare build
```

## 預覽部署

`wrangler.jsonc` 固定使用 `aws-console-next-preview`，避免覆蓋正式 Worker。只有在完成 secrets、D1 binding 與功能回歸檢查後，才可執行：

```bash
pnpm deploy:preview
```

完整路由、後端契約與切換條件請見 [MIGRATION.md](./MIGRATION.md)。
