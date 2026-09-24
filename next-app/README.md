# AWS 主控台

單一 Cloudflare Worker 的 AWS 主控台：Next.js 16 App Router + React 19 + HeroUI 3，以 [OpenNext for Cloudflare](https://opennext.js.org/cloudflare) 打包部署，資料儲存於 Cloudflare D1。

## 功能

- 以 OIDC SSO（Authorization Code + PKCE）登入，僅允許清單內的 email 進入主控台。
- 管理 D1 清單內 EC2 執行個體的即時狀態，並執行開機、關機、重啟、終止，
  以及「更換公網 IP」（stop → start）。
- 建立及初始化 AWS Wavelength Zone 所需的子網、Carrier Gateway、路由表與安全群組。
- 以獨立工作流部署一般區域 EC2、Wavelength 執行個體與 SSH forwarder。
- 部署成功後自動將建立的執行個體登錄至電源管理清單。
- 保存電源操作與部署結果的稽核日誌。
- 在 D1 管理多組 AWS 帳號；AWS Secret 以 AES-256-GCM 加密後儲存。

## 目錄結構

```
next-app/
├── src/app/(console)/   # 受保護頁面（layout 內做頁面守衛，一律動態渲染）
│   ├── page.tsx         # 機器總覽與電源操作
│   ├── ec2/             # 一般 EC2 部署
│   ├── wavelength/      # Wavelength 部署
│   ├── accounts/        # AWS 帳號管理
│   ├── logs/            # 稽核日誌
│   └── settings/        # SSH 公鑰管理
├── src/app/login/、setup/  # 登入頁與 OOBE 初始設定
├── src/app/api/         # API 路由（見下方「API 範圍」）
├── src/server/          # 守衛（page-guard、api-guard）與後端工具層
├── src/lib/             # 前後端共用：regions、ssh-keys、deployment-stream
├── src/components/      # AppShell、Chip、NoSsr 等共用元件
├── server/db/migrations # D1 migrations（wrangler.jsonc 引用）
├── wrangler.jsonc       # Worker 設定（正式名稱 aws-console、D1 binding）
└── open-next.config.ts  # OpenNext Cloudflare 設定
```

## 部署方式

正式環境由 Cloudflare Workers Builds（git 整合）自動部署：push 到 `main` 後以 `next-app` 為根目錄執行：

- 構建命令：`rm -rf .open-next .next && pnpm exec opennextjs-cloudflare build`
  - **務必先刪除 `.open-next`**：Workers Builds 會還原上次的建置快取，在殘留產物上增量打包會產出執行時 Server Components 500 的壞 bundle。
- 部署命令：`npx wrangler deploy`

部署目標（Worker 名稱 `aws-console`、正式 D1、service binding）定義在 `wrangler.jsonc`；同名部署搭配 `keep_vars` 會保留 Worker secrets（`SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`、`SETUP_TOKEN`），正式資料原樣沿用。

套用 D1 migrations（僅在 schema 變更時需要）：

```bash
pnpm exec wrangler d1 migrations apply DB --remote
```

## 本機開發

```bash
pnpm install
pnpm dev            # http://127.0.0.1:3000
```

將 `.dev.vars.example` 複製為 `.dev.vars` 並填入僅供本機測試的密鑰後，即可用 Worker 執行環境驗證：

```bash
pnpm preview        # opennextjs-cloudflare build + preview（本機 workerd）
```

本機測試登入可用 `/api/dev-session`（僅 dev 環境存在，生產一律 404）。

## 驗證

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm exec opennextjs-cloudflare build
```

## SSO 登入設定

登入採標準 OIDC Authorization Code + PKCE（`oauth4webapi`），IdP 可為 Cloudflare Access（SaaS app 模式，非邊緣代理）、Google、GitLab 等任何支援 discovery 的 OIDC 提供者。登入成功者僅限綁定 email。

### 首次執行（OOBE 初始設定）

全新部署後開啟網站會自動進入 `/setup` 初始設定精靈：

1. 先設定 Worker 的 `SETUP_TOKEN` secret，再於頁面輸入相同的 **Setup Token**、綁定 email（完成驗證後僅此 email 能登入）與 IdP 資訊（Discovery URL，或三個明確端點）、Client ID／Secret。
2. 「測試連線」會先驗證 Setup Token，再解析 IdP metadata 驗證設定。
3. 「開始 SSO 驗證」會先把表單設定加密暫存至 D1，再導向 IdP 完成一次真實登入；**回頭的 email 與綁定 email 一致**時才提升為正式設定，並直接登入主控台。

瀏覽器的 `oidc_state` Cookie 只保存隨機 pending ID、state、nonce 與 PKCE verifier，不保存 Client Secret 或其他 OIDC 設定。pending 設定使用獨立 AES-GCM AAD 加密，10 分鐘後失效。

只有 `DB` binding、D1 migration、`SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` 與 `SETUP_TOKEN` 均正常，且 D1 確實沒有 SSO 設定資料列時才會進入 OOBE。基礎設施或解密失敗會顯示 `/503` 診斷頁；缺少 Setup Token 會在設定表單顯示錯誤，不會要求重新設定 SSO。

設定完成後 `/setup` 會封鎖；重新設定需清除 D1 設定：

```bash
pnpm exec wrangler d1 execute DB --remote --command "DELETE FROM sso_config"
```

### 以環境變數設定（替代管道）

不改用 OOBE 時，也可完全以環境變數提供設定（D1 內的 OOBE 設定優先於環境變數）。以 Cloudflare Access 為 IdP 的設定步驟：

1. Zero Trust → Access → Applications → Add → SaaS，自訂應用程式名稱（如 `aws-console`）。
2. 填入 redirect URI：`https://<domain>/api/auth/callback`。
3. Scopes 勾選 `openid`、`email`、`profile`，建立後取得 client ID 與 client secret。
4. 建立 Access policy，僅允許自己的 email。
5. 將頁面上的 OIDC 端點與憑證填入 `OIDC_*` 環境變數（見 `.dev.vars.example`）。

若 IdP 未提供 discovery，改以 `OIDC_AUTHORIZATION_URL`、`OIDC_TOKEN_URL`、`OIDC_JWKS_URL` 明確指定端點即可，登入流程不變。

## Secrets 與環境變數

正式環境只需保留以下 Cloudflare secrets，不應寫入 D1 或版本庫：

```bash
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY
pnpm exec wrangler secret put SETUP_TOKEN
```

- `SESSION_SECRET`：簽署登入 session（HMAC-SHA256），輪替後所有既有 session 失效。
- `CREDENTIAL_ENCRYPTION_KEY`：32 位元組 Base64 AES 主金鑰。遺失或更換後，既有 AWS 憑證無法解密。
- `SETUP_TOKEN`：授權 OOBE 測試與 SSO 啟動，至少 32 bytes；不寫入 D1、設定 Cookie 或 API 回應。設定完成後可從 Worker secrets 刪除，後續請求會因未設定而 fail closed。

`OIDC_CLIENT_SECRET` 由 OOBE 流程加密存入 D1；`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_EMAILS` 等非機密設定以 Dashboard 的環境變數（vars）保存即可。可用下列命令產生 `SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` 或 `SETUP_TOKEN` 所需的隨機值：

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
        "ec2:StopInstances",
        "ec2:RebootInstances",
        "ec2:TerminateInstances"
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

## API 範圍

- `/api/auth/login`：SSO 登入入口，302 導向 IdP 授權端點。
- `/api/auth/callback`：IdP 回調，驗證後簽發 session。
- `/api/session`：查詢目前登入狀態。
- `/api/logout`：清除 session。
- `/api/setup/*`：OOBE 初始設定的測試連線與驗證啟動。
- `/api/machines`：EC2 管理清單與即時狀態；`DELETE /:id` 僅移除清單記錄。
- `/api/machines/:id/action`：對清單內機器送出 `start`、`stop`、`reboot` 或
  `terminate`。`reboot` 不會更換公網 IP；`terminate` 為不可逆操作，成功後
  執行個體被永久刪除並同步移除清單記錄。
- `/api/machines/:id/reboot-ip`：連續執行 stop → 等待 stopped → start，
  藉此更換公網 IP。
- `/api/accounts`：AWS 帳號與加密憑證管理；`/:id/test` 可驗證憑證，`/:id/regions/enable` 可開通區域。
- `/api/ssh-keys`：部署用 SSH 公鑰庫的列表、新增（上限 50 把）與刪除。
- `/api/ec2/*`：一般 EC2 的 Region、VPC、執行個體、作業系統選項與部署流程。
- `/api/wavelength/*`：Wavelength 探索、初始化與部署流程。
- `/api/logs`：可依 `account_id`、`action`、`status`、`limit` 讀取稽核日誌。

所有 `/api` 端點（SSO 登入流程與 session 查詢除外）都要求有效登入 session，
且 session 內 email 必須在允許清單中。

## 部署登入憑證

四條部署流程（一般 EC2、Wavelength EC2、WL + forwarder、既有 WL 附加
forwarder）的 root 登入憑證為必填二選一，隨機密碼已移除：

- `credential_type: "ssh_key"`：攜帶 `ssh_key_id`（D1 公鑰庫列 id），部署時寫入
  `/root/.ssh/authorized_keys` 並停用 root 密碼認證。公鑰於設定頁管理。
- `credential_type: "password"`：攜帶 `root_password`（8–128 字元），沿用
  chpasswd 設定 root 密碼。密碼僅存在於單次請求，不寫入 D1、不進稽核日誌。

SSE 進度事件 `credentials_ready` 僅公布 `username` 與 `credential_type`，
不攜帶任何機密；部署結果的 `password` 欄位在公鑰模式下為空字串。

## D1 Migrations

migrations 位於 `server/db/migrations`，由 `wrangler.jsonc` 的 `migrations_dir` 引用：

- `0001_init.sql`：machines、operation_log 等基礎資料表（login_rate_limit 已於 0004 移除）。
- `0002_seed_legacy_machine.sql`：既有機器種子資料。
- `0003_accounts_and_users.sql`：AWS 帳號資料表，並為機器及操作日誌加入 AWS 帳號關聯；建立第一個 AWS 帳號時，尚未關聯的舊機器會自動歸入該帳號。
- `0004_drop_console_users.sql`：改用 SSO 後移除密碼使用者與登入限流資料表。
- `0005_sso_config.sql`：OOBE 初始設定的 SSO 設定表。
- `0006_ssh_public_keys.sql`：部署用的 SSH 公鑰庫資料表。
- `0007_pending_sso_setup.sql`：OOBE 驗證前的短效加密設定暫存表。

## 已知建置注意事項

- **受保護頁面一律動態渲染**：`(console)/layout.tsx` 使用 `export const dynamic = "force-dynamic"`。CI（Linux）建置會把頁面靜態預渲染，請求時守衛在預渲染殼上觸發動態 API 會丟 `DYNAMIC_SERVER_USAGE` 導致 500。
- **HeroUI Table 需包 `<NoSsr>`**：Table 的 SSR 在 CI 建置的 bundle 上會觸發 react-aria collections 錯誤；頁面透過 `table-lazy.ts` 轉介 namespace，並以 `no-ssr.tsx` 的掛載閘門包住。
- **OpenNext minimal mode**：`wrangler.jsonc` 設 `NEXT_PRIVATE_MINIMAL_MODE=1`，繞過 opennextjs-cloudflare #1232 的 `getMiddlewareManifest()` 問題（本專案不用 Next middleware，守衛在 layout 實作）。
- **生產錯誤觀測**：`src/instrumentation.ts` 的 `onRequestError` hook 會把被 Next 遮蔽的 RSC 錯誤（digest／stack）寫入 console，搭配 `wrangler.jsonc` 的 `observability.enabled` 可在 Cloudflare Dashboard 的 Workers Logs 查得。

## 執行期限制

- **Workers 子請求上限**：部署流程在單次 Worker 呼叫內以輪詢等待執行個體就緒
  （`waitForInstanceRunning` / `waitForPublicDns` / `waitForStatusOk` /
  `waitForCloudInit`），累計子請求可能觸及 Cloudflare 免費方案的單次呼叫上限
  （50 個）。逾限時 SSE 會回報 `Too many subrequests by single Worker invocation`，
  且部署結果帶 `ready: false` 與 `wait_error`。**此時執行個體通常已成功啟動**，
  只是就緒檢查未完成——請保存回傳的連線憑證，稍後直接連線或至 AWS 主控台確認。
  付費方案上限較高，一般不會遇到。
- **前端 SSE 閒置逾時**：`src/lib/deployment-stream.ts` 以 90 秒閒置逾時判定連線
  中斷（非總時長），避免部署頁在連線被中介代理悄悄切斷時永久停在「部署流程執行中」。
  串流結束若未收到 `result` 或 `error` 事件，一律視為失敗而非成功。
