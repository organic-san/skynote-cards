import fs from 'node:fs';
import path from 'node:path';

/**
 * 語料庫根目錄的 `tags.yml`：標籤的**呈現層**元資料。
 *
 * 目前只有一件事：哪些標籤不進表單的推薦選單。
 *
 * 為什麼需要它——出處標記（`匯入`）跟主題詞彙（`世界觀`）在資料上一模一樣，
 * 但在推薦選單裡的價值相反：前者掛在幾百張卡上、永遠排在最前面，而你幾乎
 * 從來不會想在寫新卡時挑它。推薦按最近使用排序之後這件事更嚴重，
 * 所以鎖定必須跟排序同一批做（見規格 §7.2 的依賴要求）。
 *
 * **這不是驗證。** 鎖定只過濾推薦候選，不擋手動輸入、不擋既有卡片、不參與
 * 檢索。它不進 domain：一個「哪些字不該被推薦」的偏好，跟「一張卡合不合法」
 * 不是同一種東西，混進去會讓 rules.ts 開始依賴語料庫裡的一個設定檔。
 *
 * 檔案放在語料庫 repo 裡（跟著卡片一起被版控），但**不由本程式寫入或 commit**——
 * backup.ts 只 add cards/*.md。它是手工編輯的設定，不是卡片。
 */

const FILE = 'tags.yml';

interface Parsed {
  /** 判斷檔案有沒有變。stat 很便宜，重新解析不便宜。 */
  mtimeMs: number;
  size: number;
  locked: Set<string>;
}

/**
 * 每一次表單渲染都會問一次鎖定清單，所以不能每次重讀重解析。
 * 以 corpusPath 為鍵——測試會在同一個行程裡開好幾份語料庫。
 */
const cache = new Map<string, Parsed>();

/** 空集合的共用實例，讓「沒有這個檔案」不必每次配置一個新的 Set。 */
const NONE: ReadonlySet<string> = new Set<string>();

export function lockedTags(corpusPath: string): ReadonlySet<string> {
  const file = path.join(corpusPath, FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // 沒有這個檔案是正常狀態，不是錯誤——多數語料庫不需要鎖任何標籤。
    cache.delete(corpusPath);
    return NONE;
  }

  const hit = cache.get(corpusPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.locked;

  let locked: Set<string>;
  try {
    locked = parseLocked(fs.readFileSync(file, 'utf8'));
  } catch {
    // 讀不到就當沒有。一個壞掉的設定檔不該讓表單開不出來。
    locked = new Set();
  }
  cache.set(corpusPath, { mtimeMs: stat.mtimeMs, size: stat.size, locked });
  return locked;
}

/**
 * 逐行解析，不引 YAML 套件。
 *
 * 認得的只有一種寫法：
 *
 * ```yaml
 * locked:
 *   - 匯入
 *   - 待整理
 * ```
 *
 * 只為了一個字串陣列拉進一個 YAML 解析器，是拿一整套語法的維護面
 * 去換這十行。代價講明白：inline 陣列（`locked: [a, b]`）、錨點、多文件
 * 都不支援——寫成那樣會被靜默忽略，而不是報錯。這個檔案是手寫的、
 * 只有一個鍵，那個代價可以接受。
 */
export function parseLocked(text: string): Set<string> {
  const out = new Set<string>();
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    // 註解與空行不影響區塊的開闔——區塊由縮排決定。
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (line.trim() === '') continue;

    const item = /^\s+-\s*(.*)$/.exec(line);
    if (inside && item) {
      const v = unquote((item[1] ?? '').trim());
      if (v !== '') out.add(v);
      continue;
    }
    // 回到頂層：這個區塊結束了。
    inside = /^locked\s*:\s*$/.test(line.trim()) && !/^\s/.test(line);
  }
  return out;
}

function unquote(s: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(s);
  return m ? (m[2] ?? '') : s;
}
