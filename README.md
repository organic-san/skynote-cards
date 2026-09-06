# Skynote (append-cards)

個人專用的卡片思考庫。資料只新增、不修改，Markdown 檔案是唯一真相，SQLite 只是投影。
系統承載四類內容：資料（`original`）、重述（`restatement`）、思考（`thinking`）與碎片（`fleeting`）。
卡片依時間戳發號，連結只能指向已存在的舊卡片，整張網絡自然形成有向無環圖（DAG）。建立後享有反芻期（預設 8 小時），一旦被後續卡片引用或時窗結束即永久定案。

---

## 設計意圖

### 1. 檔案是唯一真相，SQLite 只是投影
- **脈絡**：一個資料庫檔案（`.db`）在十年、二十年後可能因格式演化或檔案損毀而打不開，但檔案系統上的一疊純文字 Markdown 幾十年後依然讀得開。
- **作法**：任何時候刪除 `index.db`，系統都能從 Markdown 檔案重新計算出完全等價的索引與視圖。因此不需資料庫備份或複雜遷移，系統隨時可以原地重算。

### 2. 目標不可變與有向無環圖（DAG）
- **脈絡**：網頁與筆記系統中的連結之所以會隨時間喪失語意，是因為它們指向了隨時會被修改或刪除的目標；目標一旦永久不可變，連結就永遠有效。
- **因果單向性**：新卡片的連結只能指向已存在且 ID 較小的舊卡片。這帶來兩個核心特性：
  - **寫入無需回頭修改**：建立關聯永遠只需要產出一份新檔案，不需修改舊檔案。
  - **結構必然無環**：整座思考庫嚴格構成有向無環圖（DAG），任何主張都能往前回溯出清晰完整的推導與依據鏈。
- **無獨立關聯物件**：若發現兩張舊卡片有關聯，唯一方式是寫一張新卡片同時指向兩者——「發現兩個舊想法有關」本身就是一次新的思考，理應具備自己的節點。

### 3. 型別的判準：錯的時候怎麼修
型別的劃分不是依據篇幅長短或排版樣式，而是依據「這張卡出錯時該如何修正」的責任歸屬：
- **資料 (`original`)**：不是我寫的一手材料。錯的方式是抄錯或存錯 $\to$ 重新存一份正確的副本。
- **重述 (`restatement`)**：對原文負責的個人轉述。錯的方式是誤讀 $\to$ 重讀原文，發布新的重述並以 `updates` 指回。
- **思考 (`thinking`)**：對外部世界負責的個人主張。錯的方式是命題為假 $\to$ 換一個主張，發布新的思考並以 `updates` 指回。
- **碎片 (`fleeting`)**：隨手記下的一句話，需要一個不必承擔嚴肅責任的去處。它的唯一預期生命週期是未來被「完整化」為思考（發布 `thinking` 並用 `updates` 指回），或純粹安靜留存。

### 4. 反芻期與因果定案
- **脈絡**：寫入當下需要沉澱與微調，因此系統提供預設 8 小時的反芻時窗（足以跨越一個工作段落）。
- **因果鎖定（有人依賴你就定案）**：不可變是引用可靠的前提（例如段落引用錨點 `#b3` 的穩定性）。因此定案的最高準則是因果而非純時間——**一旦有任何後續卡片建立了指向本卡的連結，本卡即刻定案**，關閉編輯與刪除權限。

### 5. 寫入摩擦是生死線
- **脈絡**：使用者不會因為一次系統錯誤而放棄，但會因為每一次幾秒的延遲、繁瑣的分類決策與必填欄位而「等等再記」，最後系統安靜地荒廢。
- **作法**：
  - 隨手記浮層不填標題即為碎片，填了標題即為思考，消除分類猶豫。
  - 關聯建立直接長在當前閱讀的卡片詳細頁上（「先導航，再建立」），自動預填型別與關聯，無需手動複製貼上 ID。
  - 寫入時本機檔案落地即回傳成功，Git commit 與 push 一律非同步背景執行，網路延遲或斷線絕不卡住寫入。

---

## 執行環境與本機開發

- **環境需求**：Node.js >= 22（建議使用 Node 24 LTS）、Git。

```bash
npm install                     # 安裝相依套件
npm run build                   # 編譯 TypeScript 並複製模板資源
npm test                        # 執行完整驗證測試
npm run dev                     # 開發模式（熱重載，預設監聽 127.0.0.1:3000）
```

主要環境變數（可設定於 `.env`）：
- `CORPUS_PATH`：卡片資料目錄路徑（內含 `cards/` 放 `.md` 卡片檔）。
- `INDEX_PATH`：SQLite 索引資料庫檔案路徑（預設 `./index.db`）。
- `PORT`：HTTP 監聽連接埠（預設 `3000`）。
- `EDIT_WINDOW_HOURS`：反芻修改時窗小時數（預設 `8`）。

---

## Linux 伺服器部署

部署架構採用雙 Git 儲存庫分離：程式碼儲存庫與存放純 Markdown 的私有卡片儲存庫。

```
/srv/app          ← 程式碼儲存庫
/srv/corpus       ← 卡片儲存庫（具備寫入權限的 deploy key）
/srv/index.db     ← SQLite 索引（不納入版本控制，隨時可刪除重建）
```

### 1. 準備目錄與服務帳號
```bash
sudo useradd -r -m -d /srv/append -s /usr/sbin/nologin append
sudo mkdir -p /srv/app /srv/corpus && sudo chown -R append:append /srv
```

### 2. 卡片儲存庫與程式碼設定
1. 於 GitHub 卡片儲存庫設定具備寫入權限的 Deploy Key（私鑰放於 `/srv/deploy_key`）。
2. Clone 卡片儲存庫至 `/srv/corpus`，設定使用者名稱與 Email。
3. Clone 程式碼至 `/srv/app`，執行安裝與建置：
   ```bash
   cd /srv/app && sudo -u append npm ci && sudo -u append npm run build
   ```

### 3. 安裝 systemd 服務
```bash
sudo cp deploy/skynote-cards.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skynote-cards
```
對外流量建議使用 Cloudflare Tunnel（搭配 Cloudflare Access 驗證）接入本機 `127.0.0.1:3000`，伺服器不需對外開放任何通訊埠。

---

## 服務管理與維運

| 動作 | 指令 |
|---|---|
| **啟動服務** | `sudo systemctl start skynote-cards` |
| **中斷服務** | `sudo systemctl stop skynote-cards` |
| **重啟服務** | `sudo systemctl restart skynote-cards` |
| **查看即時日誌** | `journalctl -u skynote-cards -f` |
| **健康檢查** | `curl -s http://127.0.0.1:3000/_health` |
| **手動重建索引** | `curl -s -X POST http://127.0.0.1:3000/_reindex` |

### 災難復原與備份
- **索引損毀**：停止服務後直接刪除 `/srv/index.db*`，重啟服務即會自動由 `cards/*.md` 完整等價重建。
- **資料備份**：每張卡片落地後自動非同步排入 Git commit 與 push，即使網路斷線也會先安全寫入本機檔案，待重試或重啟時自動補推。
