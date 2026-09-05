import type { ThreadNode } from '../store/index/index.ts';
import type { Rumination } from '../domain/rules.ts';
import type { ListRow } from '../service/lists.ts';
import {
  CARD_ACTIONS,
  REL_LABELS,
  REL_LABELS_BACK,
  REL_MATRIX,
  TYPE_LABELS,
  type CardType,
  type Rel,
} from '../domain/types.ts';

/**
 * 資料列 → view model。
 *
 * 模板只會拿到已經格式化好的字串與旗標，不會拿到資料列；
 * 「這一列在畫面上長什麼樣子」的判斷全部集中在這裡。
 */

/**
 * 列表上的一項。
 *
 * 模板只會拿到這四個可為 null 的欄位，然後有什麼畫什麼——它不知道
 * 有幾種型別，也不知道哪一型該顯示什麼。所有 per-type 的差異都在
 * 下面那張表裡。
 */
export interface Item {
  id: string;
  type: string;
  typeLabel: string;
  /** null 表示這一型沒有標題（碎片），那段話改由 excerpt 承接。 */
  heading: Heading | null;
  /** U3 左欄的日期。U4 的相對說法由用戶端改寫。 */
  date: Stamp;
  /** 內文開頭。null 代表這一型不顯示內文。 */
  excerpt: string | null;
  /**
   * U5 的 meta 行，型別名之後的那幾段。已經按 `·` 的順序排好，
   * 模板只負責用分隔符串起來——哪一型顯示什麼在 ITEM_SHAPES 分岔一次。
   */
  meta: string[];
  tags: string[];
}

/**
 * 標題在畫面上的呈現。
 *
 * `null` 表示這一型**沒有標題**——目前只有碎片。碎片的整段話存在 `title`
 * 欄位裡（見 domain/card.ts 的欄位反轉），但那是儲存上的權宜，不是說它
 * 真的有一個名字。把它印成標題就會得到一面粗體的牆。
 *
 * `long` 是「這個標題長到不像標題」。標題沒有長度上限，而版面的每一處都
 * 假設它很短。卡片主體上不截斷——那是唯一看得到完整標題的地方，截了就沒了；
 * 改成降一階視覺重量，讓它排起來像一段話而不是一面招牌。
 */
export interface Heading {
  text: string;
  long: boolean;
}

/** 超過這個字數就算長。以碼位算，中文一個字算一個。 */
export const TITLE_LONG = 40;

/** 碎片沒有標題這件事，只在這裡判斷一次。 */
export function headingOf(card: { type: string; title: string }): Heading | null {
  if (card.type === 'fleeting') return null;
  return { text: card.title, long: [...card.title].length > TITLE_LONG };
}

/**
 * 把一段文字截到 max 個字。
 *
 * 只用在**標題被嵌進一句話裡**的位置（「從《X》的完整化」、「已從 X 建立」）。
 * 那種地方 CSS 截不乾淨：要把 X 包成 inline-block 才截得動，而 inline-block
 * 夾在句子中間，行高與基線都會歪。標題自成一格的位置一律交給 CSS，
 * 因為那邊寬度由版面決定，伺服器不該猜。
 */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/**
 * 這一型的列表項長什麼形狀。
 *
 * 四型原本只差一顆型別籤，形狀完全一樣——差別全壓在那顆籤上，
 * 掃過去就是一片同樣的東西。現在讓形狀自己說話：
 * `original` 把出處放到標題之上、`restatement` 在底下指出它在講哪一份、
 * `thinking` 只有標題與內文、`fleeting` 根本不長得像一張卡。
 * 型別籤留著，但改由顏色承接辨識（見 css/tokens.css 的 --type-*）。
 */
type Shape = (row: ListRow) => Pick<Item, 'excerpt' | 'meta'>;

const ITEM_SHAPES: Record<CardType, Shape> = {
  /**
   * 資料：作者與原始年份，加上被接住的次數。不顯示內文開頭——
   * 這張卡最要緊的事實是它從哪裡來，不是它自己說了什麼。
   * 作者或年份缺漏整段略過（U5）。
   */
  original: (row) => ({
    excerpt: null,
    meta: [sourceLine(row.source_author, row.source_date), citeLine(row)].filter(
      (x): x is string => x !== null,
    ),
  }),
  /** 重述：標題加內文前兩行，以及它在講哪一份資料。 */
  restatement: (row) => ({
    excerpt: excerpt(row.body),
    meta: row.about ? [row.about.title] : [],
  }),
  /** 思考：標題加內文前兩行，以及兩個方向的連結數。 */
  thinking: (row) => ({
    excerpt: excerpt(row.body),
    meta: [`出向 ${row.link_count} · 入向 ${row.inbound}`],
  }),
  /**
   * 碎片：那段話就是內容，所以它走**內文**的位置，不走標題的位置。
   * 印成標題會得到一面粗體的牆；印在內文位置則自動吃到 .rowtext 的兩行截斷。
   * meta 沒有別的欄位——型別籤已經說完了。
   */
  fleeting: (row) => ({ excerpt: excerpt(row.title), meta: [] }),
};

