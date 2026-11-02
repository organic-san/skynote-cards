import fs from 'node:fs';
import { readEnvOrder, renameInEnvOrder, writeEnvOrder } from '../store/envorder.ts';
import {
  cardPath,
  createEnvDir,
  envDir,
  listEnvDirs,
  renameEnvDir,
} from '../store/files.ts';
import { NO_BASE, blobHash, cardObjectName } from '../store/remote.ts';
import { STORE_UNAVAILABLE_MESSAGE, type CardServiceDeps } from './cards.ts';
import { withWriteLock } from './lock.ts';

/**
 * 環境（v3.1）：彼此分離的工作空間。
 *
 * 一個環境就是一份完整的 Skynote——自己的時間軸、標籤、搜尋與隨手記；
 * 在資料面就是 cards/ 底下的一層資料夾（見 store/files.ts）。這裡管四件事：
 * 名稱的規則、側欄要列哪些環境與先後、建立與改名、排序。
 *
 * 規則那一層不知道環境存在，所以各環境的型別、rel 矩陣、反芻期、定案
 * 在結構上就是一致的，不必靠紀律維持。
 */

export type EnvServiceDeps = Pick<CardServiceDeps, 'corpusPath' | 'index' | 'git' | 'store' | 'logger'>;

export const ENV_NAME_MAX = 40;

/**
 * 不能出現在名稱裡的字元：Windows 不允許的那幾個，加上控制字元。
 * 語料庫會被 clone 到別的系統上手動整理（例如把卡搬進環境），所以比 Linux 檔名嚴格。
 */
const FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f\u007f]/;
/** Windows 的保留裝置名，帶副檔名也算。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 檢查一個環境名稱。回傳整理過的名稱（去掉首尾空白、統一成 NFC）與錯誤。
 *
 * `others` 是其他既有的環境。不分大小寫比對：Windows 與 macOS 的檔案系統
 * 不分大小寫，`Draw` 與 `draw` 在那裡是同一個資料夾。
 */
export function checkEnvName(raw: string, others: readonly string[]): { name: string; errors: string[] } {
  const name = raw.normalize('NFC').trim();
  if (name === '') return { name, errors: ['環境名稱不得為空'] };

  const errors: string[] = [];
  if (FORBIDDEN.test(name)) errors.push('環境名稱不能含有 / \\ < > : " | ? * 或控制字元');
  if (name.startsWith('.')) errors.push('環境名稱不能以「.」開頭');
  else if (name.endsWith('.')) errors.push('環境名稱不能以「.」結尾');
  if ([...name].length > ENV_NAME_MAX) errors.push(`環境名稱最多 ${ENV_NAME_MAX} 個字`);
  if (RESERVED.test(name)) errors.push(`「${name}」是 Windows 的保留名稱，不能當環境名稱`);

  const same = others.find((o) => o.toLowerCase() === name.toLowerCase());
  if (same !== undefined) errors.push(`已經有「${same}」這個環境`);
  return { name, errors };
}

export interface EnvEntry {
  /** 空字串是沒有環境。 */
  name: string;
  /** 卡片數。 */
  n: number;
  /** 最近一張卡的建立時間；還沒有卡的環境是 null。 */
  last: string | null;
}

/**
 * 側欄要列的環境，先後是：
 *
 * 1. 在環境面板裡排過的，照 `envs.yml`（store/envorder.ts）。
 * 2. 其餘的依最近一張卡的建立時間；還沒有卡的排在最後，依名稱。沒排過序的語料庫
 *    全部照這一條。（無環境）不能排，總是在這一段。
 *
 * 有哪些環境由資料夾決定，順序檔只管先後：檔案裡的名字對不到資料夾就略過。
 *
 * 沒有環境（cards/ 底下直接放的卡）是過渡的狀態：既有的卡要搬進環境，
 * 搬空了就不列。卡片數與時間取自索引——它只是側欄的呈現，索引在每一次寫入
 * 與「更新」之後都跟檔案一致。
 */
