import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { listCardFiles, writeFileAtomic } from './files.ts';
import {
  CARD_OBJECT,
  NO_BASE,
  blobHash,
  cardIdOf,
  md5Base64,
  type CorpusStore,
  type StoredObject,
} from './remote.ts';

/**
 * bucket 與本機語料庫（git 的 working tree）對帳。
 *
 * 兩邊都可能比較新：網頁上的寫入先進 bucket、之後才 commit 與 push，
 * 在別處改好推上 GitHub 的修改則是先進 git、之後才到 bucket。
 * 開機（剛 clone 完）與側欄「更新」（剛 pull 完）都走這一支。
 *
 * 一份內容出現在 git 歷史裡，代表它已經 commit 過——是舊的；沒出現過，
 * 代表是還沒推上去的網頁寫入——是新的。但「改回以前的內容」（勾了又取消）
 * 會讓新的寫入看起來像舊的，所以本程式上傳時另外記下這份內容改自哪一份
 * （物件 metadata 的 base），先看它：
 *
 * | 狀況 | 結果 |
 * |---|---|
 * | 內容相同 | 不動 |
 * | 只有 bucket 有，同一張卡在本機的另一個資料夾、內容相同 | 刪掉：搬走之後留下的舊名字 |
 * | base == blob（這是 git 那份的副本） | 以 git 為準 |
 * | 只有 bucket 有，內容在 git 歷史裡 | 以 git 為準：commit 過，之後 git 把它刪了或搬走了 |
 * | base == 本機那份 | 以 bucket 為準：在本機這份之上的寫入 |
 * | 內容在 git 歷史裡 | 以 git 為準：commit 過，之後 git 又往前走了 |
 * | 其他 | 以 bucket 為準。base 若在歷史裡，代表兩邊都改了，列為衝突 |
 * | 只有本機有 | 上傳（git 為準） |
 *
 * 只有 bucket 有的時候，「內容在歷史裡」要排在「base == 本機那份」前面：本機沒有這個檔，
 * 它的雜湊記成 none，而網頁上建立、之後沒再改過的卡，base 也是 none——不先問歷史，
 * 一張推上去之後在別處被刪掉或搬走的卡，會被當成還沒推上去的新卡取回來。
 *
 * 沒有 metadata 的物件（從主控台或 gcloud 放進去的）只看歷史那一條。
 *
 * 分不出來的時候選不會丟東西的那一邊：只有本機有的檔案一律上傳，
 * 即使它其實是網頁上刪掉、刪除還沒推上去的卡——寧可讓它回來，
 * 也不要把別處新增的卡悄悄刪掉。
 *
 * 沒有 git（開機時 clone 失敗）就沒有歷史可問：一律以 bucket 為準，
 * 而且絕不刪 bucket 的東西。
 *
 * 環境（v3.1）是 `cards/` 底下的一層資料夾，物件名稱照樣是路徑。同一張卡換了資料夾
 * （在別處把卡搬進環境、網頁上替環境改名），在這裡是「新名字只有本機有」加上
 * 「舊名字只有 bucket 有」：前者上傳，後者照上表判斷——內容沒變就是表上第二列，刪掉。
 * 新名字先傳、舊名字後刪，中途失敗也不會兩邊都沒有。
 */

export interface ReconcileReport {
  /** 本機那份傳上 bucket（git 為準）。 */
  uploaded: string[];
  /** bucket 那份寫進本機（bucket 為準），之後由 git 補 commit。 */
  downloaded: string[];
  /** bucket 上的物件刪掉（git 那邊已經刪了）。 */
  deleted: string[];
  /** 兩邊都改過，以 bucket 為準；git 那一份還在歷史裡。 */
  conflicts: string[];
  /** 要刪的太多，判斷可能有誤，這次一個都沒刪。 */
  deletionsSkipped: string[];
}

export interface ReconcileOptions {
  corpusPath: string;
  store: CorpusStore;
  /** git 歷史裡所有物件的雜湊；沒有 git 是 null。見 gitObjects。 */
  history: ReadonlySet<string> | null;
  logger: { warn(msg: string): void; error(msg: string): void };
  /** 同時進行的請求數。 */
  concurrency?: number;
}

/**
 * 一次要刪超過這麼多個、而且超過 bucket 的這個比例，就整批不刪。
 * 正常的「別處刪了一張卡」一次只有一兩個；一口氣幾十個，多半是 remote
 * 設錯了（clone 到一個空的 repo），照做就是把 bucket 清空。
 */
const MASS_DELETE_COUNT = 10;
const MASS_DELETE_RATIO = 0.1;

type Plan =
  | { kind: 'upload'; name: string; content: Buffer }
  | { kind: 'download'; name: string; content: Buffer | null; conflict: boolean }
  | { kind: 'delete'; name: string };