export function toItem(row: ListRow): Item {
  const shape = ITEM_SHAPES[row.type as CardType] ?? ITEM_SHAPES.thinking;
  return {
    id: row.id,
    type: row.type,
    typeLabel: TYPE_LABELS[row.type as CardType] ?? row.type,
    heading: headingOf(row),
    date: stampShort(row.created),
    tags: row.tags,
    ...shape(row),
  };
}

/**
 * 關係在畫面上的說法。
 * `out` 是本卡指向那一張，`in` 是那一張指向本卡——同一條連結，兩種讀法。
 */
export function relLabel(rel: string, direction: 'in' | 'out' = 'out'): string {
  const table = direction === 'in' ? REL_LABELS_BACK : REL_LABELS;
  return table[rel as Rel] ?? rel;
}

/**
 * 「Herbert A. Simon · 1962」。
 *
 * U5：作者或年份缺漏就整段略過，不留空欄——半行資訊比沒有更難讀。
 * `source_date` 是自由字串，照原樣顯示。
 */
function sourceLine(author: string | null, date: string | null): string | null {
  const parts = [author, date].filter((x): x is string => !!x && x.trim() !== '');
  return parts.length === 0 ? null : parts.join(' · ');
}

/** 「3 則重述 / 2 則引用」。都是 0 就整段不要。 */
function citeLine(row: ListRow): string | null {
  const cites = row.inbound - row.restatements;
  if (row.restatements === 0 && cites === 0) return null;
  return `${row.restatements} 則重述 / ${cites} 則引用`;
}

/**
 * 引用串的一列。
 *
 * 這裡曾經是一棵巢狀的樹，交給模板遞迴出巢狀的 `<ul>`。那個結構有兩個毛病：
 *
 * 1. 展開鈕自成一行，落在「比父深、比子淺」的縮排上，眼睛沒辦法把它歸給誰。
 * 2. 上游要向上長，於是三層 `column-reverse`，再補一條「flex 化的 details
 *    不會自己藏收合內容」的規則——一個機制配一條補丁。
 *
 * 攤平之後兩個都消失：**伺服器直接依視覺順序輸出**，上游就是下游那串的反序，
 * 模板不再遞迴、CSS 不再翻轉容器；縮排改由每一列自己畫的軌道表達，
 * 展開鈕併回它自己那一列。
 *
 * 代價講明白：收合從 `<details>`（瀏覽器內建）換成 class 切換（app.js）。
 * 沒有 JS 時仍看得到預設深度，但展不開。
 */
export interface ThreadRow {
  id: string;
  rel: string;
  relLabel: string;
  type: string | null;
  typeLabel: string;
  title: string | null;
  date: Stamp;
  missing: boolean;
  repeated: boolean;
  depth: number;
  /**
   * 縮排軌道。第 j 格對應深度 j 的那一層：畫線表示那一層的祖先後面還有兄弟，
   * 線要穿過這一列繼續往下。最後一格是這一列自己的分枝，見 `branch`。
   */
  rails: ('line' | 'blank')[];
  /** `tee` 後面還有同層的兄弟，`elbow` 是最後一個（軌道到此為止）。 */
  branch: 'tee' | 'elbow' | null;
  /** 子節點數。0 表示這一列沒有展開鈕。 */
  children: number;
  /** 這一列的識別碼，給 data-key 用。 */
  key: string;
  /** 祖先的 key，由淺到深。收合時靠這個認親。 */
  ancestors: string[];
  /** 預設看不看得到。 */
  visible: boolean;
  /** 預設展不展開（只有 children > 0 時有意義）。 */
  expanded: boolean;
}

interface Walked {
  node: ThreadNode;
  depth: number;
  key: string;
  ancestors: string[];
  /** DOM 順序裡是不是同層的最後一個。軌道的判斷一律在下游的框架裡做。 */
  last: boolean;
}

/**
 * 把 linkTree 的樹攤成依視覺順序排好的列。
 *
 * 同一條連結從兩端看是兩件事，所以關係名分兩套（見 REL_LABELS）：
 * - `out`（上游，本卡指向的目標）→「節錄自 ⟨那張卡⟩」
 * - `in`（下游，指向本卡的來源）→「節錄出 ⟨那張卡⟩」
 *
 * 方向另外還決定順序：下游是前序（父在上、子在下），上游是它的**完整反序**。
 * 軌道一律按下游算，上游靠 CSS 把軌道垂直翻一次——反序加上鏡射就是鏡像，
 * 所以不需要第二套判斷。
 */
