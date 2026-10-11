# Lightsail 部署功能實作總結

## 已完成項目

### 後端 API 層
1. ✅ **AWS Lightsail API 工具** (`src/server/utils/aws-lightsail.js`)
   - 實作 AWS JSON 1.1 協議的 SigV4 簽章
   - 支援 Lightsail 特定的 API 端點與標頭
   - 30 秒請求逾時與錯誤處理

2. ✅ **Lightsail 部署邏輯** (`src/server/utils/lightsail-deploy.js`)
   - `listLightsailRegions()` - 取得可用 Region
   - `listLightsailBundles()` - 取得規格方案（Bundle）
   - `listLightsailBlueprints()` - 取得作業系統映像
   - `deployLightsailInstance()` - 完整部署流程
   - 自動配置靜態 IP 與防火牆規則（SSH port 22）

3. ✅ **API 路由**
   - `/api/lightsail/regions` - Region 清單
   - `/api/lightsail/bundles` - 方案清單
   - `/api/lightsail/blueprints` - Blueprint 清單
   - `/api/lightsail/deploy` - SSE 串流部署

### 前端頁面
4. ✅ **Lightsail 部署頁面** (`src/app/(console)/lightsail/page.tsx`)
   - 五步驟表單：帳號 → Region → Blueprint → Bundle → 憑證
   - 支援 SSH 公鑰與密碼兩種登入方式
   - 即時部署進度顯示（SSE 串流）
   - 部署結果複製與下載功能

5. ✅ **導覽整合** (`src/components/app-shell.tsx`)
   - 新增「Lightsail 部署」選單項目（閃電圖示）
   - 位於 EC2 與 Wavelength 部署之間

### 資料庫與整合
6. ✅ **部署登錄整合** (`src/server/utils/deployment-registration.js`)
   - 擴充 `collectDeploymentMachines()` 支援 `lightsail` 類型
   - 自動將部署成功的執行個體加入機器總覽

7. ✅ **稽核日誌整合** (`src/server/utils/deploy-sse-route.js`)
   - 透過共用骨架自動支援 `deploy_lightsail` action
   - 記錄部署參數、結果與時間戳記

## 技術特點

- **AWS JSON 1.1 協議**：與 EC2 的 Query API 不同，實作正確的 JSON API 簽章
- **簡化部署流程**：Lightsail 無需管理 VPC、Subnet、Security Group
- **共用基礎設施**：重用現有的 SSH 公鑰庫、AWS 帳號管理、稽核日誌
- **一致的使用體驗**：與 EC2/Wavelength 部署頁面保持相同的 UI 模式

## 驗證結果

- ✅ TypeScript 類型檢查通過
- ✅ ESLint 程式碼檢查通過
- ✅ Next.js 生產建置成功
- ✅ 路由正確註冊為動態路由（`ƒ /lightsail`）

## Lightsail vs EC2 差異

| 特性 | EC2 | Lightsail |
|------|-----|-----------|
| API 協議 | Query API (XML) | JSON 1.1 |
| 網路管理 | 需手動建立 VPC/Subnet/SG | 自動建立 |
| 規格選擇 | Instance Type | Bundle (預定義方案) |
| 映像選擇 | AMI ID | Blueprint ID |
| 靜態 IP | Elastic IP (手動) | 內建自動分配 |
| 定價模式 | 按需計費 | 固定月費 |

## 使用流程

1. 登入主控台後點選「Lightsail 部署」
2. 選擇 AWS 帳號與 Region
3. 選擇作業系統 Blueprint（如 Ubuntu、Debian）
4. 選擇規格 Bundle（顯示 CPU、RAM、月費）
5. 輸入執行個體名稱與登入憑證
6. 點擊「開始部署」，即時查看進度
7. 部署成功後自動加入機器總覽，可執行電源管理操作

## 檔案清單

**新增檔案：**
- `next-app/src/server/utils/aws-lightsail.js`
- `next-app/src/server/utils/lightsail-deploy.js`
- `next-app/src/app/api/lightsail/regions/route.ts`
- `next-app/src/app/api/lightsail/bundles/route.ts`
- `next-app/src/app/api/lightsail/blueprints/route.ts`
- `next-app/src/app/api/lightsail/deploy/route.ts`
- `next-app/src/app/(console)/lightsail/page.tsx`

**修改檔案：**
- `next-app/src/components/app-shell.tsx` - 新增導覽項目
- `next-app/src/server/utils/deployment-registration.js` - 支援 lightsail 類型
- `next-app/README.md` - 更新功能說明與 API 文件
