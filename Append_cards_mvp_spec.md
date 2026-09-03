# Append-only 卡片資料庫 — MVP 工程指南 v1

> 這份文件是給實作 agent 的完整規格。請完整讀完再開始寫任何程式碼。
> 第 1 節的 invariants 是硬約束，違反任何一條就是實作失敗，不論其他部分做得多好。

---

## 0. 目的與非目標

**目的**：一個只有作者本人能寫入與讀取的個人知識庫。承載三類內容——原始資料（他人的一手材料）、對原始資料的重述、以及自己的思考——並讓三者之間的關聯可以被建立與查詢。

**核心設計理念**：資料只新增，不修改。所有的組織方式（索引、分類、視圖）都是可以隨時刪除重算的投影，唯一的真相是檔案系統上那疊 markdown。

**非目標（MVP 明確不做，不要自作主張加上去）**：

- 任何 LLM / AI 整合（PDF 拆解、翻譯、自動連結建議、摘要）
- Discord bot 或任何第二條寫入路徑
- 圖形視覺化（force-directed graph、心智圖、樹狀圖）
- 附件上傳與儲存（只支援外部 URL）
- 標籤正規化、自動合併、同義詞
- 多使用者、權限、分享
- 任何超出「可讀」需求的 CSS 設計

---

## 1. Invariants（硬約束）

這些規則的存在理由寫在括號裡。理解理由，因為它們決定了哪些「改良」其實是破壞。

**I1. 檔案是唯一真相，SQLite 只是索引。**
任何時候刪掉整個資料庫檔案，系統都必須能從 markdown 檔完整重建，且結果完全等價。
（理由：資料要能活過任何一次技術選擇。一疊 markdown 二十年後仍可讀，一個 .db 不行。）

**I2. 卡片檔案在建立五分鐘後永久不可變。**
沒有 DELETE endpoint。沒有超過時窗的 PUT/PATCH。沒有任何 migration 腳本可以改寫既有卡片檔的內容。
（理由：連結會腐爛，是因為它指向可變的目標。目標不可變，連結就永遠有效。）

**I3. 連結只能指向已存在、且 ID 較小的卡片。**
建立時驗證：target 檔案必須存在，且 `target_id < source_id`（ID 可依時間排序，見 §3.1）。
（理由：這條規則讓「新增連結」永遠只需寫新檔案，不必回頭改舊檔案。它同時保證整張圖是 DAG，沒有循環，任何節點都能往回追出完整依賴鏈。）

**I4. 連結宣告在來源卡片的 frontmatter 裡，不存在獨立的「連結物件」。**
要連接兩張既有卡片，唯一的方式是建立一張新卡片同時指向兩者。
（理由：由 I3 推得——既然連結只能向後，一張卡片的出向連結在建立當下就已經完全確定，不可能後續增加。而「發現兩個舊想法有關」本身就是一個新的思考，它應該有自己的節點。）

**I5. 寫入路徑不得因備份失敗而阻塞。**
git push 失敗、網路中斷、遠端不可用——卡片都必須已經成功寫入本機檔案並回應成功。
（理由：寫入摩擦是這個系統唯一的生死線。使用者不會因為一次失敗而放棄系統，但會因為每一次延遲而「等等再記」，然後系統安靜地空掉。）

**I6. 索引重建必須是冪等的，且可隨時執行。**
`POST /_reindex` 砍掉重建，不需要停機，不需要備份索引。

---

## 2. 技術選型

已經定案，不要更換：

| 項目 | 選擇 |
|---|---|
| 語言/框架 | Node.js 20+ / TypeScript，Fastify |
| 模板 | Eta 或 Nunjucks（server-side render，不要 SPA） |
| DB | SQLite，`better-sqlite3`（同步 API，簡單） |
| Markdown | `markdown-it`（渲染）+ `gray-matter`（frontmatter 解析） |
| Git | `simple-git` |
| 部署 | GCP e2-micro + systemd |
| 對外 | Cloudflare Tunnel（不安裝 nginx，不開任何對外埠） |
| 驗證 | Cloudflare Access（Google IdP），應用程式內不實作任何登入邏輯 |

前端**不使用**任何框架、打包工具或 CSS 框架。手寫 HTML + 一個 `style.css`（可以很短）。目標是在手機瀏覽器上能用，不是好看。

---

## 3. 資料模型

### 3.1 ID

類 Snowflake 的 64-bit 整數，以十進位字串表示。

```
EPOCH = 2026-01-01T00:00:00Z  (1767225600000 ms)
id = ((Date.now() - EPOCH) << 22n) | BigInt(random 22 bits)
```