export function flattenThread(
  nodes: ThreadNode[],
  openDepth: number,
  direction: 'in' | 'out',
): ThreadRow[] {
  const walked: Walked[] = [];
  const walk = (list: ThreadNode[], depth: number, ancestors: string[]): void => {
    list.forEach((n, i) => {
      const key = `${direction}${walked.length}`;
      walked.push({ node: n, depth, key, ancestors, last: i === list.length - 1 });
      walk(n.children, depth + 1, [...ancestors, key]);
    });
  };
  walk(nodes, 0, []);

  const byKey = new Map(walked.map((w) => [w.key, w]));
  const rows = walked.map((w): ThreadRow => {
    const n = w.node;
    return {
      id: n.id,
      rel: n.rel,
      relLabel: relLabel(n.rel, direction),
      type: n.type,
      typeLabel: n.type === null ? '' : (TYPE_LABELS[n.type as CardType] ?? n.type),
      title: n.title,
      date: stampShort(n.created),
      missing: n.title === null,
      repeated: n.repeated,
      depth: w.depth,
      // 自己那一格是分枝，其餘才是祖先的直線。
      rails: w.ancestors
        .slice(1)
        .map((k) => ((byKey.get(k) as Walked).last ? 'blank' : 'line')),
      branch: w.depth === 0 ? null : w.last ? 'elbow' : 'tee',
      children: n.children.length,
      key: w.key,
      ancestors: w.ancestors,
      // 父層展開，這一列才看得見；深度 0 永遠看得見。
      visible: w.depth <= openDepth,
      expanded: w.depth < openDepth,
    };
  });

  return direction === 'out' ? rows.reverse() : rows;
}

// ---------------------------------------------------------------- 格式化

/**
 * 時間的呈現。
 *
 * **資料一律 UTC，渲染時區以用戶端為主。** 所以伺服器只給兩樣東西：
 * `datetime` 屬性放 UTC 的真值，內容放伺服器算的保底文字；
 * 真正的呈現由 public/app.js 依瀏覽器時區改寫（U4 的相對日期表）。
 *
 * 沒有 JS 也讀得到（只是可能差一天），有 JS 就依你所在的時區正確——
 * 這是漸進增強，不是依賴 JS。
 */
export interface Stamp {
  /** UTC ISO，放進 <time datetime>。用戶端據此重算。 */
  iso: string;
  /** 伺服器算的保底文字。 */
  text: string;
}

// 模板一律寫成 <time datetime="{iso}">{text}</time>，相對日期再加 data-rel。
// 這一小段曾經是個 partial，被移除了——Eta 在非 production 下每次 include 都會
// 重新編譯模板，一頁 50 列就是 50 次，實測讓首頁從 250ms 掉到 460ms。
// 一個元素的抽象換不到那個代價。

/**
 * D.5：反芻期在 meta 行末尾的那一段。
 *
 * U12 說得很清楚：不加框、不做倒數跳動。所以這裡給的是一個靜態字串，
 * 而不是一個每秒跳一次的數字——卡片頁是拿來讀的。代價是頁面開著幾小時之後
 * 那個數字會過期，所以 `until` 帶著 UTC 真值進 <time datetime>，
 * 由 app.js 算一次；重新整理就正確。秒級的倒數只留在編輯頁，
 * 在那一頁你就是在跟那段時間賽跑。
 *
 * 已定案的卡片什麼都不顯示。那是絕大多數卡片的狀態，標出來等於在每一張卡上
 * 重複一句沒有訊息量的話；有訊息量的是「這張還改得動，還剩多久」。
 * U12 原本給的「已定案」那個狀態因此被拿掉。
 */
export interface RuminationView {
  open: boolean;
  /** 窗口結束的 UTC ISO。已定案時是空字串。 */
  until: string;
  /** 伺服器算的保底文字。 */
  text: string;
}

export function ruminationView(r: Rumination, now = Date.now()): RuminationView {
  // 定案不標出來：那是絕大多數卡片的狀態，標了等於在每一張卡上重複一句
  // 沒有訊息量的話。有話要說的是還改得動的那少數。
  if (!r.open) return { open: false, until: '', text: '' };
  return { open: true, until: r.until, text: remainText(Date.parse(r.until) - now) };
}

/** 「3 小時」／「12 分鐘」。不到一分鐘就說「快結束了」，不報秒數。 */
export function remainText(ms: number): string {
  if (ms <= 0) return '已定案';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '快結束了';
  if (mins < 60) return `${mins} 分鐘`;
  return `${Math.floor(mins / 60)} 小時`;
}

