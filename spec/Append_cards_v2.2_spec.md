# Skynote — v2.2 規格（細部改善方案）

> 本文件是 v2 規格的**增量修訂**，不取代 v2。凡 v2 未被本文件明文修改之處，一律以 v2 為準。
>
> **版本定位**：v2.2 範圍限定在**人因與工程層的缺陷修補**，不觸動型別系統、rel 矩陣與反芻期的 domain 語義。標籤機制的長期重構（強制標籤、詞彙表約束等）整批推遲至 v3，草案詳見 [`Append_cards_v3_draft.md`](./Append_cards_v3_draft.md)。
>
> **本版不新增任何 domain 規則**。全部九項皆位於 web 與 store 層，`src/domain/rules.ts` 與 `src/domain/types.ts` 不需改動。

---

## 0. 版本範圍與實作順序

### 0.1 收錄項目

| # | 項目 | 層級 | 本版改動檔案 |
|---|---|---|---|
| 1 | 內文欄內部捲動跳動修正 | web/JS + CSS | `public/js/grow.js`、`public/css/form.css` |
| 2 | 草稿暫存（localStorage） | web/JS + 路由 | 新增 `public/js/draft.js`；`routes.ts`、`new.eta`、`edit.eta`、`layout.eta` |
| 3 | rel 圖示視覺代稱指派 | web/views | `thread.eta`、`new.eta` |
| 4 | 內文複製按鈕 | web/JS + views | `card.eta`、`icon.eta`、新增 `public/js/copy.js` |
| 5 | 手動連結列 rel 預設值 | web/JS + present | `present.ts`、`public/js/links.js` |
| 6 | 隨手記繼承當前標籤篩選 | web | `render.ts`、`layout.eta`、`routes.ts` |
| 7 | 標籤推薦排序（最近使用）與標籤鎖定 | store/index | `query.ts`、`lists.ts`、新增 `src/store/tags.ts` |
| 8 | 標籤索引頁計數與排序切換 | store/index + views | `routes.ts`、`tags.eta` |
| 9 | 搜尋片段截取、高亮與型別篩選 | store/index + present | `schema.ts`、`query.ts`、`present.ts`、`search.eta`、`cardlist.eta` |

### 0.2 推薦實作順序

```
1 內文欄跳動 ──┐
2 草稿暫存   ──┼─→ （彼此獨立，順序不拘；1 建議排前面以改善輸入體驗）
3 rel 圖示   ──┤
4 複製按鈕   ──┤
5 rel 預設值 ──┘

6 隨手記繼承標籤篩選

7.4 標籤鎖定 ──→ 7 最近使用排序 ──→ 8 索引頁排序切換
   （必須先做鎖定，否則改排序會把「匯入」等來源標籤推至推薦最前列）

9 搜尋結果片段截取與高亮（含型別篩選）
```

**排除項目**：複雜搜尋語法（AND/OR、日期範圍等）暫不納入，僅實作「型別篩選」chip 列（`?q=...&type=thinking`），複用首頁視覺語彙。

---

## 1. 內文欄內部捲動跳動修正

### 1.1 現況與成因（`public/js/grow.js`、`public/css/form.css`）

內文欄採用 autogrow 設計：`textarea[data-grow]` 隨內容增高至 `--grow-max`（一般表單 `60vh`，分欄建立頁 `40vh`），到頂後 `overflow-y` 轉為 `auto`。

`grow.js` 在 `input` 事件中每次按鍵皆執行：
```js
el.style.height = 'auto';
var want = el.scrollHeight;
el.style.height = Math.min(want, max) + 'px';
```

設為 `auto` 會使欄位高度在排版計算中瞬間縮至內容高，導致 `scrollTop` 被瀏覽器歸零或箝制；下一行恢復高度時捲動位置已丟失，瀏覽器為了保持游標可見再度回捲，造成每次輸入皆有上下跳動。

### 1.2 修法：到達上限後停止重設高度

當欄位已達高度上限且內容超出時，高度不再改變，應直接跳過重算：