性質：可依時間排序（字串比較不可靠，一律轉 BigInt 比較）、唯一、無語義、檔名安全。

**絕不**在 ID 裡編碼類型、主題或層級。**絕不**重用或重編號。

### 3.2 檔案配置

兩個獨立的 git repository：

```
repo A: 程式碼
repo B: 語料庫（純資料，不含任何可執行檔）
  cards/
    1234567890123456789.md
    1234567890987654321.md
    ...
  .gitignore        # 忽略 index.db
```

MVP 階段所有卡片平放在 `cards/` 下。檔案數超過作業系統或工具的舒適區間之後再改成雜湊分桶（`cards/12/34/{id}.md`），屆時只需一支搬移腳本加上讀取路徑函式的修改，不影響任何卡片內容。

SQLite 索引檔放在語料庫 repo 外（例如 `/srv/index.db`），不進版控。

### 3.3 卡片檔案格式

一張卡片一個檔案，`{id}.md`，YAML frontmatter + markdown 內文。

```markdown
---
id: "1234567890123456789"
type: think
created: "2026-09-03T14:32:11.482Z"
title: 恆星不是近可分解性的反例，但它暴露了 Simon 沒寫的前提
tags: [物理, 複雜系統, simon]
url: null
archive_url: null
provenance: null
revised_at: null
links:
  - rel: about
    to: "1234567890111111111"
  - rel: refutes
    to: "1234567890222222222"
---

內文，markdown。可以是任意長度，包含 heading、list、code block、表格。
```

**欄位規格**

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 | 同檔名 |
| `type` | enum | 是 | `original` / `explan` / `think`，單選，建立時必須選擇 |
| `created` | ISO 8601 UTC | 是 | |
| `title` | string | 是 | 非空。這是使用者在列表上唯一會看到的東西 |
| `tags` | string[] | 是 | 可為空陣列。自由字串，不做正規化 |
| `url` | string \| null | 否 | 最多一個外部 URL |
| `archive_url` | string \| null | 否 | 手動填入的封存連結（Wayback 等） |
| `provenance` | enum \| null | 否 | 僅 `type: original` 可填：`self` / `published-translation` / `machine`。預設 `self` |
| `revised_at` | ISO 8601 \| null | 否 | 五分鐘時窗內被編輯過才有值 |
| `links` | object[] | 是 | 可為空陣列 |

**type 的語義**（寫進 UI 的說明文字，因為這三者的區分是整個系統的重點）：

- `original` — 不是我寫的。它不會錯，只會被我抄錯或存錯。裁判是原文。
- `explan` — 我寫的，但對原文負責。它錯的方式是誤讀。裁判是重讀一次。
- `think` — 我寫的，對世界負責。它錯的方式是命題為假。裁判是世界。

**rel 詞彙表**（封閉集合，不接受其他值）：

| rel | 語義 |
|---|---|
| `about` | 這張卡在講那張卡（explan → original 的典型關係） |
| `related` | 有關但關係未定型 |
| `supports` | 那張卡是這張卡的依據 |
| `contradicts` | 兩者不相容，但尚未裁決 |
| `refutes` | 這張卡推翻那張卡 |
| `supersedes` | 這張卡取代那張卡（同一主張的新版本） |

---

## 4. 驗證規則

建立卡片時的檢查，依序執行，任何一項失敗就整筆拒絕（不要部分寫入）：

1. `type` 必須是三個合法值之一。
2. `title` trim 後非空。
3. `tags` 每一項 trim 後非空，去重。
4. 每一條 link 的 `rel` 必須在詞彙表內。
5. 每一條 link 的 `to` 對應的卡片檔案必須存在。
6. 每一條 link 的 `to` 轉為 BigInt 後必須小於本卡 ID。（I3）
7. link 不得重複（同 `rel` + 同 `to`）。
8. `provenance` 只有在 `type: original` 時允許非空。

**警告（不阻擋寫入，但要在回應中回報並顯示在卡片頁面上）：**

- W1：`rel` 為 `refutes` 或 `supersedes`，但該卡沒有任何一條指向 `original` 或 `explan` 的連結。
  理由：不附證據的推翻，跟改變心情無法區分。這是目前刻意設為警告而非錯誤的一項，作者尚未決定要不要升級成硬性規則。

---

## 5. 寫入路徑

`POST /new` 的處理順序，這個順序不可調換：

```
1. 驗證 payload（§4）。失敗 → 400，不寫任何東西。
2. 產生 ID。
3. 組出 frontmatter + body，寫入暫存檔，fsync，rename 成 cards/{id}.md。
   （atomic write：先寫 .tmp 再 rename，避免半個檔案）
4. 寫入 SQLite（cards / tags / links 三張表 + FTS）。
   失敗 → 記 log，但仍回應成功（檔案已存在，索引可重建）。
5. 回應 302 導向 /c/{id}。
6. **非同步**觸發 git commit + push。不 await，不阻塞回應。（I5）
```

