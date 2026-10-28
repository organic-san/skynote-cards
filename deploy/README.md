# 部署到 App Engine

從零到穩定運作大約兩小時，大部分時間花在第 5 步的 IAP 與第 7 步的自動部署。
每一步都標了「怎麼確認這一步成功了」。

想放在自己的機器上（VM、Oracle 免費機器、家裡的小主機），見 [vm.md](vm.md)。

```
GitHub（skynote-cards）──push main──▶ GitHub Actions：測試 → gcloud app deploy

你 ──Google 登入（IAP）──▶ App Engine（asia-east1，F1，一台常駐）
                             ├─ /tmp/corpus    語料庫的副本（開機時 clone）
                             ├─ /tmp/index.db  索引（開機時重建）
              寫入先存這裡 ──┼─▶ Cloud Storage：<專案 ID>-corpus    ← 唯一真相
              背景推送 ──────┴─▶ GitHub：skynote-cards-corpus       ← 備份與歷史
```

- **bucket 是唯一真相。** 寫一張卡，要等 bucket 回應成功才算存好。App Engine 的 `/tmp`
  在記憶體裡，機器一換就沒了，它只是副本。
- **GitHub 是備份，不在讀寫的路上。** 存好之後才在背景 commit、push；GitHub 掛了照樣能寫。
- **開機時對帳。** clone 語料庫之後跟 bucket 比對，誰比較新就以誰為準（規則見
  [`src/store/reconcile.ts`](../src/store/reconcile.ts)），還沒推上去的寫入補 commit 推上去。
  側欄的「更新」做的是同一件事。
- **這支程式不做登入。** 擋人的是 IAP；程式另外檢查 IAP 簽的 JWT，
  沒有就一律 403（`REQUIRE_IAP`，見 [`src/web/iap.ts`](../src/web/iap.ts)）。

設定都在 [`app.yaml`](../app.yaml)，裡面不寫任何專案專屬的值，換專案不用改它。

---

## 0. 先知道的幾件事

**App Engine 的區域選了就不能改，一個專案只能有一個。** 選 `asia-east1`（台灣）。
所以建議為 Skynote 開一個新專案，不要放進已經有別的東西的專案。

**IAP 在第一次部署之前就要設好。** 程式本身會擋掉沒經過 IAP 的請求，
所以順序錯了不會外洩，但會看到滿版的 403。

**不要讓 VM 與 App Engine 同時寫同一份語料庫。** 兩邊各有一份副本，都會往同一個
GitHub repo 推。切換的順序在第 6 步。

**要綁付款帳戶。** App Engine 一律要求付款方式；這個用量在免費額度內，
但建議設一個預算警示（第 9 節）。

下面的指令在裝了 gcloud 的終端機裡跑：自己的電腦，或主控台右上角的 Cloud Shell
（開在瀏覽器裡，已經登入、不用安裝）。先把這四行改成你的值，貼進終端機執行，
後面指令裡的 `$PROJECT` 這些就會代入；開新的終端機要再貼一次：

```bash
PROJECT=skynote-xxxxxx        # 新專案的 ID，全球唯一，自己取
REGION=asia-east1
GMAIL=you@gmail.com           # 要能登入的那個 Google 帳號
APP_SA=$PROJECT@appspot.gserviceaccount.com   # App Engine 執行時的身分
```

---

## 1. 專案與 API

```bash
gcloud projects create $PROJECT
gcloud billing accounts list
gcloud billing projects link $PROJECT --billing-account=XXXXXX-XXXXXX-XXXXXX
gcloud config set project $PROJECT

gcloud services enable appengine.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iap.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com
```

**確認**：`gcloud services list --enabled` 列得出上面七個。

## 2. App Engine 應用程式

```bash
gcloud app create --region=$REGION
```

**確認**：`gcloud app describe` 的 `locationId` 是 `asia-east1`。
`gcloud iam service-accounts list` 裡有 `$APP_SA`。

## 3. bucket

```bash
gcloud storage buckets create gs://$PROJECT-corpus --location=$REGION \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-corpus \
  --member=serviceAccount:$APP_SA --role=roles/storage.objectAdmin
```