export async function reconcile(opts: ReconcileOptions): Promise<ReconcileReport> {
  const { corpusPath, store, history } = opts;
  const report: ReconcileReport = {
    uploaded: [],
    downloaded: [],
    deleted: [],
    conflicts: [],
    deletionsSkipped: [],
  };

  const remote = new Map((await store.list()).map((o) => [o.name, o]));
  const local = readLocalCards(corpusPath);
  const names = [...new Set([...remote.keys(), ...local.keys()])].sort();

  // 本機每一張卡（以 ID 為準）的內容。同一張卡換了資料夾，bucket 上的舊名字
  // 跟本機的新名字內容相同——認得出來，舊名字就不會被取回來變成第二份。
  const localMd5ById = new Map<string, Set<string>>();
  for (const [name, content] of local) {
    const id = cardIdOf(name);
    const set = localMd5ById.get(id) ?? new Set<string>();
    set.add(md5Base64(content));
    localMd5ById.set(id, set);
  }

  // 先把每一個檔案的去向決定好，再動手——刪除要先看總數才知道該不該做。
  const plans: Plan[] = [];
  await pool(names, opts.concurrency ?? 8, async (name) => {
    const there = remote.get(name) ?? null;
    const elsewhere = there !== null && (localMd5ById.get(cardIdOf(name))?.has(there.md5) ?? false);
    const plan = await decide(name, local.get(name) ?? null, there, store, history, elsewhere);
    if (plan) plans.push(plan);
  });

  // 換了資料夾的卡（同一個 ID 在本機的另一個名字底下）刪掉舊名字不會少一張卡，
  // 不算進「一次刪太多」——把整個語料庫搬進環境時，那會是全部。
  const moved = (p: Plan) => localMd5ById.has(cardIdOf(p.name));
  const deletions = plans.filter((p) => p.kind === 'delete');
  const lost = deletions.filter((p) => !moved(p));
  const massDelete = lost.length > MASS_DELETE_COUNT && lost.length > remote.size * MASS_DELETE_RATIO;
  if (massDelete) {
    report.deletionsSkipped = lost.map((p) => p.name).sort();
    opts.logger.error(
      `對帳：要刪 bucket 上 ${lost.length} / ${remote.size} 個物件，看起來不對（remote 設錯了？），這次一個都不刪`,
    );
  }

  // 先寫、後刪：換資料夾的卡，新名字傳上去之後才刪舊名字。
  await pool(plans.filter((p) => p.kind !== 'delete'), opts.concurrency ?? 8, async (plan) => {
    switch (plan.kind) {
      case 'upload': {
        const blob = blobHash(plan.content);
        await store.put(plan.name, plan.content, { blob, base: blob });
        report.uploaded.push(plan.name);
        return;
      }
      case 'download': {
        const content = plan.content ?? (await store.get(plan.name));
        writeFileAtomic(path.join(corpusPath, plan.name), content);
        report.downloaded.push(plan.name);
        if (plan.conflict) {
          report.conflicts.push(plan.name);
          opts.logger.warn(`對帳：${plan.name} 在網頁與 git 兩邊都改過，以網頁那份為準；git 那份留在歷史裡`);
        }
        return;
      }
    }
  });
  await pool(deletions, opts.concurrency ?? 8, async (plan) => {
    if (massDelete && !moved(plan)) return;
    await store.delete(plan.name);
    report.deleted.push(plan.name);
  });

  for (const list of [report.uploaded, report.downloaded, report.deleted, report.conflicts]) list.sort();
  return report;
}

/**
 * 一個物件名稱的去向。`elsewhere`：本機沒有這個名字，但同一張卡以相同的內容
 * 在本機的另一個資料夾——搬走之後留下的舊名字。
 */
async function decide(
  name: string,
  here: Buffer | null,
  there: StoredObject | null,
  store: CorpusStore,
  history: ReadonlySet<string> | null,
  elsewhere: boolean,
): Promise<Plan | null> {
  if (!there) return here ? { kind: 'upload', name, content: here } : null;
  if (here && md5Base64(here) === there.md5) return null;

  // 沒有 git：bucket 是唯一的來源。
  if (!history) return { kind: 'download', name, content: null, conflict: false };

  if (!here && elsewhere) return { kind: 'delete', name };

  const hereBlob = here ? blobHash(here) : NO_BASE;
  const gitWins: Plan = here ? { kind: 'upload', name, content: here } : { kind: 'delete', name };

  if (there.blob !== null && there.base !== null) {
    if (there.base === there.blob) return gitWins;
    // 本機沒有這個檔：commit 過的內容代表 git 後來把它刪了或搬走了。要排在下一條前面，
    // 網頁上建立的卡 base 是 none，跟「本機沒有」記成的雜湊一樣（見檔頭）。
    if (!here && history.has(there.blob)) return gitWins;
    if (there.base === hereBlob) return { kind: 'download', name, content: null, conflict: false };
    if (history.has(there.blob)) return gitWins;
    return { kind: 'download', name, content: null, conflict: history.has(there.base) };
  }

  // 沒有 metadata：只能看內容本身在不在歷史裡。
  const content = await store.get(name);
  if (history.has(blobHash(content))) return gitWins;
  return { kind: 'download', name, content, conflict: false };
}

/** 本機的卡片檔，以物件名稱（相對路徑）為鍵。環境底下的一層也算。 */
function readLocalCards(corpusPath: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const f of listCardFiles(corpusPath).files) {
    if (!CARD_OBJECT.test(f.rel)) continue;
    out.set(f.rel, fs.readFileSync(path.join(corpusPath, f.rel)));
  }
  return out;
}

/**
 * git 歷史裡出現過的所有物件（commit、tree、blob）的雜湊。
 * 不是 git repository（或還沒有任何 commit）回 null / 空集合。
 *
 * 一次 `rev-list --objects --all` 拿全部，比對每一個檔案各問一次 git 便宜得多。
 * commit 與 tree 的雜湊混在裡面無妨：拿來比的是 blob 雜湊，不會撞到。
 */
export async function gitObjects(corpusPath: string): Promise<Set<string> | null> {
  if (!fs.existsSync(path.join(corpusPath, '.git'))) return null;
  const git = simpleGit(corpusPath);
  let out: string;
  try {
    out = await git.raw(['rev-list', '--objects', '--all']);
  } catch {
    // 一個 commit 都沒有的 repo：沒有歷史，但 git 是在的。
    return new Set();
  }
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    const hash = line.slice(0, 40);
    if (hash.length === 40) set.add(hash);
  }
  return set;
}

/** 最多 n 個同時跑。 */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