```js
function grow() {
  if (grown !== null && Math.abs(el.offsetHeight - grown) > 1) return;

  var raw = getComputedStyle(el).getPropertyValue('--grow-max');
  var max = parseInt(raw, 10);
  if (raw.indexOf('vh') > -1) max = (window.innerHeight * max) / 100;

  // 到達上限且內容超出：高度已穩定，直接返回避免重設 style.height 造成捲動跳動
  if (!isNaN(max) && el.offsetHeight >= max - 1 && el.scrollHeight > max) return;

  el.style.height = 'auto';
  var want = el.scrollHeight;
  el.style.height = (isNaN(max) ? want : Math.min(want, max)) + 'px';
  el.style.overflowY = !isNaN(max) && want > max ? 'auto' : 'hidden';
  grown = el.offsetHeight;
}
```

- **視窗 Resize**：監聽 `window.resize`，觸發時解除守門重新計算一次。
- **CSS 錨定**：關閉捲動錨定避免拉扯：
  ```css
  textarea[data-grow] { overflow-anchor: none; }
  ```

### 1.3 驗收條件

- 內文輸入超過 `--grow-max` 進入內部捲動後，連續輸入 30 行，捲動單調向下無向上位移；
- 欄位尚未到頂時，輸入文字依然逐行長高（autogrow 未失效）；
- 游標移至內文中段編輯時，捲動位置不跳離游標所在行；
- 手動拖曳欄位高度後，高度維持拖曳後尺寸。

---

## 2. 草稿暫存（localStorage）

### 2.1 儲存機制與 Scope 定義

依表單語境分槽儲存，各自獨立清除，避免寫作中途切換表單銷毀前份草稿。表單身分由伺服器渲染在表單屬性 `data-draft-scope` 上，前端直接讀取。

**儲存鍵**：`skynote:draft:v1:{scope}`

| scope 格式 | 對應表單 |
|---|---|
| `quick` | 右下隨手記（無標籤篩選時） |
| `quick:tag:{tag}` | `?tag=` 生效時的隨手記（見 §6） |
| `new` | 裸 `/new`（型別尚未選定） |
| `new:original` | 側欄「追加外部資料」 |
| `new:{type}:{rel}:{srcId}` | 卡片頁 FAB 展開的衍生表單 |
| `new:thinking:expand` | 隨手記「展開」後的表單 |
| `edit:{cardId}` | 反芻期編輯頁 |

**儲存內容結構**：
```json
{ "v": 1, "savedAt": 1757203200000, "fields": { "title": "...", "body": "...", "tags": "..." } }
```
- `fields` 僅儲存使用者可編輯的文字欄位。
- **連結列不存入草稿**：目標卡片可能在草稿存活期間被刪除（R9），繼承連結統一由伺服器於渲染時提供。

### 2.2 寫入與清除時機

- **寫入**：`input` 事件 debounce 400ms，並在 `visibilitychange`（切換至 hidden）與 `pagehide` 時強制寫入。
- **清除**：
  - `POST /new` 與 `POST /quick`（表單 302 導向）：表單帶隱藏欄位 `draft_scope`，建立成功後伺服器將其附於導向網址（如 `/c/{id}?d={scope}` 或 `/?d={scope}`）。前端於頁面載入時讀取 `d` 參數、清除對應鍵，並以 `history.replaceState` 清理網址。
  - `PUT /c/:id`（編輯頁 fetch）：`editform.js` 於請求成功後直接移除 `localStorage` 對應鍵。
  - 隨手記「展開」：成功渲染完整表單時，清除 `quick` 槽。
  - **驗證失敗時不得清除**：400 重新渲染時草稿保留，防範意外關閉分頁。
- **過期清掃**：載入時自動清理儲存超過 14 天的草稿；總數超過 20 筆時按時間由舊至新淘汰。

### 2.3 還原策略

- **無伺服器預填表單**（`quick`、`new`、`new:original`）：頁面載入時**靜默還原**至欄位，並對 textarea 觸發 `input` 事件以更新高度。
- **具伺服器預填表單**（繼承標籤、來源、文字）：**不靜默覆蓋**。於表單上方顯示提示列：`有未送出的草稿（N 小時前）　[還原]　[丟棄]`。

---

## 3. 七種 rel 的圖示代稱