**Git 行為**：

- 每張卡片一個 commit，訊息就是 `add {id}`。
- 不開分支，不 rebase，不 force push。
- push 失敗：寫入 log 並排入重試佇列（簡單做法：一個每 5 分鐘跑一次的計時器，執行 `git push`，成功就清空）。
- 啟動時如果偵測到本機有未 push 的 commit，嘗試 push 一次。

**編輯時窗**（`PUT /c/{id}`）：

- 若 `now - created > 5 分鐘` → 403，訊息明確說明：「這張卡已鎖定。要更正內容請建立新卡片並使用 supersedes 連結。」
- 時窗內允許修改 `title`、`body`、`tags`、`url`、`archive_url`。
- **不允許**修改 `type`、`links`、`id`、`created`。
- 修改後設定 `revised_at`，重寫檔案，更新索引，git commit 訊息 `edit {id}`。

---

## 6. SQLite 索引

```sql
CREATE TABLE cards (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  created     TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  archive_url TEXT,
  provenance  TEXT,
  revised_at  TEXT,
  body        TEXT NOT NULL,
  link_count  INTEGER NOT NULL,
  tag_count   INTEGER NOT NULL
);

CREATE TABLE tags (
  card_id TEXT NOT NULL,
  tag     TEXT NOT NULL
);

CREATE TABLE links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rel       TEXT NOT NULL
);

CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_source ON links(source_id);
CREATE INDEX idx_tags_tag     ON tags(tag);
CREATE INDEX idx_cards_type   ON cards(type);
CREATE INDEX idx_cards_created ON cards(created);

CREATE VIRTUAL TABLE cards_fts USING fts5(
  id UNINDEXED, title, body, tokenize='unicode61'
);
```

`link_count` 與 `tag_count` 是冗餘欄位，刻意保留：作者要做一個為期數月的實驗，觀察自己最終傾向用標籤還是用連結來組織。這兩個數字加上 `created` 就是實驗資料。

**重建程序**（`POST /_reindex`，以及啟動時偵測到索引缺失或卡片數不符時自動執行）：

```
1. 建立新的暫存 db 檔。
2. 掃描 cards/*.md，逐檔解析 frontmatter。
3. 解析失敗的檔案：記錄到 log，不中斷整體流程。
4. 全部寫入後，rename 覆蓋舊 db。
5. 回報：處理檔案數、失敗檔案清單、指向不存在 ID 的壞連結清單。
```

第 5 步那份壞連結清單很重要——它是這個系統唯一會發現資料完整性問題的地方。

---

## 7. 頁面與端點

MVP 只需要這些。不要多做。

### `GET /new`
建立表單。這是最重要的一個頁面，設計目標是**在手機上從打開到送出不超過三次點擊加上打字**。

- type：三個大按鈕（原始資料 / 重述 / 思考），預設不選，必選
- title：單行輸入
- body：純 textarea，等寬字體。不要做即時預覽、不要做工具列、不要做 WYSIWYG
- tags：單行輸入，逗號或空白分隔
- url / archive_url：兩個選填單行輸入，預設收合
- links：可動態新增的列，每列一個 rel 下拉選單 + 一個目標卡片輸入框。目標輸入框要支援貼上 ID，也要支援打字搜尋標題（呼叫 `GET /api/search?q=&limit=10`，回傳 id + title）
- 送出按鈕

### `POST /new`
見 §5。

### `GET /c/{id}`
卡片檢視。內容依序：

1. type 標記、title、created
2. tags（可點擊，連到 `/?tag=x`）
3. url / archive_url（若有）
4. 渲染後的 markdown 內文
5. **出向連結**：依 rel 分組，每項顯示目標的 title
6. **反向連結**：`SELECT ... FROM links WHERE target_id = ?`，依 rel 分組，每項顯示來源的 title
7. 若有 W1 警告，顯示
8. 若在五分鐘時窗內，顯示「編輯」按鈕；否則不顯示

反向連結區塊是 MVP 的必要項目，不可延後。因為所有連結都指向過去（I3），沒有反查的話一張卡片對「誰用了我、誰推翻了我」完全無知，整個系統會是寫入單向的。

### `GET /`
時間逆序的卡片流。每項顯示 type、title、tags、created、連結數。
支援 query：`?type=think`、`?tag=物理`，可組合。
分頁，每頁 50 筆。

