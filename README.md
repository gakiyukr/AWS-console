# AWS 主控台

主控台前端已遷移至 `next-app/`（Next.js 16 App Router + HeroUI 3），與根目錄的 Nuxt 舊版共用 `server/db/migrations` 與後端工具層；遷移契約見 `next-app/MIGRATION.md`。以下說明以 Next.js 版為準。

## 部署方式

正式環境由 Cloudflare Workers Builds（git 整合）自動部署：push 到 `main` 後以根目錄 `next-app` 執行：

- 構建命令：`rm -rf .open-next .next && pnpm exec opennextjs-cloudflare build`
  - **務必先刪除 `.open-next`**：Workers Builds 會還原上次的建置快取，在殘留產物上增量打包會產出執行時 Server Components 500 的壞 bundle。
- 部署命令：`npx wrangler deploy`
- 根目錄：`next-app`

本機部署同一份設定：

```bash
cd next-app
pnpm install
pnpm exec opennextjs-cloudflare build   # 執行前先停用 next dev 並確認無 workerd 殘留，否則產出壞 bundle
pnpm exec wrangler deploy
```

部署目標（Worker 名稱、正式 D1、service binding）定義在 `next-app/wrangler.jsonc`；同名部署會保留 Worker secrets（`SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`），正式資料原樣沿用。

此專案整合 `aws-wavelength-console` 與 `ec2-power-console` 的核心能力，部署為單一 Cloudflare Worker：

- 以 OIDC SSO（Authorization Code + PKCE）登入，僅允許清單內的 email 進入主控台。
- 管理 D1 清單內 EC2 執行個體的即時狀態與開機、關機操作。
- 建立及初始化 AWS Wavelength Zone 所需的子網、Carrier Gateway、路由表與安全群組。
- 以獨立工作流部署一般區域 EC2、Wavelength 執行個體與 SSH forwarder。
- 在部署成功後自動將建立的執行個體登錄至電源管理清單。
- 保存電源操作與部署結果的稽核日誌。
- 在 D1 管理多組 AWS 帳號；AWS Secret 以 AES-256-GCM 加密後儲存。

## 本機驗證

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

複製 `.env.example` 為 `.env`，並複製 `.dev.vars.example` 為 `.dev.vars` 後填入本機所需值。以 Cloudflare Worker 執行本機環境時，使用：

```bash
pnpm dev:worker
```

`pnpm dev:worker` 與 `pnpm deploy` 都會先檢查 `CLOUDFLARE_D1_DATABASE_ID`，避免啟動缺少 `DB` binding 的 Worker。

## SSO 登入設定

登入採標準 OIDC Authorization Code + PKCE（`oauth4webapi`），IdP 可為 Cloudflare Access（SaaS app 模式，非邊緣代理）、Google、GitLab 等任何支援 discovery 的 OIDC 提供者。登入成功者僅限綁定 email。

### 首次執行（OOBE 初始設定）

全新部署後開啟網站會自動進入 `/setup` 初始設定精靈：

1. 填入**綁定 email**（完成驗證後僅此 email 能登入）與 IdP 資訊（Discovery URL，或三個明確端點）、Client ID／Secret。
2. 「測試連線」會解析 IdP metadata 驗證設定。
3. 「開始 SSO 驗證」會先把表單設定加密暫存至 D1，再導向 IdP 完成一次真實登入；**回頭的 email 與綁定 email 一致**時才提升為正式設定，並直接登入主控台。

瀏覽器的 `oidc_state` Cookie 只保存隨機 pending ID、state、nonce 與 PKCE verifier，不保存 Client Secret 或其他 OIDC 設定。pending 設定使用獨立 AES-GCM AAD 加密，10 分鐘後失效。

只有 `DB` binding、D1 migration、`SESSION_SECRET` 與 `CREDENTIAL_ENCRYPTION_KEY` 均正常，且 D1 確實沒有 SSO 設定資料列時才會進入 OOBE。基礎設施或解密失敗會顯示 `/503` 診斷頁，不會要求重新設定 SSO。

設定完成後 `/setup` 會封鎖；重新設定需清除 D1 設定：

```bash
pnpm exec wrangler --config .output/server/wrangler.json d1 execute DB --remote --command "DELETE FROM sso_config"
```

### 以環境變數設定（替代管道）

不改用 OOBE 時，也可完全以環境變數提供設定（D1 內的 OOBE 設定優先於環境變數）：

以 Cloudflare Access 為 IdP 的設定步驟：

1. Zero Trust → Access → Applications → Add → SaaS，自訂應用程式名稱（如 `aws-console`）。
2. 填入兩條 redirect URI：正式網域的 `https://<domain>/api/auth/callback` 與本機的 `http://localhost:8787/api/auth/callback`。
3. Scopes 勾選 `openid`、`email`、`profile`，建立後取得 client ID 與 client secret。
4. 建立 Access policy，僅允許自己的 email。
5. 將頁面上的 OIDC 端點與憑證填入 `OIDC_*` 環境變數（見 `.env.example`）。

若 IdP 未提供 discovery，改以 `OIDC_AUTHORIZATION_URL`、`OIDC_TOKEN_URL`、`OIDC_JWKS_URL` 明確指定端點即可，登入流程不變。

## Cloudflare 部署