### 3.1 工作項目與位置

圖示資產已於 `src/web/views/icon.eta` 定義完成，本項僅負責指派至關聯呈現：

| 位置 | 呈現方式 |
|---|---|
| 卡片頁關聯區塊每一列（`thread.eta`） | 置於關係文字之前，與 `↑ N` / `↓ N` 軌道並列 |
| 表單繼承連結列（`new.eta` 的 `.linkrow.fixed`） | 置於 `<select>` 之後、目標標題之前 |

### 3.2 使用約束

1. **圖示永遠與文字標籤並列**（雙重錨定，不單獨出現）；
2. **圖示不隨上下游視角翻轉**（維持 7 種外觀，方向由軌道與文字表達）；
3. **圖示繼承 `currentColor`**，不額外上色以避免干擾型別色點；標註 `aria-hidden="true"`。

---

## 4. 內文複製按鈕

### 4.1 複製內容定義

複製目標為**原始 Markdown 內文**（不含 frontmatter、標題與關聯）。
- **碎片特例**：依 A.5 碎片內文存於 `title`，複製按鈕在碎片卡片上複製 `title` 原文。

### 4.2 資料來源與互動

- **來源**：由 `routes.ts` 於 `/c/:id` 提供 `body_md`，模板渲染為 `data-md` 屬性：
  ```html
  <div class="body" data-md="<%= it.body_md %>"><%~ it.body_html %></div>
  ```
  前端透過 `dataset.md` 讀取，避免由 HTML 反解析。
- **互動**：按鈕置於 `.body` 內文區塊右上角，靜置淡化，支援 `navigator.clipboard.writeText`（不支援時降級至傳統 execCommand）。
- **資產**：`icon.eta` 補上 `copy` 與 `check` 兩個輪廓圖示；點擊複製後切換為勾選圖示並提示「已複製」，1.2 秒後還原。

---

## 5. 手動連結列的 rel 預設值

### 5.1 範圍與規則

僅作用於使用者點擊 `+` 手動新增的空白連結列。FAB 衍生帶出的固定連結列已有明確意圖，維持原有預設值。

- **`thinking` 型別**：手動新增列預設值由現況的 `about` 改為 **`related`**（弱語義）。
- **其餘型別**：`restatement` 維持 `about`，`original` 維持 `part-of`。

### 5.2 實作方式

在 `present.ts` 定義 `DEFAULT_REL: Partial<Record<CardType, Rel>>` 送至前端；`links.js` 在渲染空白列時優先採用該預設值。`REL_MATRIX` 的排序維持不變。

---

## 6. 隨手記繼承當前標籤篩選

### 6.1 機制

- 路由維持 `/?tag=:tag`，不新增專屬路由。
- 首頁在 `?tag=` 篩選生效時，右下隨手記標題變更為「隨手記 · #標籤名」。送出時自動帶入該標籤。
- 按「展開」進入完整表單時，標籤自動填入且**可自由修改刪除**（不鎖定）。

### 6.2 實作管線

1. `render.ts`：`PageOptions` 增加 `tag?: string`。
2. `routes.ts`（`GET /`）：將 query 的 `tag` 傳入 `shell()`。
3. `layout.eta`：隨手記面板標題依 `tag` 顯示，並加入 `<input type="hidden" name="tags">`。
4. `routes.ts`（`POST /quick`）：解析請求中的 `tags` 欄位並存入卡片。
5. `routes.ts`（`POST /quick` expand 分支）：將 `tags` 傳入 `newFormPage`。

---

## 7. 標籤推薦：排序調整與鎖定

### 7.1 推薦排序（最近使用）

表單標籤推薦改以最近使用時間排序。擴充 `query.ts` 的 `tagCounts()`：

```sql
SELECT t.tag AS tag, COUNT(*) AS n, MAX(c.created) AS last_used
  FROM tags t JOIN cards c ON c.id = t.card_id
 GROUP BY t.tag
```

- **表單推薦選單（`tags_all`）**：`ORDER BY last_used DESC, tag ASC`。
- **標籤索引頁（`/tags`）**：預設 `ORDER BY n DESC, tag ASC`。

