# 部署到 App Engine

放在自己的機器上（VM 等）參見 [vm.md](vm.md)。

```
GitHub（skynote-cards）──push main──▶ GitHub Actions：測試 → gcloud app deploy

你 ──Google 登入（IAP）──▶ App Engine（asia-east1，F1，一台常駐）
                             ├─ /tmp/corpus    語料庫副本（開機時 clone）
                             ├─ /tmp/index.db  索引（開機時重建）
              寫入先存這裡 ──┼─▶ Cloud Storage：<專案 ID>-corpus
              背景推送 ──────┴─▶ GitHub：skynote-cards-corpus
```

App Engine 的 `/tmp` 在記憶體裡，換機器就會清空：

- 寫卡時先存進 bucket（失敗回 503，草稿留在瀏覽器），成功才寫 `/tmp` 與索引，最後在背景 commit、push 到 GitHub。
- 開機時、按側欄「更新」時，或背景 push 因遠端較新被拒時，都會將 git 與 bucket 對帳（[`src/store/reconcile.ts`](../src/store/reconcile.ts)）、補推尚未上 GitHub 的寫入並重建索引。新版開機一分鐘後會再對帳一次，接住流量切換期間舊版收到的寫入；`max_instances: 1` 偶爾短暫並存兩台時，另一台剛寫的卡也會在下次對帳時同步過來。
- 除前端由 IAP 攔截外，程式端也會驗證 IAP 簽發的 JWT（[`src/web/iap.ts`](../src/web/iap.ts) 的 `REQUIRE_IAP`）。環境設定見 [`app.yaml`](../app.yaml)。

---

以下指令在裝有 `gcloud` 的終端機或 GCP 主控台右上角的 Cloud Shell 執行。先把這四個變數改成你的設定（開新終端機要重貼）：

```bash
PROJECT=skynote-xxxxxx        # 新專案 ID（全球唯一）
REGION=asia-east1
GMAIL=you@gmail.com           # 要登入使用的 Google 帳號
APP_SA=$PROJECT@appspot.gserviceaccount.com
```

## 1. 專案與 API

App Engine 一個專案只能建一個，而且區域選了不能改，建議開獨立的新專案並綁定付款帳戶：

```bash
gcloud projects create $PROJECT
gcloud billing accounts list
gcloud billing projects link $PROJECT --billing-account=XXXXXX-XXXXXX-XXXXXX
gcloud config set project $PROJECT

gcloud services enable appengine.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iap.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com
```

**確認**：`gcloud services list --enabled` 列得出上面七個服務。

## 2. App Engine 應用程式

```bash
gcloud app create --region=$REGION
```

**確認**：`gcloud app describe` 的 `locationId` 是 `asia-east1`，且 `gcloud iam service-accounts list` 裡有 `$APP_SA`。

## 3. Bucket

名稱必須是 `<專案 ID>-corpus`（對應 `app.yaml` 的 `{project}-corpus`）：

```bash
gcloud storage buckets create gs://$PROJECT-corpus --location=$REGION \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-corpus \
  --member=serviceAccount:$APP_SA --role=roles/storage.objectAdmin
```

建好後保持空置即可，第一次部署開機時程式會自動把 GitHub 上的現有卡片傳進來並標上對帳記號（手動上傳的物件沒有記號，對帳時只能退回較保守的判斷）。

**確認**：`gcloud storage buckets describe gs://$PROJECT-corpus --format='value(location)'` 是 `ASIA-EAST1`。

## 4. GitHub Token

到 GitHub 建一把 fine-grained token（以下連結已預填名稱、擁有者 `organic-san`、366 天效期與 `contents=write`）：

<https://github.com/settings/personal-access-tokens/new?name=skynote-app-engine&target_name=organic-san&expires_in=366&contents=write>

- Repository access 選 **Only select repositories** → **`skynote-cards-corpus`**。
- Permissions → Repositories 確認 Contents 為 **Read and write**。

