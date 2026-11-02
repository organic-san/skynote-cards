import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './files.ts';
import { parseList } from './yamllist.ts';

/**
 * 語料庫根目錄的 `envs.yml`：側欄裡環境的先後（v3.1）。
 *
 * 跟 `tags.yml` 並排，但這一個由本程式寫入：在環境面板裡拖曳時整個改寫，
 * 環境改名時把舊名字換成新名字。也可以手改，只是下一次拖曳會整個重寫，註解留不下來。
 *
 * 它只記順序，不是環境的清單：有哪些環境仍由資料夾決定（store/files.ts）。
 * 沒列到的環境接在後面，照原本的規則排（service/envs.ts）；列了、資料夾卻已經
 * 不在的名字略過。所以它跟資料夾對不上時不會壞事，壞掉或不存在就是還沒排過。
 *
 * 只經 git 保存，不進 App Engine 的 bucket（store/remote.ts）：bucket 保護的是卡片。
 * push 失敗又剛好換了機器，最後一次排序會回到上一版，卡片不受影響。
 */

export const ENV_ORDER_FILE = 'envs.yml';

const KEY = 'order';

const HEADER = [
  '# 側欄裡環境的順序。在環境面板裡拖曳時由 Skynote 整個改寫。',
  '# 沒列到的環境接在後面；資料夾已經不在的名字略過。',
];

/** 排過的順序。沒有這個檔、讀不到都是空的：還沒排過。 */
export function readEnvOrder(corpusPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(corpusPath, ENV_ORDER_FILE), 'utf8');
  } catch {
    return [];
  }
  return parseList(text, KEY);
}

/** 寫進一份順序。內容跟檔案裡的一樣就不寫；回傳有沒有寫。 */
export function writeEnvOrder(corpusPath: string, names: readonly string[]): boolean {
  const file = path.join(corpusPath, ENV_ORDER_FILE);
  const text = formatEnvOrder(names);
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch {
    // 還沒有這個檔。
  }
  writeFileAtomic(file, text);
  return true;
}

/** 環境改名：舊名字換成新名字，位置不變。順序裡沒有它就不動檔案。 */
export function renameInEnvOrder(corpusPath: string, from: string, to: string): boolean {
  const order = readEnvOrder(corpusPath);
  const at = order.indexOf(from);
  if (at < 0) return false;
  order[at] = to;
  return writeEnvOrder(corpusPath, order);
}

/**
 * 名字一律加雙引號。環境名稱不能含 `"` 與 `\`（service/envs.ts），引號裡不必跳脫；
 * 「 #」、開頭的 `-` 這些在 YAML 裡另有意思的寫法，加了引號也就不會被誤讀。
 */
export function formatEnvOrder(names: readonly string[]): string {
  return [...HEADER, `${KEY}:`, ...names.map((n) => `  - "${n}"`), ''].join('\n');
}