### 7.2 標籤鎖定（排除推薦）

用於將出處標記（如 `匯入`）自推薦選單中剔除，避免污染主題詞彙：

- **儲存**：語料庫根目錄新增 `tags.yml`：
  ```yaml
  locked:
    - 匯入
  ```
- **邏輯**：新增 `src/store/tags.ts`，以輕量行解析讀取 `locked:` 清單。
- **行為**：
  - 表單推薦（`lists.tagCounts`）過濾掉鎖定標籤；
  - 標籤索引頁（`/tags`）依然列出，並標註次要狀態（如鎖定圖示）；
  - 檢索、手動輸入與既有卡片資料完全不受限制。
- **依賴要求**：標籤鎖定機制必須先於或與推薦排序調整同批實作，避免 `匯入` 被推至首位。

---

## 8. 標籤索引頁（`/tags`）

保留點入標籤跳轉 `/?tag=` 行為，支援 `?sort=` query 參數切換排序：

| `?sort=` | 排序規則 | 說明 |
|---|---|---|
| （預設）／`count` | `n DESC, tag ASC` | 依卡片數量由多至少 |
| `recent` | `last_used DESC, tag ASC` | 依最近使用時間排序 |
| `name` | `tag ASC` | 依名稱碼位排序（介面標示為「名稱」） |

不新增任何「未使用標籤」整理警示，避免製造多餘清理焦慮。

---

## 9. 搜尋結果片段截取、高亮與型別篩選

### 9.1 FTS5 查詢擴充

修改 `query.ts` 的 `search()`，支援 `snippet()` 與可選型別篩選：

```sql
SELECT c.*,
       snippet(cards_fts, -1, char(2), char(3), '…', 32) AS frag
  FROM cards_fts JOIN cards c ON c.id = cards_fts.id
 WHERE cards_fts MATCH ?
   [AND c.type = ?]
 ORDER BY rank
 LIMIT ?
```
- `colnum` 使用 `-1`，由 FTS5 自動選取匹配度最高的欄位（碎片命中標題，其餘命中內文）。

### 9.2 輸出四步處理管線

針對 CJK 逐字空白（`segmentCjk`）與 XSS 防護，格式化順序如下：

1. **取片段**：以不可見哨符（`U+0002` / `U+0003`）包夾匹配字詞；
2. **還原分詞（`desegment`）**：去除 CJK 字元之間被插入的空白（哨符不阻斷還原）；
3. **HTML 轉義**：整段文字進行 HTML 轉義；
4. **置換標籤**：將哨符分別換為 `<mark>` 與 `</mark>`。

`desegment` 定義於 `src/store/schema.ts`：
```ts
const GLUE = new RegExp(
  '([' + CJK_RANGE + '\\u0002\\u0003])\\s+(?=[' + CJK_RANGE + '\\u0002\\u0003])',
  'g'
);
export function desegment(s: string): string {
  return s.replace(GLUE, '$1').trim();
}
```

### 9.3 呈現

- 搜尋頁（`search.eta`）以 `frag` 取代 `excerpt`，首頁維持 `excerpt`；
- 搜尋結果頁上方提供型別篩選 chip 列（`?q={q}&type={type}`）。

---

## 10. 核心裁決紀錄（G 節補充）

1. **草稿依表單身分分槽儲存**：避免跨表單切換時誤刪草稿；
2. **隨手記繼承之標籤保持可編輯**：維持輸入彈性，允許使用者隨時校正分類；
3. **手動空白連結預設為弱語義 `related`**：未經思考的連結承諾最小化，保護詞彙表價值；
4. **`tags.yml` 作為呈現層例外元資料**：納入版控但不改寫卡片內容，不參與 domain 驗證；
5. **標籤鎖定不進 domain 驗證層**：僅過濾推薦候選，不阻擋既有卡片與手動輸入；
6. **rel 圖示不隨方向翻轉並繼承色彩**：避免視覺負擔過載與色彩系統衝突；
7. **定案狀態標示（建議）**：僅在卡片「因被引用而提前定案」（`reason === 'cited'`）時於卡片頁標註，常規時間到期不標註，兼顧訊息價值與介面簡潔。