名字一定要是 `<專案 ID>-corpus`：`app.yaml` 裡寫的是 `{project}-corpus`。

**不要手動把卡片傳上去。** 第一次開機時 bucket 是空的，程式會把 GitHub 上的卡全部傳上去，
而且標好對帳要用的記號。手動上傳的物件沒有記號，對帳只能退回比較保守的判斷。

新 bucket 預設有 7 天的軟刪除（刪掉的物件 7 天內救得回來），留著它。

**確認**：`gcloud storage buckets describe gs://$PROJECT-corpus --format='value(location)'`
是 `ASIA-EAST1`。

## 4. GitHub token

App Engine 上沒有 SSH 金鑰可以放，改用 token 走 HTTPS。

GitHub 上建一個 fine-grained token。這個連結會先填好名稱、擁有者（`organic-san`）、
期限 366 天與 Contents 的寫入權限：

<https://github.com/settings/personal-access-tokens/new?name=skynote-app-engine&target_name=organic-san&expires_in=366&contents=write>

- Repository access：**Only select repositories** → **`skynote-cards-corpus`**。
  選「Public repositories」的話只有唯讀權限。
- 產生之前確認 Permissions 的 Repositories 分頁裡，Contents 是 **Read and write**。
- 期限可以改。過期之後推不上去（卡片照樣存在 bucket），換法見第 10 節。

存進 Secret Manager，只讓 App Engine 讀得到：

```bash
read -rs TOKEN                       # 貼上 token，畫面不會顯示
printf '%s' "$TOKEN" | gcloud secrets create corpus-git-token \
  --data-file=- --replication-policy=automatic
unset TOKEN
gcloud secrets add-iam-policy-binding corpus-git-token \
  --member=serviceAccount:$APP_SA --role=roles/secretmanager.secretAccessor
```

token 不寫進任何檔案：程式開機時讀 secret，用環境變數交給 git，只對 github.com 生效
（[`src/bootstrap.ts`](../src/bootstrap.ts) 的 `useGitToken`）。

**確認**：`gcloud secrets versions list corpus-git-token` 有一個 `enabled`。

## 5. IAP（只讓你自己進得來）

個人 Gmail 開的專案沒有「組織」，IAP 不能用 Google 代管的登入設定，
要自己建一組 OAuth 用戶端。少了這一步，開了 IAP 只會看到
`Empty Google Account OAuth client ID(s)/secret(s)` 的 502。

**5.1 OAuth 同意畫面。** 主控台 → API 和服務 → OAuth 同意畫面（Google Auth Platform）→ 開始：

- 應用程式名稱：`Skynote`；使用者支援電子郵件：你的 Gmail
- 目標對象：**外部**
- 聯絡資訊：你的 Gmail

建好之後到「目標對象」頁，二選一：

- 按「發布應用程式」改成正式版。只用到基本的登入範圍，不需要送審。
  發布不代表誰都能進：能不能進是 5.4 的權限決定的。
- 或維持「測試中」，把你的 Gmail 加進測試使用者。

**5.2 OAuth 用戶端。** Google Auth Platform → 用戶端 → 建立用戶端：

- 應用程式類型：**網頁應用程式**，名稱：`IAP Skynote`
- 建立後記下**用戶端 ID**與**用戶端密鑰**
- 再編輯這個用戶端，「已授權的重新導向 URI」加一條：
  `https://iap.googleapis.com/v1/oauth/clientIds/<用戶端 ID>:handleRedirect`

**5.3 打開 App Engine 的 IAP，並指定 5.2 的用戶端。** 用指令做：Google 的文件對 App Engine
建議用這個方式指定自訂用戶端，主控台的設定方式沒有寫支援 App Engine。

```bash
read -rs SECRET                      # 貼上用戶端密鑰，畫面不會顯示
gcloud iap web enable --resource-type=app-engine \
  --oauth2-client-id=<用戶端 ID> --oauth2-client-secret="$SECRET"
unset SECRET
```