把 token 存進 Secret Manager 並授權給 App Engine（程式開機時由 [`src/bootstrap.ts`](../src/bootstrap.ts) 的 `useGitToken` 讀取並只對 `github.com` 生效）：

```bash
read -rs TOKEN                       # 貼上 token，畫面不會顯示
printf '%s' "$TOKEN" | gcloud secrets create corpus-git-token \
  --data-file=- --replication-policy=automatic
unset TOKEN
gcloud secrets add-iam-policy-binding corpus-git-token \
  --member=serviceAccount:$APP_SA --role=roles/secretmanager.secretAccessor
```

**確認**：`gcloud secrets versions list corpus-git-token` 有一個 `enabled` 版本。

## 5. IAP

個人 Gmail 沒有 GCP「組織」，需要先自建 OAuth 用戶端給 IAP 使用。

**5.1 OAuth 同意畫面。** 主控台 → API 和服務 → OAuth 同意畫面（Google Auth Platform）→ 開始：

- 應用程式名稱：`Skynote`；使用者支援與聯絡電子郵件：你的 Gmail
- 目標對象：**外部**

建好後到「目標對象」頁，按「發布應用程式」改成正式版（只用到基本登入範圍，不需送審），或維持「測試中」並把你的 Gmail 加進測試使用者。

**5.2 OAuth 用戶端。** Google Auth Platform → 用戶端 → 建立用戶端：

- 應用程式類型：**網頁應用程式**，名稱：`IAP Skynote`
- 記下建立後的**用戶端 ID**與**用戶端密鑰**
- 再點進這個用戶端編輯，在「已授權的重新導向 URI」加上：
  `https://iap.googleapis.com/v1/oauth/clientIds/<用戶端 ID>:handleRedirect`

**5.3 啟用 App Engine 的 IAP：**

```bash
read -rs SECRET                      # 貼上用戶端密鑰，畫面不會顯示
gcloud iap web enable --resource-type=app-engine \
  --oauth2-client-id=<用戶端 ID> --oauth2-client-secret="$SECRET"
unset SECRET
```

**確認**：`gcloud app describe --format='yaml(iap)'` 顯示 `enabled: true` 與你的用戶端 ID。若 `oauth2ClientSecretSha256` 是 `e3b0c442` 開頭，代表傳入的 `$SECRET` 是空字串，需重跑一次。

**5.4 授予你自己的帳號存取權**（專案擁有者不會自動包含這個權限）：

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member=user:$GMAIL --role=roles/iap.httpsResourceAccessor
```

## 6. 第一次部署與切換

**6.1 停掉舊的 VM（若從 VM 搬移）。** 在 VM 上確認沒有未推送的 commit 後停機：

```bash
curl -s localhost:3000/_health        # unpushed_commits 不是 0 就先在側欄按「更新」
sudo systemctl disable --now skynote-cards-deploy.timer skynote-cards
```

**6.2 部署。** 在這個 repo 的目錄下執行：

```bash
gcloud app deploy app.yaml --project $PROJECT
gcloud app logs tail -s default --project $PROJECT
```

日誌裡應出現：

```
開機對帳（gs://<專案 ID>-corpus，git cloned，…ms）：上傳 N、下載 0、刪除 0、衝突 0
corpus=/tmp/corpus index=/tmp/index.db store=gs://<專案 ID>-corpus iap=required
```

第一次的 `上傳 N` 即 GitHub 上的卡片數。

**6.3 驗證：**

- 無痕視窗開 App Engine 網址（`gcloud app describe --format='value(defaultHostname)'`）：先跳 Google 登入，用 `$GMAIL` 登入後看到卡片列表；換另一個 Google 帳號則顯示 `You don't have access`。
- 登入狀態下開 `/_health`：`store` 是 `gs://…`、`git.enabled` 是 `true`、`unpushed_commits` 是 `0`、`cards_files` 等於 `cards_indexed`。
- 寫一張測試卡再刪掉：GitHub 語料庫 repo 依序出現 `add <id>` 與 `rm <id>` 的 commit。
- `gcloud storage ls gs://$PROJECT-corpus/cards/ | wc -l` 等於卡片數。
- 刪掉現有執行個體測試換機（`gcloud app instances list` 查 ID，再 `gcloud app instances delete <ID> --service=default --version=<版本>`）：新機器起來後卡片都在，開機對帳為 `上傳 0、下載 0`。

