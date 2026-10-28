import type { GitBackup, PullResult } from '../store/backup.ts';
import type { CardIndex, ReindexReport } from '../store/index/index.ts';
import { gitObjects, reconcile, type ReconcileReport } from '../store/reconcile.ts';
import type { CorpusStore } from '../store/remote.ts';
import { withWriteLock } from './lock.ts';

/**
 * 側欄的「更新」（v3 §7）：取回語料庫的最新版本，再重建索引。
 *
 * 版本更改時卡片檔可能要手動調整——在別處的 clone 裡改好、push 上去。
 * 這一支把那些結果拉回伺服器。手改的檔案可以繞過應用程式的規則（改型別、
 * 改已定案的卡），那是刻意留的出口：重建報告會列出因此違反現行規則的卡（R4）
 * 與壞掉的連結。
 *
 * 不是 git repository、或沒有 remote 時只重建索引——直接在伺服器上改檔也用得到。
 *
 * 有遠端存放處（App Engine）時，取回之後還要跟 bucket 對帳：取回來的修改
 * 傳上 bucket，bucket 上較新的寫入（別的 instance 寫的、還沒推上去的）寫進本機，
 * 補 commit 推上去。開機時做的是同一件事，只是前面是 clone 而不是 pull。
 * 整段拿著寫入鎖，對帳的時候不會有一張卡寫到一半。
 */

export interface UpdateDeps {
  corpusPath: string;
  git: GitBackup;
  index: CardIndex;
  store: CorpusStore;
  logger: { warn(msg: string): void; error(msg: string): void };
}

export interface UpdateOutcome {
  pull: PullResult;
  /** 跟 bucket 對帳的結果。沒有遠端存放處、或取回失敗時是 null。 */
  store: { report: ReconcileReport | null; error: string | null } | null;
  /** 取回失敗或衝突時語料庫沒有變動，不重建，這裡是 null。 */
  reindex: ReindexReport | null;
}

export function updateCorpus(deps: UpdateDeps): Promise<UpdateOutcome> {
  return withWriteLock(deps.corpusPath, async () => {
    const pull = await deps.git.pull();
    if (pull.kind === 'conflict' || pull.kind === 'failed') {
      return { pull, store: null, reindex: null };
    }

    let store: UpdateOutcome['store'] = null;
    if (deps.store.kind !== 'none') {
      try {
        const report = await reconcile({
          corpusPath: deps.corpusPath,
          store: deps.store,
          history: await gitObjects(deps.corpusPath),
          logger: deps.logger,
        });
        await deps.git.commitAndPush();
        store = { report, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.error(`跟遠端存放處對帳失敗: ${message}`);
        store = { report: null, error: message };
      }
    }

    return { pull, store, reindex: deps.index.rebuild() };
  });
}