**確認**：`gcloud app describe --format='yaml(iap)'` 有 `enabled: true` 與你的用戶端 ID。
`oauth2ClientSecretSha256` 是 `e3b0c442` 開頭的話，代表送出去的密鑰是空的（例如中間開了新的終端機，
`$SECRET` 不見了），重跑一次。第一次部署之前，主控台的 IAP 頁可能還看不到 App Engine。

**5.4 只放行你自己：**

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member=user:$GMAIL --role=roles/iap.httpsResourceAccessor
```

（主控台的說法是「IAP-secured Web App User」，在 IAM 頁授予存取權也行。
明確加上這個角色，不要依賴專案擁有者的身分：擁有者不會自動有這個權限。）

**確認**（第一次部署之後）：

- 無痕視窗開 App Engine 的網址（`gcloud app describe --format='value(defaultHostname)'`，
  長得像 `$PROJECT.<區域代碼>.r.appspot.com`）：先看到 Google 登入，登入後才是卡片列表。
- 用另一個 Google 帳號登入：看到「You don't have access」。
- 有登入時開 `/_health`：看得到 JSON。

## 6. 第一次部署與切換

**6.1 停掉舊的那一台。** 在 VM 上：

```bash
curl -s localhost:3000/_health        # unpushed_commits 必須是 0
sudo systemctl disable --now skynote-cards-deploy.timer skynote-cards
```

`unpushed_commits` 不是 0，先在側欄按一次「更新」，等它變 0 再停。
停了之後 VM 不會再寫，GitHub 上的語料庫就是全部。

**6.2 部署。** 第一次手動跑，看得到完整的輸出（在 Cloud Shell 的話，先把這個 repo
clone 下來、切到要部署的分支，在 repo 的目錄裡跑）：

```bash
gcloud app deploy app.yaml --project $PROJECT
gcloud app logs tail -s default --project $PROJECT
```

建置在 Google 那邊跑（`npm ci` → `npm run build` → 只留正式套件），幾分鐘。
日誌裡要看到兩行：

```
開機對帳（gs://<專案 ID>-corpus，git cloned，…ms）：上傳 N、下載 0、刪除 0、衝突 0
corpus=/tmp/corpus index=/tmp/index.db store=gs://<專案 ID>-corpus iap=required
```

第一次的 `上傳 N` 就是 GitHub 上的卡片數。

**6.3 確認到了穩定狀態**，一項一項打勾：

- [ ] 登入後首頁的卡片跟以前一樣多。
- [ ] `/_health`：`store` 是 `gs://…`、`git.enabled` 是 `true`、`unpushed_commits` 是 `0`、
      `cards_files` 等於 `cards_indexed`。
- [ ] 寫一張測試卡：幾秒內 GitHub 的語料庫 repo 出現 `add <id>` 的 commit。
- [ ] 刪掉那張測試卡（反芻期內可以刪）：出現 `rm <id>`。
- [ ] `gcloud storage ls gs://$PROJECT-corpus/cards/ | wc -l` 等於卡片數。
- [ ] 換一台機器：`gcloud app instances list` 找到那台，
      `gcloud app instances delete <ID> --service=default --version=<版本>`。
      一兩分鐘後新的一台起來，卡片都在，日誌的對帳是 `上傳 0、下載 0`。

全部打勾就是穩定狀態。VM 留著停機幾天再刪（第 8 節）。

## 7. 自動部署（GitHub Actions）

