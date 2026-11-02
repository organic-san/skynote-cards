/**
 * 語料庫根目錄那幾個小設定檔（`tags.yml`、`envs.yml`）共用的解析：
 * 一個頂層的鍵，底下一串字串。
 *
 * 逐行解析，不引 YAML 套件。認得的只有一種寫法：
 *
 * ```yaml
 * locked:
 *   - 匯入
 *   - "待整理"   # 引號可有可無
 * ```
 *
 * 只為了一個字串陣列拉進一個 YAML 解析器，是拿一整套語法的維護面
 * 去換這二十行。代價講明白：inline 陣列（`locked: [a, b]`）、錨點、多文件
 * 都不支援——寫成那樣會被靜默忽略，而不是報錯。這幾個檔案都只有一個鍵，
 * 那個代價可以接受。
 *
 * 引號裡的 `#` 不是註解：環境名稱可以含有「 #」。重複的值只留第一個。
 */
export function parseList(text: string, key: string): string[] {
  const out: string[] = [];
  const head = new RegExp(`^${key}\\s*:\\s*$`);
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    // 註解與空行不影響區塊的開闔——區塊由縮排決定。
    const line = stripComment(raw);
    if (line.trim() === '') continue;

    const item = /^\s+-\s*(.*)$/.exec(raw);
    if (inside && item) {
      const v = scalar(item[1] ?? '');
      if (v !== '' && !out.includes(v)) out.push(v);
      continue;
    }
    // 回到頂層：這個區塊結束了。
    inside = !/^\s/.test(line) && head.test(line.trim());
  }
  return out;
}

/** 一個值：引號包住的取引號裡面（單引號裡的 `''` 是一個 `'`），否則去掉註解。 */
function scalar(s: string): string {
  const v = s.trim();
  const double = /^"([^"]*)"/.exec(v);
  if (double) return double[1] ?? '';
  const single = /^'((?:[^']|'')*)'/.exec(v);
  if (single) return (single[1] ?? '').replace(/''/g, "'");
  return stripComment(v).trim();
}

function stripComment(s: string): string {
  return s.replace(/(^|\s)#.*$/, '');
}
