# Cloud Console

單一 Cloudflare Worker 的多雲主控台 Cloud Console（AWS EC2 電源管理、Wavelength／一般 EC2 部署、Oracle Cloud OCI 執行個體與網路、多帳號管理、OIDC SSO 登入、出口代理池、DDNS，並可發布對外的「一鍵換 IP」分享頁），完整程式與文件都在 [`next-app/`](./next-app/README.md)。

## 部署

由 Cloudflare Workers Builds（git 整合）自動部署：push 到 `main` 後以 `next-app` 為根目錄構建並 `wrangler deploy`。Worker 名稱 `aws-console`，正式 D1 binding `DB`，migrations 位於 `next-app/server/db/migrations`。細節（構建命令、secrets、SSO 設定、IAM 權限、API 範圍）見 [`next-app/README.md`](./next-app/README.md)。