## 7. 自動部署（GitHub Actions）

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 在 push 到 `main`（且改動到文件以外的檔案）時會先跑測試再部署，透過 Workload Identity Federation 驗證請求來自 `organic-san/skynote-cards` 的 `main` 分支：

```bash
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

gcloud iam service-accounts create github-deployer --display-name="GitHub Actions deploy"
DEPLOY_SA=github-deployer@$PROJECT.iam.gserviceaccount.com
for role in roles/appengine.appAdmin roles/cloudbuild.builds.editor roles/storage.admin \
            roles/artifactregistry.writer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member=serviceAccount:$DEPLOY_SA --role=$role --condition=None
done
gcloud iam service-accounts add-iam-policy-binding $APP_SA \
  --member=serviceAccount:$DEPLOY_SA --role=roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create github --location=global --display-name=GitHub
gcloud iam workload-identity-pools providers create-oidc skynote \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition="assertion.repository=='organic-san/skynote-cards' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding $DEPLOY_SA \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/organic-san/skynote-cards"

echo "GCP_PROJECT_ID   = $PROJECT"
echo "GCP_WIF_PROVIDER = projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/skynote"
echo "GCP_DEPLOY_SA    = $DEPLOY_SA"
```

把最後印出的三個值加進 GitHub repo → Settings → Secrets and variables → Actions → **Variables**。

**確認**：在 Actions 頁面手動執行 `ci`（選 `main`）或 push 程式改動到 `main`，`test` 與 `deploy` 皆通過，且 `gcloud app versions list` 只保留當前版本與上一版。

## 8. 收尾（可選）

**自訂網域。** 主控台 → App Engine → 設定 → 自訂網域 → 新增：

1. 驗證主網域（在 Cloudflare 加 TXT 記錄），對應時只留子網域 `cards.<你的網域>`（把預填的主網域與 `www` 刪掉）。
2. 在 Cloudflare 刪掉原本指向 Tunnel 的同名記錄，照畫面指示加上 Google 給的 DNS 記錄，並設為**「僅限 DNS」（灰雲）**，避免 Cloudflare 代理擋住 Google 簽發憑證。
3. 等 `gcloud app ssl-certificates list` 狀態變成 `OK` 後，再過幾分鐘 Google 前端就會生效。

**清理舊的 VM 與 Cloudflare 資源**（穩定運作幾天後）：

1. 刪除 VM 與開機磁碟。
2. 移除或刪除磁碟的快照排程，並把排程過去產生的快照篩選出來刪掉（磁碟刪除後快照仍會繼續計費）。
3. 到 GitHub 語料庫（及程式碼）repo 的 Settings → Deploy keys 刪掉 VM 用的金鑰。
4. 到 Cloudflare Zero Trust 刪掉 Tunnel、Access 應用程式與指向 `*.cfargotunnel.com` 的 DNS 記錄。

---

## 9. 維運

| 要做的事 | 怎麼做 |
|---|---|
| 看日誌 | `gcloud app logs tail -s default`，或主控台的 Logging |
| 健康檢查 | 登入後開 `/_health` |
| 重建索引並看完整性報告 | `POST /_reindex`（按側欄「更新」也會一併執行） |
| 換一台機器（等同重啟） | `gcloud app instances delete <ID> --service=default --version=<版本>` |
| 切回上一版 | `gcloud app versions list --service=default` 查版號，再執行 `gcloud app services set-traffic default --splits=<上一版 ID>=1` |
| 換 GitHub token | `printf '%s' "$NEW" \| gcloud secrets versions add corpus-git-token --data-file=-`，再換一台機器 |
| 增減可登入的帳號 | `gcloud projects add-iam-policy-binding $PROJECT --member=user:<Google 帳號> --role=roles/iap.httpsResourceAccessor`（移除用 `remove-iam-policy-binding`）。進得來的人擁有相同的完整讀寫權限 |

