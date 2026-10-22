import type { GitBackup, PullResult } from '../store/backup.ts';
import type { CardIndex, ReindexReport } from '../store/index/index.ts';

/**
 * 側欄的「更新」（v3 §7）：取回語料庫的最新版本，再重建索引。
 *
 * 版本更改時卡片檔可能要手動調整——在別處的 clone 裡改好、push 上去。
 * 這一支把那些結果拉回伺服器。手改的檔案可以繞過應用程式的規則（改型別、
 * 改已定案的卡），那是刻意留的出口：重建報告會列出因此違反現行規則的卡（R4）
 * 與壞掉的連結。
 *
 * 不是 git repository、或沒有 remote 時只重建索引——直接在伺服器上改檔也用得到。
 */

export interface UpdateOutcome {
  pull: PullResult;
  /** 取回失敗或衝突時語料庫沒有變動，不重建，這裡是 null。 */
  reindex: ReindexReport | null;
}

export async function updateCorpus(git: GitBackup, index: CardIndex): Promise<UpdateOutcome> {
  const pull = await git.pull();
  if (pull.kind === 'conflict' || pull.kind === 'failed') return { pull, reindex: null };
  return { pull, reindex: index.rebuild() };
}
