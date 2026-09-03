# 部署

從零到可以用，大約一小時。每一步都標了「怎麼確認這一步成功了」，
因為這條鏈上任何一環悄悄壞掉，症狀都是幾週後才發現卡片沒有備份。

```
GCP e2-micro
├── /srv/app          ← 程式碼 repo
├── /srv/corpus       ← 語料庫 repo（deploy key 有寫入權）
├── /srv/index.db     ← SQLite，不進版控，隨時可刪
└── systemd: skynote-cards.service + cloudflared.service
```

---

## 0. 先知道兩件會花錢／出事的事

**asia-east1 的 e2-micro 不在免費額度內。** GCP 的永久免費 e2-micro 只有
us-west1 / us-central1 / us-east1。asia-east1 大約每月 6–8 美金。
台灣連 us-central1 的延遲大概多 150–200ms，對這個用途（送出後就導頁）
其實無感，但打字時的連結搜尋會有感。自己權衡。

**Cloudflare Access 的 policy 必須在建立公開主機名稱之前就設好。**
這支程式**完全不實作驗證**，它信任所有到得了它的流量都是你。
順序錯了，中間那段時間任何人都能讀你全部的卡片、也能寫入。

---

## 1. 兩個 GitHub repo

```
skynote-cards          ← 這個 repo（程式碼）
skynote-cards-corpus   ← 語料庫，設成 private
```

語料庫 repo 先推一個空骨架上去：

```bash
mkdir -p corpus/cards && cd corpus
printf 'index.db\nindex.db-journal\n*.tmp\n' > .gitignore
git init -b main && git add -A
git commit -m 'init' && git remote add origin git@github.com:organic-san/skynote-cards-corpus.git
git push -u origin main
```

`cards/` 是空的，git 不追蹤空目錄——沒關係，服務啟動時會自己建。

---

## 2. 開機器

```
機型     e2-micro
映像     Ubuntu 24.04 LTS minimal
磁碟     10GB standard（卡片是純文字，這個量級用不完）
防火牆   全部不勾。不要開 80、不要開 443。
```

外部 IP 可以設成「無」——所有連線都是機器主動打出去的（git push、
cloudflared）。這樣連 SSH 都得走 IAP，攻擊面小很多：

```bash
gcloud compute ssh skynote-cards --tunnel-through-iap
```

**確認**：`ss -ltn` 應該只有 SSH。

---

## 3. 基本環境

e2-micro 只有 1GB RAM，`npm ci` 很容易被 OOM killer 砍掉。**先加 swap**：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Node 24：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

**確認**：`node -v` 是 v24.x，`which node` 是 `/usr/bin/node`——
systemd unit 裡寫死的就是這個路徑。

服務帳號與目錄：

```bash
sudo useradd -r -m -d /srv/append -s /usr/sbin/nologin append
sudo mkdir -p /srv/app /srv/corpus && sudo chown -R append:append /srv
```

---

## 4. 語料庫的 deploy key

這把鑰匙**只給語料庫 repo**，而且要有寫入權——程式會 push 進去。

```bash
sudo -u append ssh-keygen -t ed25519 -N '' -f /srv/deploy_key
sudo cat /srv/deploy_key.pub
```

貼到 `skynote-cards-corpus` 的 Settings → Deploy keys → Add，
**Allow write access 要勾**。

```bash
sudo -u append git clone git@github.com:organic-san/skynote-cards-corpus.git /srv/corpus
sudo -u append git -C /srv/corpus config user.name  'skynote-cards'
sudo -u append git -C /srv/corpus config user.email 'skynote-cards@localhost'
```

clone 時會用到這把 key，所以先試一次：

```bash
sudo -u append env GIT_SSH_COMMAND='ssh -i /srv/deploy_key -o IdentitiesOnly=yes' \
  git -C /srv/corpus push
```

**確認**：`Everything up-to-date`。這一步不過，之後卡片就只會躺在本機。

---

## 5. 放程式碼、起服務

```bash
sudo -u append git clone git@github.com:organic-san/skynote-cards.git /srv/app
cd /srv/app
sudo -u append npm ci
sudo -u append npm run build

sudo cp deploy/skynote-cards.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now skynote-cards
```

**確認**：

```bash
curl -s localhost:3000/_health
# cards_files 與 cards_indexed 都是 0，git.enabled 是 true
journalctl -u skynote-cards -n 30
```

`git.enabled` 如果是 `false`，代表 `/srv/corpus/.git` 不在或權限不對，
備份是關掉的——先修這個再往下。

---

## 6. Cloudflare Tunnel

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflared-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