### 費用與映像檔清理

免費額度除 Logging 外皆按帳單帳戶合併計算，建議在「帳單 → 預算與快訊」設一個 1 美元的預算警示。

| 項目 | 這個系統的用量 | 免費額度 |
|---|---|---|
| App Engine F1 執行個體 | 一台常駐（24 小時／天）；部署時短暫多一台 | 每天 28 小時 |
| App Engine 對外流量 | 單人讀寫 | 每天 1 GB |
| Artifact Registry（`gae-standard`） | 每版約一兩百 MB，靠清除政策只留兩版 | 0.5 GB |
| Cloud Build | 每次部署數分鐘 | 每月 2,500 分鐘 |
| Secret Manager | 1 個 secret，開機讀一次 | 6 個版本、每月 1 萬次存取 |
| Logging | 少量 | 每個專案每月 50 GiB |
| Cloud Storage | 數 MB | 免費額度限美國區域，`asia-east1` 每月不到 0.01 美元 |

每次部署都會在 Artifact Registry 的 `gae-standard`（第一次部署後才會自動建立）留下容器映像檔。設定清除政策只留最新兩版並刪掉超過 7 天的舊檔，避免超過 0.5 GB：

```bash
cat > cleanup.json <<'EOF'
[
  {"name": "delete-old", "action": {"type": "Delete"},
   "condition": {"tagState": "any", "olderThan": "7d"}},
  {"name": "keep-two", "action": {"type": "Keep"},
   "mostRecentVersions": {"keepCount": 2}}
]
EOF
gcloud artifacts repositories set-cleanup-policies gae-standard --location=$REGION \
  --policy=cleanup.json --no-dry-run
```

### 常見問題

| 看到什麼 | 原因與處理 |
|---|---|
| 部署時 `staging.<專案 ID>.appspot.com` … `The specified bucket does not exist` | 暫存 bucket 未自動建出，跑 `gcloud beta app repair` 補建 |
| CI 部署在建置完後失敗：`You do not have permission to use the container` | `github-deployer` 缺 `roles/artifactregistry.writer`（第 7 節），補上後重跑 job |
| 第一次部署失敗，訊息指 `$APP_SA` 缺權限 | 新專案的建置可能改用該帳號，依錯誤訊息補上對應角色（如 Storage 管理員或編輯者） |
| 每一頁都是「需要經過 Google 登入（IAP）」的 403 | IAP 未啟用或未生效（第 5 節） |
| Google 顯示 `You don't have access` | 該帳號缺 `roles/iap.httpsResourceAccessor`（5.4） |
| 502 `Empty Google Account OAuth client ID(s)/secret(s)` | 未設定自訂 OAuth 用戶端（5.2、5.3） |
| 登入時 `redirect_uri_mismatch` | OAuth 用戶端漏填 `…:handleRedirect` 重新導向 URI（5.2） |
| `/_health` 的 `git.enabled` 是 `false` | 開機 clone 失敗，日誌搜「clone 語料庫失敗」檢查 token 或 secret 權限 |
| `unpushed_commits` 持續增加 | token 過期或權限有誤；更新 secret 後換一台機器 |
| 寫入回 503「暫時存不進去」 | Cloud Storage 寫入失敗，日誌搜「遠端寫入失敗」檢查 bucket 名稱或權限（第 3 節） |
| 「更新」頁出現「兩邊都改過，以網頁那份為準」 | 同一張卡在網頁改過尚未 push，又在別處修改並 push；被覆蓋的內容仍留在 git 歷史中 |
| 日誌「看起來不對（remote 設錯了？），這次一個都不刪」 | 對帳算出要刪除 bucket 上大量卡片而中止，先確認 `CORPUS_REMOTE` 是否指對 repo |
