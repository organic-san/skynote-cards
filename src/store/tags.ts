import fs from 'node:fs';
import path from 'node:path';
import { parseList } from './yamllist.ts';

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
 * backup.ts 只 add 卡片與環境的順序（envs.yml）。它是手工編輯的設定，不是卡片。
 * 同樣的理由，它也不進 App Engine 的 bucket：只經 git 進來（clone 與「更新」）。
 * 開機時 clone 失敗的那台機器上就沒有它——鎖定只影響推薦選單，可以接受。
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

/** `locked:` 底下的那一串。逐行解析，寫法見 store/yamllist.ts。 */
export function parseLocked(text: string): Set<string> {
  return new Set(parseList(text, 'locked'));
}