之後只要 push 到 main，[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 會先跑測試，
過了才部署。分支上不會自動跑。

GitHub 上不存任何金鑰：Workload Identity Federation 讓 Actions 拿 GitHub 簽的身分證明，
換一個短期的 GCP 憑證。GCP 那邊只認 `organic-san/skynote-cards` 的 main 分支。
repo 是公開的，這個條件就是安全邊界，別人 fork 之後跑的 workflow 換不到。

```bash
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

# 部署用的服務帳號與權限
gcloud iam service-accounts create github-deployer --display-name="GitHub Actions deploy"
DEPLOY_SA=github-deployer@$PROJECT.iam.gserviceaccount.com
for role in roles/appengine.appAdmin roles/cloudbuild.builds.editor roles/storage.admin \
            roles/artifactregistry.writer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member=serviceAccount:$DEPLOY_SA --role=$role --condition=None
done
gcloud iam service-accounts add-iam-policy-binding $APP_SA \
  --member=serviceAccount:$DEPLOY_SA --role=roles/iam.serviceAccountUser

# 只認這個 repo 的 main 分支
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

最後在 GitHub repo → Settings → Secrets and variables → Actions → **Variables**
（不是 Secrets，這三個值都不是祕密）新增上面印出來的三個值。
**設好的那一刻起，下一次 push 到 main 就會部署**；沒設的時候部署那一段會自動跳過。

上面的權限是照官方部署 action 與 App Engine 的說明整理的。建置出來的映像檔放在
Artifact Registry，部署的帳號少了 `roles/artifactregistry.writer` 的話，會在建置完之後才失敗
（`You do not have permission to use the container`）。自己在終端機部署不會遇到，
因為專案擁有者什麼權限都有。其他 permission denied 的訊息會寫缺哪個權限、缺在哪個帳號上，照著補。

**確認**：push 一個小改動到 main → Actions 頁面 `test` 與 `deploy` 都是綠的 →
`gcloud app versions list` 有新版本在接流量，舊版本只剩上一版。

## 8. 收尾（可選）

**自訂網域。** 主控台 → App Engine → 設定 → 自訂網域 → 新增，照指示驗證網域
（在 Cloudflare 加一筆 TXT），對應 `cards.<你的網域>`。它給的 DNS 記錄在 Cloudflare 加上，
**設成「僅限 DNS」（灰雲）**：經過 Cloudflare 代理的話，Google 的憑證可能簽不下來。
同一個主機名稱原本指向 Cloudflare Tunnel，先把那筆刪掉。
IAP 對自訂網域一樣有效；Cloudflare Tunnel 與 Access 之後都用不到了。

**刪掉 VM。** 確認穩定幾天之後，刪掉 VM、它的磁碟、快照排程與快照。
如果快照排程也掛在別的磁碟上，只把它從 Skynote 的磁碟拿掉，不要整個刪。

---

## 9. 日常

### 資料怎麼更新

**在網頁寫卡：**

```
驗證 → 存進 bucket（成功才算存好）→ 寫 /tmp 副本與索引 → 302 → 背景 commit、push
```

bucket 存不進去時回 503「暫時存不進去」，什麼都沒寫；草稿還在瀏覽器裡，稍後再送。

**在別處改卡片：** 在自己電腦的語料庫 clone 裡改、push，再按側欄的「更新」：

```
補 commit → git pull --rebase → 跟 bucket 對帳 → 補 commit、push → 重建索引
```

對帳時，取回來的修改會傳上 bucket。沒按「更新」就碰上換機器也沒關係，
開機做的是同一件事。

**push 被拒絕**（別處先推了）：自動跑一次「更新」再推，不用等人去按。
兩次之間至少隔五分鐘。

### 新版程式怎麼上線

```
在分支上開發 → 合併到 main → CI：測試 → 部署
  → Google 建置 → 新版開一台：clone、對帳、重建索引 → 流量切過去 → 舊版停掉
  → 新版開機一分鐘後再對帳一次（接住交接那幾秒舊版收到的寫入）
  → CI 刪掉更舊的版本，只留上一版
```

- 測試沒過：不部署。
- 建置失敗：舊版照跑，新版本是整批切換的。
- 新版一上線就壞：切回上一版，一行指令：

  ```bash
  gcloud app versions list --service=default
  gcloud app services set-traffic default --splits=<上一版的 ID>=1
  ```

  部署期間換版那幾十秒避免寫卡；真的寫了也不會掉，只是要等那一分鐘後的對帳才看得到。

### 可用性

| 發生什麼事 | 讀 | 寫 | 備份 |
|---|---|---|---|
| App Engine 換機器、部署 | 等幾秒 | 等幾秒 | — |
| Cloud Storage 故障 | 正常（讀 /tmp） | 503，草稿保留 | — |
| GitHub 故障、token 過期 | 正常 | 正常 | 延後；`/_health` 的 `unpushed_commits` 會增加 |
| 開機那一刻 GitHub 剛好掛了 | 正常 | 正常 | 這台機器停用 git 備份，換機器之後恢復 |
| Google 登入（IAP）故障 | 進不去 | 進不去 | — |
| asia-east1 整區故障 | 全部停擺 | 全部停擺 | — |

`max_instances: 1` 是盡力而為，偶爾會短暫有兩台。兩台同時寫也不會掉資料：
新卡的 ID 不會撞，上傳也要求物件不存在；只是一台看不到另一台剛寫的卡，
要等下一次對帳。

## 10. 維運

| 要做的事 | 怎麼做 |
|---|---|
| 看日誌 | `gcloud app logs tail -s default`，或主控台的 Logging |
| 健康檢查 | 登入後開 `/_health` |
| 手動重建索引 | `POST /_reindex`（不用，換機器也會重建） |
| 換一台機器 | `gcloud app instances delete <ID> --service=default --version=<版本>` |
| 換 GitHub token | `printf '%s' "$NEW" \| gcloud secrets versions add corpus-git-token --data-file=-`，再換一台機器 |
| 看花了多少錢 | 主控台 → 帳單；建議在「預算與快訊」設一個 1 美元的預算警示 |

**費用。** App Engine F1 一台常駐一天 24 小時，在每天 28 小時的免費額度內；
bucket 只有幾 MB；Secret Manager、Cloud Build、Logging 都在免費額度內。
建置出來的映像檔超過 0.5 GB 才收錢，CI 只留兩版就是為了這個。

### 出問題的時候

| 看到什麼 | 原因 |
|---|---|
| 部署時 `staging.<專案 ID>.appspot.com` … `The specified bucket does not exist` | App Engine 部署用的暫存值區沒有建出來。`gcloud beta app repair` 會補建 |
| CI 部署在建置完之後失敗：`You do not have permission to use the container` | `github-deployer` 少了 `roles/artifactregistry.writer`（第 7 節）。補上之後重跑失敗的 job |
| 第一次部署就失敗，訊息說 `$APP_SA` 缺某個權限 | 2024 年 6 月之後開的專案，建置可能改用這個帳號，權限不一定夠。照訊息替它補角色；Google 文件的解法是 Storage 管理員，或直接給編輯者 |
| 每一頁都是「需要經過 Google 登入（IAP）」的 403 | IAP 沒打開，或請求沒經過 IAP。程式在擋，不是壞了 |
| Google 的「You don't have access」 | 這個帳號沒有 `roles/iap.httpsResourceAccessor`（5.4） |
| 502 `Empty Google Account OAuth client ID(s)/secret(s)` | 沒有設自訂 OAuth 用戶端（5.2、5.3） |
| 登入時 `redirect_uri_mismatch` | OAuth 用戶端少了 `…:handleRedirect` 那條網址（5.2） |
| `/_health` 的 `git.enabled` 是 `false` | 開機時 clone 失敗。日誌搜「clone 語料庫失敗」：多半是 token 或 secret 的權限 |
| `unpushed_commits` 一直增加 | token 過期或權限不對。卡片在 bucket，不會掉；換 token、換機器 |
| 寫入回 503「暫時存不進去」 | Cloud Storage 寫入失敗。日誌搜「遠端寫入失敗」：權限（3）或 bucket 名稱 |
| 日誌「開機失敗」，機器一直重開 | 設定錯了，訊息會說是哪一個。程式寧可不開機，也不在設定不完整的狀態下對外 |
| 「更新」頁出現「兩邊都改過，以網頁那份為準」 | 同一張卡在網頁上改了、還沒推上去之前，又在別處改了推上去。git 那一份還在歷史裡 |
| 日誌「看起來不對（remote 設錯了？），這次一個都不刪」 | 對帳要刪掉 bucket 上一大批卡。先確認 `CORPUS_REMOTE` 指的是對的 repo |
