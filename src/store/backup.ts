import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * 語料庫的 git 備份。
 *
 * 寫入路徑不得因備份失敗而阻塞，所以寫入用的方法都是 fire-and-forget，
 * 內部把每一種錯誤都吃掉：push 失敗、沒有 remote、根本不是 git repo，
 * 都只產生一行 log，絕不往上丟。
 *
 * 取回（pull）是唯一的例外：它會等，而且把結果交出去，見那一支的說明。
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 取回（pull）多久沒有任何輸出就當成卡住，砍掉那個 git 行程。
 *
 * 只有取回需要這個：它跟 commit、push 走同一條佇列，卡住會擋住之後所有的備份；
 * 而且它是使用者按下去、在等答案的動作。逾時視同失敗。
 */
export const PULL_TIMEOUT_MS = 60 * 1000;

/**
 * 取回語料庫的結果（v3 §7）。錯誤不往上丟，它們是結果的一種。
 *
 * - `pulled`：取回了。`commits` 是遠端那一份裡本機原本沒有的 commit，空的就是已是最新。
 * - `conflict`：rebase 有衝突，已經放棄，語料庫回到取回之前。
 * - `failed`：其他失敗——網路、逾時、工作區有卡片以外的變更。
 */
export type PullResult =
  | { kind: 'no-git' }
  | { kind: 'no-remote' }
  | { kind: 'pulled'; commits: string[]; pushPending: boolean }
  | { kind: 'conflict'; files: string[]; message: string }
  | { kind: 'failed'; message: string };

export interface GitBackupOptions {
  corpusPath: string;
  authorName: string;
  authorEmail: string;
  logger: Logger;
  retryIntervalMs?: number;
}

export class GitBackup {
  private readonly git: SimpleGit | null;
  /** 取回專用的那一份：同一個 repo，多一個逾時（PULL_TIMEOUT_MS）。 */
  private readonly puller: SimpleGit | null;
  private readonly logger: Logger;
  private readonly corpusPath: string;
  /** 所有 git 操作排在同一條 promise chain 上，避免同時動到 index.lock。 */
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private pushPending = false;
  private disabledReason: string | null = null;

  constructor(opts: GitBackupOptions) {
    this.logger = opts.logger;
    this.corpusPath = opts.corpusPath;
    if (!fs.existsSync(path.join(opts.corpusPath, '.git'))) {
      this.git = null;
      this.puller = null;
      this.disabledReason = `${opts.corpusPath} 不是 git repository，備份停用`;
      this.logger.warn(`git backup disabled: ${this.disabledReason}`);
    } else {
      // rebase 會重寫還沒推上去的 commit，需要 committer 身分，所以兩份帶同一組設定。
      const config = [`user.name=${opts.authorName}`, `user.email=${opts.authorEmail}`];
      this.git = simpleGit(opts.corpusPath, { config });
      this.puller = simpleGit(opts.corpusPath, { config, timeout: { block: PULL_TIMEOUT_MS } });
    }
    const interval = opts.retryIntervalMs ?? RETRY_INTERVAL_MS;
    if (this.git && interval > 0) {
      this.timer = setInterval(() => void this.retryPush(), interval);
      this.timer.unref();
    }
  }

  get enabled(): boolean {
    return this.git !== null;
  }