先建立 D1 資料庫。此專案已在 `nuxt.config.ts` 內保留目前 `aws-console` D1 的預設 ID，因此 GitHub 建置即使沒有本機 `.env`，仍會產生 `DB` binding。若要改用其他資料庫，請在建置環境覆寫 `CLOUDFLARE_D1_DATABASE_ID`，並依需要調整 Worker 與資料庫名稱。設定完成後建立 Worker 產物並套用 migration：

```bash
pnpm exec wrangler d1 create aws-console
pnpm build
pnpm exec wrangler --config .output/server/wrangler.json d1 migrations apply DB --remote
```

正式環境只需保留以下 Cloudflare secrets，不應寫入 D1、`.env` 或版本庫：

```bash
pnpm exec wrangler --config .output/server/wrangler.json secret put SESSION_SECRET
pnpm exec wrangler --config .output/server/wrangler.json secret put CREDENTIAL_ENCRYPTION_KEY
pnpm exec wrangler --config .output/server/wrangler.json secret put OIDC_CLIENT_SECRET
```

- `SESSION_SECRET`：簽署登入 session（HMAC-SHA256），輪替後所有既有 session 失效。
- `CREDENTIAL_ENCRYPTION_KEY`：32 位元組 Base64 AES 主金鑰。遺失或更換後，既有 AWS 憑證無法解密。
- `OIDC_CLIENT_SECRET`：OIDC client 對 IdP token 端點的驗證密鑰。

`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_EMAILS` 等非機密設定以 Dashboard 的環境變數（vars）保存即可。

可在本機產生兩個獨立的隨機 Base64 secret：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

首次登入後前往「帳號管理」新增 AWS Access Key。Access Key、Secret Access Key
與選填 Session Token 會在 Worker 內加密後寫入 D1；API 與頁面只會顯示 Access Key
尾四位。請勿將 `CREDENTIAL_ENCRYPTION_KEY` 放入 D1，否則密文失去隔離意義。

### AWS IAM 權限建議

僅使用機器總覽（電源管理）時，IAM 政策可限縮為：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeImages",
        "ec2:StartInstances",
        "ec2:StopInstances"
      ],
      "Resource": "*"
    }
  ]
}
```

Wavelength 初始化與部署流程另需 VPC、Subnet、Carrier Gateway、Route Table、
Security Group 與 `ec2:RunInstances` 等權限；一般 EC2 部署亦需 `ec2:RunInstances`。

帳號管理的「開通區域」功能需額外授予下列權限（EC2 EnableRegion 屬帳號層級
操作，AWS 要求同時具備 EC2 與 Account 兩個命名空間的權限）：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions",
        "ec2:EnableRegion",
        "account:EnableRegion"
      ],
      "Resource": "*"
    }
  ]
}
```

`0003_accounts_and_users.sql` 會建立 AWS 帳號與主控台使用者資料表，並為機器及
操作日誌加入 AWS 帳號關聯。建立第一個 AWS 帳號時，尚未關聯的舊機器會自動歸入該帳號。
`0004_drop_console_users.sql` 於改用 SSO 後移除密碼使用者與登入限流資料表。
`0005_sso_config.sql` 建立 OOBE 初始設定的 SSO 設定表。
`0006_ssh_public_keys.sql` 建立部署用的 SSH 公鑰庫資料表。
`0007_pending_sso_setup.sql` 建立 OOBE 驗證前的短效加密設定暫存表。

完成 D1 與 secrets 設定後執行：

```bash
pnpm deploy
```

部署腳本會先檢查 D1 資料庫 ID，再建立 `.output` 內含 `DB` binding 的 Wrangler 設定並部署。`keep_vars` 會保留 Dashboard 中既有的 secrets。

## API 範圍

- `/api/auth/login`：SSO 登入入口，302 導向 IdP 授權端點。
- `/api/auth/callback`：IdP 回調，驗證後簽發 session。
- `/api/setup/*`：OOBE 初始設定的測試連線與驗證啟動。
- `/api/machines`：EC2 管理清單與即時狀態。
- `/api/machines/:id/action`：白名單機器的開機或關機。
- `/api/accounts`：AWS 帳號與加密憑證管理；`/:id/test` 可驗證憑證。
- `/api/ssh-keys`：部署用 SSH 公鑰庫的列表、新增（上限 50 把）與刪除。
- `/api/ec2/*`：一般 EC2 的 Region、VPC、執行個體、作業系統選項與部署流程。
- `/api/wavelength/*`：Wavelength 探索、初始化與部署流程。
- `/api/logs`：可依 `account_id`、`action`、`status`、`limit` 讀取稽核日誌。

所有 `/api` 端點（SSO 登入流程與 session 查詢除外）都要求有效登入 session，
且 session 內 email 必須在允許清單中。

## 部署登入憑證

三條部署流程（Wavelength EC2、Wavelength EC2 + forwarder、既有 WL 附加
forwarder、一般區域 EC2）的 root 登入憑證為必填二選一，隨機密碼已移除：

- `credential_type: "ssh_key"`：攜帶 `ssh_key_id`（D1 公鑰庫列 id），部署時寫入
  `/root/.ssh/authorized_keys` 並停用 root 密碼認證（`PermitRootLogin
  without-password`、`PasswordAuthentication no`）。公鑰於設定頁管理。
- `credential_type: "password"`：攜帶 `root_password`（8–128 字元），沿用
  chpasswd 設定 root 密碼。密碼僅存在於單次請求，不寫入 D1、不進稽核日誌。

SSE 進度事件 `credentials_ready` 僅公布 `username` 與 `credential_type`，
不攜帶任何機密；部署結果的 `password` 欄位在公鑰模式下為空字串。