export function envList(deps: Pick<EnvServiceDeps, 'corpusPath' | 'index'>): EnvEntry[] {
  const entries = envEntries(deps);
  const rank = new Map(readEnvOrder(deps.corpusPath).map((name, i) => [name, i]));
  const placed = entries
    .filter((e) => rank.has(e.name))
    .sort((a, b) => (rank.get(a.name) as number) - (rank.get(b.name) as number));
  return [...placed, ...byRecency(entries.filter((e) => !rank.has(e.name)))];
}

/**
 * `/` 通往哪個環境：沒有環境還有卡（或根本還沒有任何環境）時是它，
 * 否則是最近寫過東西的那一個。不是側欄排第一的那一個：排序是你定的先後，
 * 打開首頁要接著寫的，是剛才在寫的地方。
 *
 * 不記憶上次所在的環境，伺服器維持無狀態；想直接進某個環境，就把它的網址存成書籤。
 */
export function homeEnv(deps: Pick<EnvServiceDeps, 'corpusPath' | 'index'>): string {
  const entries = envEntries(deps);
  if (entries.length === 0 || entries.some((e) => e.name === '')) return '';
  return (byRecency(entries)[0] as EnvEntry).name;
}

/** 每一個環境，還沒排先後。（無環境）有卡才算。 */
function envEntries(deps: Pick<EnvServiceDeps, 'corpusPath' | 'index'>): EnvEntry[] {
  const stats = new Map(deps.index.envStats().map((s) => [s.env, s]));
  const out: EnvEntry[] = listEnvDirs(deps.corpusPath).map((name) => ({
    name,
    n: stats.get(name)?.n ?? 0,
    last: stats.get(name)?.last ?? null,
  }));
  const root = stats.get('');
  if (root && root.n > 0) out.push({ name: '', n: root.n, last: root.last });
  return out;
}

