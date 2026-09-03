import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * 語料庫的 git 備份。
 *
 * 寫入路徑不得因備份失敗而阻塞，所以對外的方法都是 fire-and-forget，
 * 內部把每一種錯誤都吃掉：push 失敗、沒有 remote、根本不是 git repo，
 * 都只產生一行 log，絕不往上丟。
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const RETRY_INTERVAL_MS = 5 * 60 * 1000;

export interface GitBackupOptions {
  corpusPath: string;
  authorName: string;
  authorEmail: string;
  logger: Logger;
  retryIntervalMs?: number;
}

export class GitBackup {
  private readonly git: SimpleGit | null;
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
      this.disabledReason = `${opts.corpusPath} 不是 git repository，備份停用`;
      this.logger.warn(`git backup disabled: ${this.disabledReason}`);
    } else {
      this.git = simpleGit(opts.corpusPath, {
        config: [`user.name=${opts.authorName}`, `user.email=${opts.authorEmail}`],
      });
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

  /** 一張卡片一個 commit。不 await、不阻塞回應。 */
  commitCard(id: string, action: 'add' | 'edit'): void {
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

/** 給測試與本機開發：把語料庫初始化成一個乾淨的 git repo。 */
export function ensureCorpusRepo(corpusPath: string): void {
  fs.mkdirSync(path.join(corpusPath, 'cards'), { recursive: true });
  const gitignore = path.join(corpusPath, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, 'index.db\nindex.db-journal\n*.tmp\n', 'utf8');
  }
}
