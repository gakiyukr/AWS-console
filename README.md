# AWS 主控台

單一 Cloudflare Worker 的 AWS 主控台（Next.js 16 App Router + HeroUI 3），完整程式與說明見 [`next-app/`](./next-app/README.md)。

- 以 OIDC SSO（Authorization Code + PKCE）登入，僅允許清單內的 email 進入主控台。
- 管理 D1 清單內 EC2 執行個體的即時狀態與開機、關機操作。
- 建立及初始化 AWS Wavelength Zone 所需的子網、Carrier Gateway、路由表與安全群組。
- 以獨立工作流部署一般區域 EC2、Wavelength 執行個體與 SSH forwarder。
- 在部署成功後自動將建立的執行個體登錄至電源管理清單。
- 保存電源操作與部署結果的稽核日誌。
- 在 D1 管理多組 AWS 帳號；AWS Secret 以 AES-256-GCM 加密後儲存。

## 部署方式

正式環境由 Cloudflare Workers Builds（git 整合）自動部署：push 到 `main` 後以根目錄 `next-app` 執行：

- 構建命令：`rm -rf .open-next .next && pnpm exec opennextjs-cloudflare build`
  - **務必先刪除 `.open-next`**：Workers Builds 會還原上次的建置快取，在殘留產物上增量打包會產出執行時 Server Components 500 的壞 bundle。
- 部署命令：`npx wrangler deploy`
- 根目錄：`next-app`

部署目標（Worker 名稱 `aws-console`、正式 D1、service binding）定義在 `next-app/wrangler.jsonc`；D1 migrations 位於 `next-app/server/db/migrations`。同名部署會保留 Worker secrets（`SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`），正式資料原樣沿用。

SSO 登入設定（OOBE 初始設定、環境變數替代管道、IAM 權限建議、API 範圍與部署登入憑證說明）請見 `next-app/README.md`。
