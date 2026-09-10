# Next.js 與 HeroUI 遷移契約

## 目標

本目錄是現有 Nuxt 應用程式的平行遷移版本。完成正式驗收前，禁止以此 Worker 覆蓋 `aws-console`，也不得移除現有 Nuxt 程式。

## 固定路由

| 路由 | 功能 | 存取限制 |
| --- | --- | --- |
| `/` | 機器總覽與電源操作 | 已登入 |
| `/ec2` | EC2 部署 | 已登入 |
| `/wavelength` | Wavelength 部署 | 已登入 |
| `/accounts` | AWS 帳號管理 | 已登入 |
| `/logs` | 操作日誌 | 已登入 |
| `/settings` | SSH 公鑰與系統設定 | 已登入 |
| `/login` | OIDC 登入 | 公開 |
| `/setup` | 首次 SSO 設定 | 僅未設定時公開 |
| `/401`、`/403`、`/404`、`/500`、`/503` | 錯誤頁 | 公開 |

## 固定後端契約

- 保留既有 33 個 `/api/*` 路由的 HTTP method、查詢參數、request body、response body 與錯誤碼。
- `DB` 必須繼續指向既有 D1；migration 來源維持 `server/db/migrations`。
- `SESSION_SECRET` 與 `CREDENTIAL_ENCRYPTION_KEY` 必須由 Cloudflare secret 提供，不得寫入程式碼或 Git。
- OIDC callback 固定為 `/api/auth/callback`，session cookie 的安全屬性與既有實作一致。
- AWS 帳號密鑰、OIDC Client Secret 與部署憑證必須維持既有加密與遮罩行為。

## 分階段驗收

1. Next.js、HeroUI 與 OpenNext 可完成 lint、型別檢查、Next build 與 Workers build。
2. 登入、OOBE、session 與錯誤頁先完成遷移並通過正式 IdP 回歸。
3. 依序遷移機器總覽、EC2、Wavelength、帳號、日誌與設定頁。
4. 所有既有 Node 測試與新 React 測試通過後，才允許切換正式 Worker。

## 部署保護

預覽 Worker 固定命名為 `aws-console-next-preview`。正式切換必須另行審查 `wrangler.jsonc`、D1 binding、secrets 與 Cloudflare 路由，不得只修改名稱後直接部署。