cloudflared tunnel login
cloudflared tunnel create skynote-cards
```

把 `deploy/cloudflared-config.yml` 複製到 `/etc/cloudflared/config.yml`，
填入 tunnel UUID 與你的子網域，然後裝 service：

```bash
sudo cp deploy/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared
```

**先不要建 DNS 記錄。** 下一步做完再建。

---

## 7. Cloudflare Access（做完這步才對外）

Zero Trust → Access → Applications → Add：

- Type：Self-hosted
- Domain：你的子網域
- Policy：Action **Allow**，Include → **Emails** → 只填你自己那一個
- 再加一條 policy：Action **Block**，Include → Everyone（放在 Allow 之後）
- Session duration 設長一點（例如 30 天），不然手機上每次都要重登，
  那正好會殺掉這個系統唯一在乎的東西：寫入摩擦

存檔之後才建 DNS：

```bash
cloudflared tunnel route dns skynote-cards cards.你的網域
```

**確認**：用無痕視窗開那個網址，應該先看到 Cloudflare 的登入頁，
而不是卡片列表。看到卡片列表就代表 policy 沒生效，**立刻把 DNS 記錄刪掉**。

---

## 8. 更新機制：pull 模式

沒有外部 IP，GitHub Actions 連不進來這台機器，所以不是「push 觸發部署」，
是反過來——**VM 自己每五分鐘去看一次有沒有新版本**。`.github/workflows/test.yml`
只負責在 push 時跑測試，不碰這台機器；真正的部署完全在 VM 這邊發生。

`deploy/pull-deploy.sh`、`deploy/skynote-cards-deploy.service`、
`deploy/skynote-cards-deploy.timer` 三個檔案已經在 repo 裡，拉下來的
`/srv/app` 自然就有：

```bash
sudo cp /srv/app/deploy/skynote-cards-deploy.service /etc/systemd/system/
sudo cp /srv/app/deploy/skynote-cards-deploy.timer   /etc/systemd/system/
```

腳本裡有一行 `sudo systemctl restart skynote-cards`，跑腳本的是 `append`
這個沒有登入權的帳號，所以要讓它不用密碼就能重啟服務：

```bash
echo 'append ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart skynote-cards' \
  | sudo tee /etc/sudoers.d/skynote-cards
```

打開 timer（**不要**啟動 `.service`——那個只給 timer 觸發，自己啟動只會跑一次就結束）：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now skynote-cards-deploy.timer
```

**確認**：

```bash
systemctl list-timers skynote-cards-deploy.timer
# NEXT 欄位應該是 5 分鐘內的某個時間

sudo systemctl start skynote-cards-deploy.service   # 手動催一次，不必等
journalctl -u skynote-cards-deploy -n 20
```

日誌裡最後一行如果是 `deploy: <舊commit> -> <新commit>`，代表這次真的抓到
新版本並重啟了；如果什麼都沒印，代表 `git fetch` 之後沒有變動——這是
正常情況，不是壞掉。

之後的日常流程就是：`git push` 到 `main`，最多等五分鐘，VM 自己會跟上。
不想等的話，隨時可以自己 SSH 進去 `sudo systemctl start skynote-cards-deploy`。

---

## 9. 上線後第一天要做的三件事

**一、確認備份真的到得了 GitHub。** 建第一張卡片，然後：

```bash
curl -s localhost:3000/_health   # unpushed_commits 應該是 0
```

再去 GitHub 上打開 `cards/`，看得到那個 `.md` 檔才算數。
`unpushed_commits` 是 `null` 代表分支還沒有 upstream——建第一張卡片時
程式會用 `-u` 推第一次，之後就有數字了。

**二、演練一次索引重建。**

```bash
sudo systemctl stop skynote-cards
sudo rm /srv/index.db
sudo systemctl start skynote-cards
```

頁面內容應該跟砍掉之前逐字相同。這一步是在驗證「檔案是唯一真相」
不是一句口號。

**三、演練一次整機遺失。** 在別的機器上 clone 語料庫 repo，
確認 `cards/*.md` 就是全部——沒有任何東西只存在於那台 VM 上。

---

## 之後的維運

只有兩件事：

- `GET /_health` — 檔案數、索引筆數、未 push 的 commit 數。
  未 push 的數字如果連續幾天不是 0，deploy key 或網路壞了。
- `POST /_reindex` — 回報解析失敗的檔案與壞連結清單。
  這是唯一會發現資料完整性問題的地方，值得每個月手動跑一次看報告。

沒有備份索引的必要，沒有資料庫遷移，沒有要清的暫存。
真的壞掉的話：砍掉 `/srv/index.db`、重啟，或整台機器重灌再 clone 兩個 repo。