/** 卡片詳細頁一律顯示絕對日期與時間，不套 U4 的相對說法。 */
export function stampFull(iso: string): Stamp {
  return { iso, text: fmtTime(iso) };
}

/** 列表與關聯區塊用相對說法，由用戶端改寫。 */
export function stampShort(iso: string | null): Stamp {
  return { iso: iso ?? '', text: fmtDate(iso) };
}

/** UTC 時間，精簡到分。用戶端會依自己的時區改寫。 */
export function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString().slice(0, 10);
}

/**
 * 內文開頭的一小段，給列表與引用串用。
 * 只剝掉會在單行裡變成雜訊的 markdown 記號，不做完整解析。
 */
export function excerpt(body: string | null, max = 90): string {
  if (!body) return '';
  const flat = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*[#>\-*+]+\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------- 建立表單

/**
 * 這一型的表單長什麼樣子。
 *
 * 模板拿到的是幾個布林值，不是型別名——「original 才顯示 url」這種判斷
 * 只在這張表裡出現一次，不散進 .eta 與前端腳本各寫一遍。
 */
export interface FormSpec {
  /** 只有一個大文字框，不區分標題與內文（A.5 的欄位反轉）。 */
  single: boolean;
  /** url 對 original 是主要欄位，從收合區移出來。其他型別關閉。 */
  url: boolean;
  /** provenance 與 source_author / source_date，original 專屬。 */
  source: boolean;
  /** 能不能加連結。碎片不行（R2）。 */
  links: boolean;
}

const FORM_SPECS: Record<CardType, FormSpec> = {
  original: { single: false, url: true, source: true, links: true },
  restatement: { single: false, url: false, source: false, links: true },
  thinking: { single: false, url: false, source: false, links: true },
  fleeting: { single: true, url: false, source: false, links: false },
};

/**
 * U14：表單頂端的一行，說這是什麼動作。
 *
 * 從卡片的 `+` 進來時要說出是從哪一張、做什麼——那是 v2 C.4 對「來源可見」
 * 的要求，但提前到送出**之前**：送出後才知道自己剛才在做什麼已經太遲了。
 */
export function formTitle(
  type: string,
  rel: string,
  source: { title: string; type: string } | null,
): string {
  if (!source || rel === '') {
    return type === 'original' ? '追加外部資料' : '新增卡片';
  }
  const action = (CARD_ACTIONS[source.type as CardType] ?? []).find(
    (a) => a.rel === rel && a.creates === type,
  );
  // 標題嵌在句子裡，所以在這裡截——見 clip 的說明。
  return `從《${clip(source.title, 24)}》的${action ? action.label : '建立'}`;
}

/**
 * 還沒選型別時什麼都不開，包括連結。
 *
 * rel 的合法組合是由「新卡的型別」決定的，型別還沒定，就沒有任何一條 rel
 * 列得出來——這時候給一個空的下拉選單，比不給更糟：它看起來就是壞的。
 */
export function formSpec(type: string): FormSpec {
  return FORM_SPECS[type as CardType] ?? { single: false, url: false, source: false, links: false };
}

/** 整張表送給前端，讓它換型別時不必自己知道規則。 */
export const FORM_SPEC_TABLE = FORM_SPECS;

/**
 * 這張卡的詳細頁上，`+` 選單裡有哪幾顆按鈕。
 * 每一顆都把新卡的型別與那條連結填好，帶著回來這張卡的 ID。
 */
export function actionsFor(type: string, id: string) {
  const actions = CARD_ACTIONS[type as CardType] ?? [];
  return actions.map((a) => ({
    label: a.label,
    href: `/new?type=${a.creates}&rel=${encodeURIComponent(a.rel)}&to=${id}`,
    rel: a.rel,
  }));
}

export interface RelOption {
  value: string;
  /** 介面上的名字。跟引用串用同一組，畫面上不再出現內部 rel 名。 */
  label: string;
  /** 允許的目標型別。**只拿來過濾，不顯示**——你選目標的時候已經在看它了，
   *  「我可以指向誰」是回頭才有用的資訊。 */
  targets: string[];
}

/**
 * 表單裡的 rel 下拉。
 *
 * 依「新卡的型別」收窄；目標已知時再依目標的型別收窄一次。
 * 列不出來的組合按下去只會被規則擋掉，而被擋的當下看不出為什麼——
 * 所以乾脆不列。這是 R3 硬擋能不刺人的前提。
 */
export function relOptions(type: string, targetType?: string | null): RelOption[] {
  const specs = REL_MATRIX[type as CardType] ?? [];
  return specs
    .filter((s) => !targetType || (s.targets as readonly string[]).includes(targetType))
    .map((s) => ({
      value: s.rel,
      label: REL_LABELS[s.rel],
      targets: [...s.targets],
    }));
}