/** 最近一張卡新的在前；還沒有卡的排在最後，依名稱。 */
function byRecency(entries: readonly EnvEntry[]): EnvEntry[] {
  return [...entries].sort((a, b) => {
    const x = a.last ?? '';
    const y = b.last ?? '';
    if (x !== y) return x > y ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export type EnvResult =
  | { ok: true; name: string }
  | { ok: false; errors: string[]; unavailable?: true };

/**
 * 建立環境：開一個資料夾。
 *
 * 空資料夾不會進 git，也不會進 bucket（bucket 沒有資料夾）。沒有卡片的環境
 * 沒有東西需要備份；App Engine 換機器時它就不在了，寫進第一張卡才留得住。
 *
 * 不寫進 `envs.yml`：沒排過的環境本來就接在側欄的後面。
 */
export function createEnv(deps: EnvServiceDeps, raw: string): Promise<EnvResult> {
  return withWriteLock(deps.corpusPath, async () => {
    const { name, errors } = checkEnvName(raw, listEnvDirs(deps.corpusPath));
    if (errors.length > 0) return { ok: false, errors };
    createEnvDir(deps.corpusPath, name);
    return { ok: true, name };
  });
}

/**
 * 環境改名：資料夾換名字，裡面的卡片內容逐位元不變，ID 與連結也不變。
 * 跟卡片的寫入走同一把鎖，改到一半不會有卡寫進舊資料夾。
 *
 * 有遠端存放處時，bucket 先動：每一張卡用新名字存一份，全部成功才刪舊名字；
 * 存到一半失敗就把已經存的收回來，什麼都不改（503）。
 *
 * 新名字一律標成「這個路徑上的新寫入」（base 是 none），推上去了沒有交給對帳去問。
 * 改名還沒推上 GitHub 就換了機器時，開機對帳問的是剛 clone 下來的歷史——那才是真的
 * 推上去了什麼（store/reconcile.ts）：推過的卡在舊資料夾原樣回來，新名字那份內容相同，
 * 當成搬走留下的刪掉，乾淨地回到改名之前；沒推過的寫入不在那份歷史裡，取回新資料夾。
 * 這裡不自己問本機的 git：本機的歷史含 push 失敗、還沒推上去的 commit，拿它來判斷，
 * 換機器之後那些卡就會被當成舊的刪掉。
 *
 * 排過序的話，`envs.yml` 裡的名字一起換，位置不變，跟卡片在同一個 commit。
 */
export function renameEnv(deps: EnvServiceDeps, from: string, raw: string): Promise<EnvResult> {
  return withWriteLock(deps.corpusPath, () => renameNow(deps, from, raw));
}

async function renameNow(deps: EnvServiceDeps, from: string, raw: string): Promise<EnvResult> {
  const envs = listEnvDirs(deps.corpusPath);
  if (from === '' || !envs.includes(from)) return { ok: false, errors: [`沒有「${from}」這個環境`] };

  const { name: to, errors } = checkEnvName(raw, envs.filter((e) => e !== from));
  if (errors.length > 0) return { ok: false, errors };
  if (to === from) return { ok: true, name: to };

  const ids = fs
    .readdirSync(envDir(deps.corpusPath, from), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name.slice(0, -3));

  if (deps.store.kind !== 'none' && ids.length > 0) {
    const copied: string[] = [];
    try {
      await eachLimited(ids, STORE_CONCURRENCY, async (id) => {
        const content = fs.readFileSync(cardPath(deps.corpusPath, id, from));
        await deps.store.put(cardObjectName(id, to), content, { blob: blobHash(content), base: NO_BASE });
        copied.push(id);
      });
    } catch (err) {
      deps.logger.error(`環境改名時遠端寫入失敗 ${from} → ${to}: ${errText(err)}`);
      await eachLimited(copied, STORE_CONCURRENCY, async (id) => {
        await deps.store.delete(cardObjectName(id, to)).catch(() => {});
      });
      return { ok: false, errors: [STORE_UNAVAILABLE_MESSAGE], unavailable: true };
    }
    await eachLimited(ids, STORE_CONCURRENCY, async (id) => {
      try {
        await deps.store.delete(cardObjectName(id, from));
      } catch (err) {
        // 新名字都已經在了；舊名字跟它內容相同，下次對帳時會被當成搬走留下的刪掉。
        deps.logger.error(`環境改名時刪不掉舊物件 ${cardObjectName(id, from)}: ${errText(err)}`);
      }
    });
  }

  renameEnvDir(deps.corpusPath, from, to);
  try {
    renameInEnvOrder(deps.corpusPath, from, to);
  } catch (err) {
    // 資料夾與 bucket 都已經換了名字，改名不能停在一半。順序檔沒改到，這個環境只是掉到沒排過的那一段。
    deps.logger.error(`環境改名時改不了 envs.yml ${from} → ${to}: ${errText(err)}`);
  }
  deps.index.renameEnv(from, to);
  deps.git.commitEnvRename(from, to, ids);
  return { ok: true, name: to };
}

/**
 * 環境面板的拖曳排序：送來的是整份順序，寫進 `envs.yml`，一個 commit。
 *
 * 對不到資料夾的名字（另一個分頁剛改了名）略過；沒送到的環境（另一個分頁剛建的）
 * 照它們現在在側欄的先後接在後面。寫進去的是排完之後側欄上的每一個環境，
 * 回傳的也是這一份。跟改名走同一把鎖：改名也會改寫這個檔。
 */
export function orderEnvs(deps: EnvServiceDeps, names: readonly string[]): Promise<string[]> {
  return withWriteLock(deps.corpusPath, async () => {
    const shown = envList(deps)
      .map((e) => e.name)
      .filter((n) => n !== '');
    const order = new Set(names.filter((n) => shown.includes(n)));
    for (const n of shown) order.add(n);
    const out = [...order];
    if (writeEnvOrder(deps.corpusPath, out)) deps.git.commitEnvOrder();
    return out;
  });
}

/** 改名時同時對 bucket 送出的請求數。一個環境可能有上千張卡，一張一張送要等好幾分鐘。 */
const STORE_CONCURRENCY = 8;

/**
 * 最多 n 個同時跑。有一個失敗就不再開始新的，**等已經開始的都結束**才丟出那個錯——
 * 收回已經存進去的新名字時，清單裡不能少了還在路上的那幾張。
 */
async function eachLimited<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (failures.length === 0 && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        failures.push(err);
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) throw failures[0];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