  /**
   * 啟動時的補救：先把還沒 commit 的卡片檔補上 commit，再 push 一次。
   * 行程被中斷時，佇列裡還沒輪到的卡片只有檔案、沒有 commit，
   * 沒有這一步它們就再也不會進到備份裡。
   */
  start(): void {
    if (!this.git) return;
    this.enqueue(async (git) => {
      const committed = await this.commitPendingCards(git);
      const unpushed = await this.countUnpushed(git);
      if (committed > 0 || unpushed === null || unpushed > 0) {
        await this.push(git);
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 排空目前佇列。給測試與關機用，寫入路徑不呼叫。 */
  async drain(): Promise<void> {
    await this.chain;
  }

  /**
   * 一張卡片一個 commit。不 await、不阻塞回應。
   *
   * `rm` 也走這裡：`git add` 對已經從工作區消失的檔案會 stage 那次刪除，
   * 所以每一種動作都是同一條路徑，不需要第二套。`check` 是勾選（R14），
   * 跟 `edit` 分開，翻歷史時才分得出哪些是內容的修訂。
   */
  commitCard(id: string, action: 'add' | 'edit' | 'check' | 'rm'): void {
    if (!this.git) return;
    this.enqueue(async (git) => {
      await git.add([path.join('cards', `${id}.md`)]);
      const status = await git.status();
      if (status.staged.length === 0) {
        this.logger.warn(`git: ${action} ${id} 沒有任何變更可 commit`);
        return;
      }
      await git.commit(`${action} ${id}`);
      await this.push(git);
    });
  }

  /**
   * v3 §7：取回語料庫的最新版本（側欄的「更新」）。
   *
   * 排在同一條佇列上，等前面的 commit 與 push 做完。跟其他方法不同，這一支
   * **會等 git 做完才回來**，而且把結果交出去——那是使用者按下去、在等答案的
   * 動作，不是寫入路徑的附帶工作。卡片的寫入路徑不經過這裡（MVP I5 不受影響）。
   */
  pull(): Promise<PullResult> {
    const git = this.git;
    const puller = this.puller;
    if (!git || !puller) return Promise.resolve({ kind: 'no-git' });
    return new Promise((resolve) => {
      this.enqueue(async () => {
        try {
          resolve(await this.pullNow(git, puller));
        } catch (err) {
          resolve({ kind: 'failed', message: errText(err) });
        }
      });
    });
  }

  async unpushedCount(): Promise<number | null> {
    if (!this.git) return null;
    return this.countUnpushed(this.git);
  }

  get status(): { enabled: boolean; push_pending: boolean; disabled_reason: string | null } {
    return {
      enabled: this.enabled,
      push_pending: this.pushPending,
      disabled_reason: this.disabledReason,
    };
  }

  // ------------------------------------------------------------ internals

  private enqueue(fn: (git: SimpleGit) => Promise<void>): void {
    const git = this.git;
    if (!git) return;
    this.chain = this.chain
      .then(() => fn(git))
      .catch((err: unknown) => {
        // 最後一道防線：任何 git 錯誤都不得逸出到寫入路徑。
        this.logger.error(`git backup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** 只有檔案、沒有 commit 的卡片，一張補一個 commit，訊息格式與正常路徑相同。 */
  private async commitPendingCards(git: SimpleGit): Promise<number> {
    const status = await git.status();
    const isCard = (f: string) => f.startsWith('cards/') && f.endsWith('.md');
    const added = new Set([...status.not_added, ...status.created].filter(isCard));
    const modified = new Set(status.modified.filter(isCard));
    let n = 0;
    for (const [files, action] of [
      [added, 'add'],
      [modified, 'edit'],
    ] as const) {
      for (const file of files) {
        const id = path.basename(file, '.md');
        await git.add([file]);
        await git.commit(`${action} ${id}`);
        this.logger.info(`git: 補上未提交的卡片 ${action} ${id}`);
        n += 1;
      }
    }
    return n;
  }

  /**
   * 取回的步驟。順序有意義：
   *
   * 1. 先補上只有檔案、沒有 commit 的卡片。工作區不乾淨，rebase 會拒絕執行。
   * 2. `pull --rebase`，remote 與分支明寫——還沒建立追蹤關係時也取得回來。
   *    用 rebase 而不是 `--ff-only`：push 失敗時本機會積著還沒推上去的卡片 commit，
   *    `--ff-only` 會在那時候拒絕；rebase 只重寫那幾個還沒推上去的。
   * 3. 有衝突就放棄這次 rebase，語料庫回到原狀。不在伺服器上解衝突。
   * 4. 本機有領先遠端的 commit 就推上去。
   */
  private async pullNow(git: SimpleGit, puller: SimpleGit): Promise<PullResult> {
    await this.commitPendingCards(git);

    const remote = (await git.getRemotes(true))[0];
    if (!remote) return { kind: 'no-remote' };

    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const before = await headOf(git);
    try {
      await puller.raw(['pull', '--rebase', remote.name, branch]);
    } catch (err) {
      const message = errText(err);
      const files = await this.abortRebase(git);
      if (files !== null) {
        this.logger.warn(`git: 取回時有衝突，已放棄這次 rebase：${files.join(', ')}`);
        return { kind: 'conflict', files, message };
      }
      this.logger.error(`git pull failed: ${message}`);
      return { kind: 'failed', message };
    }

    // 取回的是遠端那一份裡、本機原本沒有的 commit。比對對象是 FETCH_HEAD 而不是
    // 新的 HEAD：本機還沒推上去的 commit 被 rebase 重寫之後也是「新的」，
    // 但它們不是取回來的。
    const commits = (
      await git.raw(['log', '--oneline', before === null ? 'FETCH_HEAD' : `${before}..FETCH_HEAD`])
    )
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (commits.length > 0) this.logger.info(`git: 取回了 ${commits.length} 個 commit`);

    const unpushed = await this.countUnpushed(git);
    if (unpushed === null || unpushed > 0) await this.push(git);
    return { kind: 'pulled', commits, pushPending: this.pushPending };
  }

  /**
   * rebase 停在一半就放棄它，回到取回之前。沒有停在 rebase 裡就回 null。
   *
   * 路徑問 git 而不是自己拼 `.git/rebase-merge`：worktree 底下的 `.git` 是一個檔案。
   */
  private async abortRebase(git: SimpleGit): Promise<string[] | null> {
    const inRebase = async (name: string) => {
      const p = (await git.raw(['rev-parse', '--git-path', name])).trim();
      return fs.existsSync(path.resolve(this.corpusPath, p));
    };
    if (!(await inRebase('rebase-merge')) && !(await inRebase('rebase-apply'))) return null;

    let files: string[] = [];
    try {
      files = (await git.status()).conflicted;
    } catch {
      // 列不出來就不列，放棄 rebase 才是要緊的那一步。
    }
    await git.rebase(['--abort']);
    return files;
  }

  private async push(git: SimpleGit): Promise<void> {
    const remotes = await git.getRemotes(true);
    const remote = remotes[0];
    if (!remote) {
      this.logger.warn('git: 沒有設定 remote，略過 push');
      return;
    }
    try {
      // 帶上 -u：第一次 push 順手把追蹤關係建立起來，之後才數得出未 push 的數量。
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      await git.push(['-u', remote.name, branch]);
      if (this.pushPending) this.logger.info('git: 積壓的 commit 已 push 成功');
      this.pushPending = false;
    } catch (err) {
      this.pushPending = true;
      this.logger.error(
        `git push failed (卡片已寫入本機，將於 5 分鐘後重試): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async retryPush(): Promise<void> {
    if (!this.pushPending) return;
    this.enqueue(async (git) => {
      this.logger.info('git: 重試 push');
      await this.push(git);
    });
  }

  private async countUnpushed(git: SimpleGit): Promise<number | null> {
    try {
      const out = await git.raw(['rev-list', '--count', '@{u}..HEAD']);
      return Number(out.trim());
    } catch {
      // 沒有 upstream（例如 remote 還沒設或分支未追蹤）就不猜。
      return null;
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 目前的 commit。還沒有任何 commit 的 repo 回 null。 */
async function headOf(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

/** 給測試與本機開發：把語料庫初始化成一個乾淨的 git repo。 */
export function ensureCorpusRepo(corpusPath: string): void {
  fs.mkdirSync(path.join(corpusPath, 'cards'), { recursive: true });
  const gitignore = path.join(corpusPath, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, 'index.db*\n*.tmp\n', 'utf8');
  }
}