### `GET /tags`
所有標籤及使用次數，依次數排序。
存在理由：讓拼寫漂移（`偶像大師` / `im@s` / `ML` 是同一件事）看得見。MVP 不做任何自動合併，只要能看到就會自己收斂。

### `GET /orphans`
`type = 'think'` 且 `link_count = 0` 的卡片清單。
存在理由：這是作者目前所有沒有依據的信念。這份清單是這個系統最直接的產出之一。

### `GET /search?q=`
FTS5 全文檢索，回傳卡片列表。

### `GET /api/search?q=&limit=`
給 `/new` 頁面的連結選擇器用，回傳 JSON `[{id, title, type, created}]`。

### `POST /_reindex` / `GET /_health`
維運用。`/_health` 回傳卡片檔案數、索引筆數、未 push 的 commit 數。

---

## 8. 部署

```
GCP e2-micro (asia-east1)
├── /srv/app          ← repo A，程式碼
├── /srv/corpus       ← repo B，語料庫（git clone，設定 deploy key 具寫入權）
├── /srv/index.db     ← SQLite，不進版控
└── systemd unit: append-cards.service（Restart=always）
```

- Cloudflare Tunnel（`cloudflared`）以 systemd service 執行，把 `localhost:3000` 接到子網域。
- **不安裝 nginx。不開放任何對外埠。** GCP 防火牆維持全關。
- Cloudflare Access 掛在該子網域上，Policy 設為只允許作者的 Google 帳號。應用程式**完全不實作驗證邏輯**，只信任 Cloudflare 已經擋掉未授權流量。
- 環境變數：`CORPUS_PATH`、`INDEX_PATH`、`PORT`、`GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`。
- CI/CD：push 到 repo A 的 main → GitHub Actions → ssh 到 VM → `git pull && npm ci && npm run build && systemctl restart append-cards`。

---

## 9. 驗收條件

實作完成後，以下每一項都要能通過。這是這份規格的實際定義。

1. 建立一張 `original` 卡片，成功，回傳的頁面顯示標題與內文。
2. 建立一張 `explan` 卡片，帶一條 `rel: about` 指向步驟 1 的卡片。成功。
3. 打開步驟 1 的卡片頁面，**反向連結區塊顯示步驟 2 的卡片**。
4. 嘗試建立一張卡片，連結指向不存在的 ID → 400，且 `cards/` 下沒有新檔案產生。
5. 手動製造一張 frontmatter 裡 `to` 指向較大 ID 的卡片檔，執行 reindex → 回報中列出這條壞連結。
6. `rm /srv/index.db` 後重啟服務 → 自動重建，所有頁面內容與重建前完全一致。
7. 建立一張卡片後 30 秒內編輯 → 成功，`revised_at` 有值。
8. 建立一張卡片後 6 分鐘再編輯 → 403，訊息提示改用 supersedes。
9. 沒有任何 endpoint 能刪除卡片（含 `DELETE`、以及任何形式的 admin 介面）。
10. 斷開 git remote（改成不存在的 URL）後建立卡片 → **仍然成功**，卡片檔案存在，回應時間沒有明顯變慢，log 裡有 push 失敗記錄。
11. 建立一張帶 `rel: refutes` 但沒有其他連結的卡片 → 成功，但頁面上顯示 W1 警告。
12. 建立 200 張卡片後，首頁與搜尋的回應時間仍在 300ms 內。

---

## 10. 給 agent 的注意事項

以下是這類系統最常被「好意」破壞的地方，請特別避免：

- **不要**把卡片內容當成 SQLite 的主要儲存，再把檔案當成匯出功能。方向是相反的。
- **不要**為了「方便」加上刪除功能、封存功能、或任何形式的批次修改腳本。
- **不要**在寫入路徑上 await git 操作。
- **不要**把驗證邏輯放進前端就算數，所有規則必須在 server side 強制執行。
- **不要**為了美觀引入 Tailwind、React、任何打包工具。單一 `style.css`。
- **不要**自動正規化標籤（轉小寫、去空白以外的處理、合併相似項）。
- **不要**在 `/new` 加上自動儲存草稿、範本、或任何會增加送出前決策的東西。這個頁面的唯一指標是送出速度。

---

## 11. 尚未裁決的事項（不要實作，留給後續討論）

- W1 是否從警告升級為硬性驗證。
- 標籤是否需要第二層（領域維度）。目前只有 type 一層 + 自由標籤。
- 附件：目前只支援外部 URL，`archive_url` 需手動填。是否自動送 Wayback 存檔，未定。
- 第二條寫入路徑（Discord bot / 分享選單）。MVP 只做網頁，三個月後以實際漏記量決定。
- 連結建議、任何 AI 介面。