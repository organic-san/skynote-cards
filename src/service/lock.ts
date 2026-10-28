/**
 * 同一份語料庫的寫入一次只做一件。
 *
 * 寫入原本整段是同步的，Node 不會在中間插進別的請求，所以「先檢查、再寫」
 * （rev 比對、ID 發號、反芻期）天生是原子的。寫入要先等遠端存好之後，
 * 檢查與寫入中間隔著一次 await，另一個請求就可能插進來——兩台裝置同時存
 * 同一張卡，兩邊都通過 rev 比對，後到的無聲蓋掉先到的。
 *
 * 這把鎖把那個原子性還回來：卡片的建立、修改、勾選、刪除，以及「更新」，
 * 依序一件一件做。單人使用，等待的代價幾乎是零。
 *
 * 以語料庫路徑為鍵——測試會在同一個行程裡開好幾份語料庫。
 */

const tails = new Map<string, Promise<unknown>>();

export function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // 前一件失敗不影響這一件：失敗由它自己的呼叫端處理。
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  // 隊伍排空之後把鍵拿掉，不讓 Map 隨著測試開的語料庫越長越大。
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
