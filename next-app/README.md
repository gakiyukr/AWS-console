# Cloud Console（AWS + Oracle Cloud 多雲主控台）

單一 Cloudflare Worker 的多雲主控台：Next.js 16 App Router + React 19 + HeroUI 3，以 [OpenNext for Cloudflare](https://opennext.js.org/cloudflare) 打包部署，資料儲存於 Cloudflare D1。管理 AWS（EC2／Lightsail／Wavelength）與 Oracle Cloud（OCI 執行個體／保留 IP）的部署、電源與網路設定。

## 功能

- 以 OIDC SSO（Authorization Code + PKCE）登入，僅允許清單內的 email 進入主控台。
- 管理 D1 清單內 EC2 執行個體的即時狀態，並執行開機、關機、重啟、終止，
  以及「更換公網 IP」（stop → start）。
- 以「分享連結」對外發布免登入的公開網頁，讓訪客對綁定機器一鍵更換公網 IP；
  可一頁綁一機或多機，冷卻時間由連結自訂（0 表示不限），並可設定**每日更換
  次數上限**（跨綁定機器合計，0 表示不限；台灣時間為一日邊界），訪客頁會
  顯示今日已用次數、額度滿時按鈕停用。
- 分享頁可自後台開啟人機驗證，支援多渠道備援：[Cap](https://trycap.dev/)
  （自架實例）、Cloudflare Turnstile、hCaptcha；訪客點擊「一鍵換 IP」前須先
  通過驗證，憑證由伺服端 siteverify 驗證。渠道與密鑰於設定後臺管理（加密存 D1）。
- 出口代理池（HTTP／HTTPS／SOCKS5）：可為個別 AWS／OCI 帳號綁定出口代理，
  該帳號的所有雲端 API 呼叫改由代理出口（Workers 走 cloudflare:sockets 隧道）。
- DDNS（Cloudflare）：設定後臺可新增**多個域名**（各自 API Token 加密），
  並以「前綴 → 機器」集中綁定主機名（FQDN = 前綴 + 域名）；一台 EC2 機器
  可綁多個前綴。換 IP／開關機成功後自動更新對應 DNS A 記錄（DNS-only、
  TTL 60）。僅 EC2（非 Wavelength）；機器總覽只顯示綁定清單，管理在設定頁。
- EC2 與 Lightsail 完全分開：各自有機器總覽（`/ec2`、`/lightsail`）與
  新增機器表單（`/ec2/new`、`/lightsail/new`），首頁 `/` 轉址到 `/ec2`。
  機器以 `machines.platform`（ec2 / lightsail）區分，狀態查詢與電源操作
  依平台分流（Lightsail 走 GetInstances／StartInstance／StopInstance／
  RebootInstance／DeleteInstance）；Lightsail 不支援「更換公網 IP」。
- Oracle Cloud（OCI）整合：執行個體列表（即時 + 自訂別名）、五種電源操作
  （含強制關機／重啟）、更換臨時公網 IP（v4）、一鍵 IPv6 開通（VCN /56 →
  子網 /64 → 路由 → 安全清單 → VNIC 指派）、**一鍵換 IPv6**（刪除現有位址
  重新指派，未開通時自動先開通）、一鍵防火牆（Security List 全開 + 主機
  iptables 清理）、保留公網 IP 申請／綁定／釋放、建立執行個體（A1.Flex 上限、
  shape 過濾映像）。多 OCI 帳號以 API 簽章金鑰（PEM 加密）管理。
- 建立及初始化 AWS Wavelength Zone 所需的子網、Carrier Gateway、路由表與安全群組。
- 以獨立工作流部署一般區域 EC2、Wavelength 執行個體、Lightsail 執行個體與 SSH forwarder。
- 部署一般 EC2 時可選用 IPv6（完整開通 VPC/子網 CIDR、IGW 路由與安全群組規則）；
  機器總覽可對既有 EC2／Lightsail 機器一鍵開通 IPv6（EC2 指派後自動重開機一次）。
  Wavelength Zone 不支援 IPv6（AWS 限制）。
- 部署成功後自動將建立的執行個體登錄至電源管理清單。
- 保存電源操作與部署結果的稽核日誌。
- 在 D1 管理多組 AWS 帳號；AWS Secret 以 AES-256-GCM 加密後儲存。

## 目錄結構

```
next-app/
├── src/app/(console)/   # 受保護頁面（layout 內做頁面守衛，一律動態渲染）
│   ├── page.tsx         # 入口：轉址到 /ec2
│   ├── ec2/             # EC2 機器總覽（含 WL 機器，帶 WL 標籤）；
│   │                    #   new/ 為新增機器，內含切換分頁：一般 EC2 ↔ Wavelength EC2
│   ├── lightsail/       # Lightsail 機器總覽；new/ 為新增機器表單
│   ├── wavelength/      # 舊網址轉址到 /ec2/new/wavelength
│   ├── instances/       # OCI 執行個體總覽（9 操作）；new/ 為建立表單
│   ├── reserved-ips/    # OCI 保留公網 IP 管理
│   ├── accounts/        # AWS／OCI 帳號管理（分頁）
│   ├── logs/            # 稽核日誌
│   ├── share/           # 分享連結管理（對外一鍵換 IP）
│   └── settings/        # SSH 公鑰、DDNS 多域名／前綴綁定、人機驗證、出口代理池
├── src/app/login/、setup/  # 登入頁與 OOBE 初始設定
├── src/app/share/[token]/  # 公開分享頁（免登入，token 即憑證）
├── src/app/api/         # API 路由（見下方「API 範圍」）
├── src/server/          # 守衛（page-guard、api-guard）與後端工具層
├── src/lib/             # 前後端共用：regions、ssh-keys、deployment-stream、
│                        #   use-machines（AWS 總覽共用邏輯）、machine-display、ocid
├── src/components/      # AppShell、MachineTable、ConfirmDialog、Chip、NoSsr、
│                        #   ui/（Radix 化 select/switch/checkbox/input/label/textarea）
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

若 D1 與必要 Worker 設定正常，且目前沒有可用的 D1／環境變數 OIDC 設定，開啟受保護頁面會自動轉到 `/setup` 初始設定精靈。缺少或過短 `SETUP_TOKEN` 時，`/setup` 會在伺服端轉到 `/503?reason=setup_token_missing`。

1. 先設定 Worker 的 `SETUP_TOKEN` secret，再於頁面輸入相同的 **Setup Token**、綁定 email（完成驗證後僅此 email 能登入）與 IdP 資訊（Discovery URL，或三個明確端點）、Client ID／Secret。
2. 「測試連線」會先驗證 Setup Token，再解析 IdP metadata 驗證設定。
3. 「開始 SSO 驗證」會先把表單設定暫存至 D1，其中只有 Client Secret 以獨立 AAD 加密；OIDC 端點、Client ID 與綁定 email 以一般欄位儲存。之後導向 IdP 完成一次真實登入；**回頭的 email 與綁定 email 一致**時才提升為正式設定，並直接登入主控台。

瀏覽器的 `oidc_state` Cookie 只保存隨機 pending ID、state、nonce 與 PKCE verifier，不保存 Client Secret 或其他 OIDC 設定。pending 設定中的 Client Secret 使用獨立 AES-GCM AAD 加密，10 分鐘後失效。

從受保護頁面啟動 OOBE 的條件是：`DB` binding、D1 migration、`SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` 與 `SETUP_TOKEN` 均正常，且 D1 沒有 `sso_config` 設定、也沒有完整的 `OIDC_*` 環境變數設定。基礎設施或解密失敗時，受保護頁面會轉到 `/503` 診斷頁。`/setup` 頁面本身只檢查 Worker `SETUP_TOKEN` 是否存在且至少 32 bytes，因此直接開啟時可能仍會顯示表單。若頁面開啟後 Worker token 被移除或設短，setup API 會回應 503 JSON；若請求缺少或填錯 Setup Token，API 會回應 403，表單會顯示錯誤並留在 `/setup`。

設定完成後，正常流程會直接登入主控台；`/setup` 本身不會自動封鎖。保留有效 `SETUP_TOKEN` 時，直接開啟 `/setup` 仍可能看到表單，但提交 API 會因已有設定而回應 `409`；刪除 `SETUP_TOKEN` 後則會轉到 `/503`。若要重新設定，先停用或移除完整的 `OIDC_*` 環境變數，再清除正式與 pending 設定：

```bash
pnpm exec wrangler d1 execute DB --remote --command "DELETE FROM sso_config; DELETE FROM pending_sso_setup"
```

此外部 SQL 變更不會主動清除 Worker isolate 內最多約 60 秒的 OIDC 狀態快取；等待快取過期後才能再次啟動 OOBE。期間請保留有效的 `SETUP_TOKEN`。

### 以環境變數設定（替代管道）

不改用 OOBE 時，也可完全以環境變數提供設定（D1 內的 OOBE 設定優先於環境變數）。以 Cloudflare Access 為 IdP 的設定步驟：

1. Zero Trust → Access → Applications → Add → SaaS，自訂應用程式名稱（如 `aws-console`）。
2. 填入 redirect URI：`https://<domain>/api/auth/callback`。
3. Scopes 勾選 `openid`、`email`、`profile`，建立後取得 client ID 與 client secret。
4. 建立 Access policy，僅允許自己的 email。
5. 將頁面上的 OIDC 端點與憑證填入 Worker 的環境變數：`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_EMAILS` 與 `OIDC_CLIENT_SECRET` 必填；`OIDC_CLIENT_SECRET` 應設為 secret，其餘設為 vars。`.dev.vars.example` 只提供共用的本機測試密鑰，使用此模式時需另加這些 OIDC 變數。

若 IdP 未提供 discovery，改以 `OIDC_AUTHORIZATION_URL`、`OIDC_TOKEN_URL`、`OIDC_JWKS_URL` 明確指定端點即可，登入流程不變。

## Secrets 與環境變數

正式環境的 secrets 依設定模式而異：

OOBE 模式需要：

```bash
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY
pnpm exec wrangler secret put SETUP_TOKEN
```

人機驗證（Cap）的簽章密鑰已改為設定後臺配置（加密存 D1）；環境變量 `CAP_SECRET`、
`CAP_ENDPOINT`、`CAP_SITE_KEY` 僅作為遷移期 fallback（後臺未配置時使用），非必填。

以 `OIDC_*` 環境變數替代 OOBE 時，需要將 `SETUP_TOKEN` 換成 `OIDC_CLIENT_SECRET`：

```bash
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY
pnpm exec wrangler secret put OIDC_CLIENT_SECRET
```

- `SESSION_SECRET`：簽署登入 session（HMAC-SHA256），輪替後所有既有 session 失效。
- `CREDENTIAL_ENCRYPTION_KEY`：32 位元組 Base64 AES 主金鑰。遺失或更換後，既有 AWS 憑證無法解密。
- `SETUP_TOKEN`：OOBE 模式授權測試連線與啟動 SSO，長度至少 32 bytes；不寫入 D1、設定 Cookie 或 API 回應。設定完成後可刪除，但直接開啟 `/setup` 會轉到 `/503`，不影響既有登入流程。
- `CAP_SECRET`／`CAP_ENDPOINT`／`CAP_SITE_KEY`（選填）：人機驗證（Cap）的遷移期
  fallback。後臺（設定頁）已配置時以 D1 加密值優先；僅後臺與環境變量皆無配置時，
  管理介面的開關無法啟用。
- `OIDC_CLIENT_SECRET`：使用 `OIDC_*` 環境變數模式的 IdP 憑證；它必須設定為 Worker secret，不得寫入 D1 或版本庫。

OOBE 流程會把 Client Secret 以獨立 AAD 加密存入 D1；環境變數模式則直接從 Worker environment 讀取 `OIDC_CLIENT_SECRET`。`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_EMAILS` 等非機密設定以 Dashboard 的環境變數（vars）保存即可。可用下列命令產生 `SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` 或 `SETUP_TOKEN` 所需的隨機值：

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

啟用 IPv6（部署時勾選或一鍵開通）另需：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:AssociateVpcCidrBlock",
        "ec2:AssociateSubnetCidrBlock",
        "ec2:AssignIpv6Addresses",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeInternetGateways",
        "ec2:DescribeRouteTables",
        "ec2:DescribeNetworkInterfaces",
        "ec2:CreateRoute",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RebootInstances"
      ],
      "Resource": "*"
    }
  ]
}
```

Lightsail 的一鍵開通另需 `lightsail:SetIpAddressType` 與 `lightsail:GetInstance`。

### Oracle Cloud IAM 政策建議

OCI 側以 API 簽章金鑰（Tenancy/User OCID + Fingerprint + PEM）授權，建議為
主控台專用 IAM 群組（group）加上：

```
Allow group <group> to manage instance-family in compartment <compartment>
Allow group <group> to manage virtual-network-family in compartment <compartment>
Allow group <group> to read instance-agent-family in compartment <compartment>
```

- `manage instance-family`：執行個體列表／電源／建機／終止。
- `manage virtual-network-family`：VNIC、公網 IP 交換、IPv6 開通、Security List。
- `read instance-agent-family`：主機防火牆清理的 Run Command（需執行個體已啟用
  Oracle Cloud Agent 的 Compute Instance Run Command 外掛）。

帳號管理的「開通區域」功能需額外授予下列權限（EC2 EnableRegion 屬帳號層級
操作，AWS 要求同時具備 EC2 與 Account 兩個命名空間的權限）：（EC2 EnableRegion 屬帳號層級
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
  `GET` 支援 `?platform=ec2|lightsail` 篩選（省略回傳全部，分享管理頁用）；
  `POST` 以 body 的 `platform` 決定平台（Lightsail 的 identifier 是執行個體
  名稱，不受 EC2 的 `i-…` 正則限制）。狀態查詢依平台分流：EC2 用
  `DescribeInstances`、Lightsail 用 `GetInstances`，兩者互不拖累。
- `/api/machines/:id/action`：對清單內機器送出 `start`、`stop`、`reboot` 或
  `terminate`。依 `machine.platform` 分流：EC2 走 Start/Stop/Reboot/
  TerminateInstances，Lightsail 走 Start/Stop/Reboot/DeleteInstance。
  `reboot` 不會更換公網 IP；`terminate` 為不可逆操作，成功後
  執行個體被永久刪除並同步移除清單記錄。
- `/api/machines/:id/reboot-ip`：連續執行 stop → 等待 stopped → start，
  藉此更換公網 IP。Lightsail 機器回 400（不支援此機制）。
- `/api/machines/:id/ipv6`：為既有機器開通 IPv6（完整開通）。EC2 依序確保
  VPC `/56`、子網 `/64`、Internet Gateway 的 `::/0` 路由與安全群組 `::/0` 規則，
  再指派位址並重開機一次（約 1 分鐘，不更換 IPv4 公網 IP）；Lightsail 走
  `SetIpAddressType dualstack`。Wavelength 機器直接回 400。所有步驟先 Describe
  再寫入，重複執行安全。
- `/api/accounts`：AWS 帳號與加密憑證管理；`/:id/test` 可驗證憑證，`/:id/regions/enable` 可開通區域。
  建立帳號時自動快取該帳號的可用區域；`/:id/regions/cache` 提供快取讀取
  （`?platform=`＋`backfill=0` 唯讀模式）與手動重新整理（POST）。開機器的
  區域下拉一律讀快取。
- `/api/ssh-keys`：部署用 SSH 公鑰庫的列表、新增（上限 50 把）與刪除。
- `/api/ec2/*`：一般 EC2 的 Region、VPC、執行個體、作業系統選項與部署流程。
- `/api/lightsail/*`：Lightsail 的 Region、Blueprint、Bundle、執行個體清單
  （`instances`，供加入既有機器）與部署流程。
- `/api/share-links`：分享連結（對外一鍵換 IP 公開頁）管理；建立時由伺服端
  產生 token（明文儲存，URL 即憑證），`/:id` 支援 PATCH（名稱／冷卻／每日上限
  ／啟停用）與 DELETE。列表附每連結的 `dailyLimit` 與 `dailyUsed`。
- `/api/share/:token/*`：**公開端點（無須登入，token 即憑證）**——`machines`
  回傳綁定機器的即時狀態與公網 IP（含 `captchaEnabled`）；`rotate` 以 SSE 串流
  觸發換 IP（stop → start），並輪詢回報新公網 IP。冷卻按「連結×機器」以條件式
  UPDATE 原子搶鎖強制（429，憑證不消費）；每日配額以 UPSERT＋條件
  RETURNING 原子搶額（429，預檢不通過時完全不消耗）。token 無效或連結停用
  一律 404，不洩漏存在性。人機驗證啟用時，`rotate` 需攜帶 `captchaToken` 與 `captchaProvider`
  （cap／turnstile／hcaptcha），由伺服端 siteverify 驗證。
- `/api/share/cap/*`：**公開端點（相容保留）**——本地 Cap PoW 流程的
  `challenge`／`redeem`。多渠道 siteverify 模式下 rotate 走 `/api/captcha-settings`
  配置的伺服端驗證；人機驗證未啟用時回 404，啟用但缺密鑰時回 503。
- `/api/share-settings`：分享頁後台設定（守衛保護）——`GET` 回人機驗證開關與
  密鑰設置狀態；`PATCH` 更新開關，啟用時要求密鑰已設定（否則 400）。
- `/api/captcha-settings`：人機驗證（Cap）密鑰設定——`GET` 回配置狀態（密鑰不出
  伺服器）、`PUT` 驗證長度後加密存 D1、`DELETE` 移除密鑰並自動停用人機驗證。
- `/api/ddns/domains`：DDNS 域名 CRUD（多域名）；POST 先驗證 Token 可存取
  Zone 後加密儲存；DELETE 連帶清除該域名的前綴綁定（CF 記錄保留）。
- `/api/ddns/bindings`：前綴綁定列表／建立（POST `{domainId, prefix, machineId}`，
  建立後立即同步）；`/:id` DELETE 移除綁定。僅 EC2 非 Wavelength；同
  `(domain, prefix)` 唯一（409）。
- `/api/proxies`：出口代理池 CRUD；`POST /api/proxies/test` 可測「表單中未儲存」
  的代理，`POST /api/proxies/:id/test` 實測已存代理的出口 IP 與延遲。
  帳號（AWS／OCI）綁定代理後，該帳號的所有 API 呼叫改由代理出口
  （Workers 走 cloudflare:sockets 隧道、Node 走 agent）。
- `/api/instances`：OCI 執行個體列表（即時 ListInstances + VNIC 豐化 + D1 別名，
  每頁 20 台、`opc-next-page` 續頁）。`/api/instances/[id]`：單台查詢（前端電源
  輪詢用）與 DELETE（終止，可保留開機碟）。`/[id]/action`：`start`、`stop`、
  `force-stop`、`reboot`、`force-reboot`。`/[id]/reboot-ip`：刪除並重建臨時公網
  IP（SSE）。`/[id]/ipv6`：一鍵 IPv6 六步開通（SSE）。`/[id]/firewall`：Security
  List 全開，預設併發主機 iptables 清理（Cloud Agent Run Command）。`/[id]/
  host-firewall`：僅清理主機防火牆。`/[id]/alias`：自訂別名與備註。`/create-options`
  與 `/create-options/images`：建機選項聚合；`/create`：建立執行個體。
- `/api/oci-accounts`：OCI 帳號（API 簽章金鑰）CRUD；`/:id/test` 以 ListRegions
  驗證簽章。可綁出口代理（`proxyId`）。
- `/api/reserved-ips`：OCI 保留公網 IP 列表／申請；`/:id` PUT 綁定／解綁、DELETE 釋放。
- `/api/captcha-settings`：多渠道人機驗證後臺——`GET` 回全部渠道狀態、`PUT` 儲存
  單一渠道（provider：cap／turnstile／hcaptcha）、`DELETE ?provider=` 移除。
- `/api/logs`：可依 `account_id`、`action`、`status`、`limit` 讀取稽核日誌。

所有 `/api` 端點（SSO 登入流程、session 查詢與 `/api/share/:token/*` 公開
分享端點除外）都要求有效登入 session，且 session 內 email 必須在允許清單中。

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
- `0008_share_links.sql`：對外一鍵換 IP 的分享連結表與「連結×機器」綁定表
  （含各綁定的最後觸發時間，作為訪客側冷卻依據）。
- `0009_app_settings_and_cap.sql`：後台 KV 設定表（人機驗證開關），以及 Cap
  人機驗證的重放記錄（`cap_nonces`）與一次性兌換憑證（`cap_tokens`）兩張表。
- `0010_machine_platform.sql`：machines 加 `platform` 欄位（ec2 / lightsail），
  回填規則為 `instance_id` 以 `i-` 開頭者為 ec2，其餘為 lightsail；附
  `(platform, id)` 索引。EC2 與 Lightsail 的列表、狀態查詢與電源操作依此分流。
- `0011_account_regions.sql`：帳號區域快取表。新增帳號時抓取該帳號可用區域
  （EC2=opt-in 已啟用、Lightsail=完整清單）存入快取，開機器的區域下拉只讀
  快取（快取為空時自動回填 live）。更新點：建立帳號、開通區域成功、帳號頁
  手動重新整理。
- `0012_ddns.sql`：DDNS（Cloudflare）設定表（API Token 加密、單列）與
  machines 的 `ddns_hostname`／`ddns_record_id` 綁定欄位。換 IP／開關機成功
  後自動同步 A 記錄；僅 EC2（非 Wavelength）。
- `0013_captcha_settings.sql`：人機驗證（Cap）密鑰設定表（AES-256-GCM 加密、單列）。
- `0014_captcha_endpoint.sql`／`0015_multi_captcha_providers.sql`：人機驗證加入
  實例地址（endpoint）與站點公鑰（site_key），並擴充為多渠道（Cap／Turnstile／
  hCaptcha）的 `captcha_providers` 表，舊設定自動遷移。
- `0016_oci_accounts.sql`／`0017_oci_instances_and_aliases.sql`：OCI 帳號憑證
  （PEM 加密）、執行個體別名表，及 operation_log 的 OCI 關聯欄位。
- `0018_proxies.sql`：出口代理池（HTTP／HTTPS／SOCKS5，密碼加密），並為
  `aws_accounts`／`oci_accounts` 加 `proxy_id` 綁定（刪除代理時自動回直連）。
- `0020_share_link_daily_quota.sql`：分享連結每日配額——`share_links.daily_limit`
  欄位與 `share_link_daily_usage` 計數表（(share_link_id, day) 主鍵，day 為
  UTC+8 日期字串）。
- `0019_ddns_multi_domains.sql`：DDNS 改為多域名（`ddns_domains`）＋前綴綁定
  （`ddns_bindings`，`UNIQUE(domain_id, prefix)`）；舊單列設定與
  `machines.ddns_hostname` 自動遷移後移除舊表／舊欄。

## 已知建置注意事項

- **受保護頁面一律動態渲染**：`(console)/layout.tsx` 使用 `export const dynamic = "force-dynamic"`。CI（Linux）建置會把頁面靜態預渲染，請求時守衛在預渲染殼上觸發動態 API 會丟 `DYNAMIC_SERVER_USAGE` 導致 500。
- **HeroUI Table 需包 `<NoSsr>`**：Table 的 SSR 在 CI 建置的 bundle 上會觸發 react-aria collections 錯誤；頁面透過 `table-lazy.ts` 轉介 namespace，並以 `no-ssr.tsx` 的掛載閘門包住。
- **OpenNext minimal mode**：`wrangler.jsonc` 設 `NEXT_PRIVATE_MINIMAL_MODE=1`，繞過 opennextjs-cloudflare #1232 的 `getMiddlewareManifest()` 問題（本專案不用 Next middleware，守衛在 layout 實作）。
- **生產錯誤觀測**：`src/instrumentation.ts` 的 `onRequestError` hook 會把被 Next 遮蔽的 RSC 錯誤（digest／stack）寫入 console，搭配 `wrangler.jsonc` 的 `observability.enabled` 可在 Cloudflare Dashboard 的 Workers Logs 查得。
- **`cloudflare:sockets` 需間接 import**：`proxy.js` 以 `new Function("specifier", "return import(specifier)")` 間接取得 `cloudflare:sockets`——webpack／OpenNext esbuild／Turbopack 都會嘗試解析此自訂 scheme 而失敗，間接層讓字面路徑不存在於任何編譯產物。修改代理相關程式碼時請維持此模式，勿改回字面動態 import。

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
