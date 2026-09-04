/** 卡片的四種類型、連結詞彙表、來源標記。 */

/**
 * 型別的判準是「這張卡錯的時候該怎麼修」，不是篇幅也不是隨興程度：
 *
 *   original     不是我寫的      抄錯了      → 重存一份
 *   restatement  對原文負責      我誤讀了    → 重讀原文，發新的重述 updates
 *   thinking     對世界負責      命題為假    → 換一個主張，發新的 thinking updates
 *   fleeting     尚未決定        ——          → 完整化成 thinking，或就讓它留著
 *
 * `fleeting` 存在的理由：一句隨口的話需要一個不必負責的地方。
 * 塞進 restatement 會讓「我誤讀了」和「我想錯了」共用一格，
 * 而這兩種錯的修法完全不同。
 */
export const CARD_TYPES = ['original', 'restatement', 'thinking', 'fleeting'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** 介面上顯示的名字。程式裡一律用英文型別名，只有呈現時翻成這個。 */
export const TYPE_LABELS: Record<CardType, string> = {
  original: '原始',
  restatement: '重述',
  thinking: '思考',
  fleeting: '碎片',
};

/** 連結關係，封閉集合，不接受其他值。 */
export const REL_TYPES = [
  'part-of',
  'about',
  'related',
  'supports',
  'contradicts',
  'refutes',
  'updates',
] as const;
export type Rel = (typeof REL_TYPES)[number];

/**
 * 介面上顯示的關係名。程式與檔案裡一律用英文 rel，只有呈現時翻成這個。
 *
 * 每條關係有兩個說法，因為同一條連結從兩端看是兩件事：
 *
 *     A --part-of--> B     在 A 上讀「節錄自 B」，在 B 上讀「節錄出 A」
 *
 * 方向編進詞裡（自／出），關係詞一律在標題**前面**——
 * 這樣一行掃過去就是一句話，不必先看標題再回頭找關係。
 *
 * 兩個破格：
 * - `contradicts` 兩端相同。它是對稱的：兩者不相容，誰也沒推翻誰。
 * - `refutes` 用被動而不是「反駁出」。這是唯一一條方向搞反會讓你以為
 *   自己反駁了沒反駁的東西的關係，寧可破格也不要含糊。
 */

/** 本卡指向那一張時的說法。表單的下拉與引用串的上游用它。 */
export const REL_LABELS: Record<Rel, string> = {
  'part-of': '節錄自',
  about: '關聯自',
  related: '延伸自',
  supports: '支撐自',
  contradicts: '牴觸',
  refutes: '反駁',
  updates: '更新自',
};

/** 那一張指向本卡時的說法。引用串的下游用它。 */
export const REL_LABELS_BACK: Record<Rel, string> = {
  'part-of': '節錄出',
  about: '關聯出',
  related: '延伸出',
  supports: '支撐出',
  contradicts: '牴觸',
  refutes: '被反駁',
  updates: '更新出',
};

// REPLY_TYPES 與 DEFAULT_REL 的決定被推翻，因為建立入口不再是「從一張卡開
// 一張新卡，型別自己選、關係預設 related」。CARD_ACTIONS 的每一顆按鈕同時
// 決定了型別與關係，沒有需要猜預設值的時刻。

/** 只有 original 類型可填。 */
export const PROVENANCES = ['default', 'translated', 'AI-summarized'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export interface CardLink {
  rel: Rel;
  to: string;
}

/** 一張卡片的 frontmatter。欄位順序即寫入檔案的順序。 */
export interface CardMeta {
  id: string;
  type: CardType;
  created: string;
  title: string;
  tags: string[];
  url: string | null;
  provenance: string | null;
  /** original 專屬。列表上「作者 · 年份」比內文開頭有資訊得多。 */
  source_author: string | null;
  /** 自由字串，不解析——「1962」「1962 年春」「明治三十年」都成立。 */
  source_date: string | null;
  revised: string | null;
  links: CardLink[];
}

export interface Card extends CardMeta {
  body: string;
}

/** 使用者送進來、還沒有 ID 的東西。 */
export interface CardDraft {
  type: string;
  title: string;
  body: string;
  tags: string[];
  url: string | null;
  provenance: string | null;
  source_author: string | null;
  source_date: string | null;
  links: { rel: string; to: string }[];
}

export function isCardType(v: unknown): v is CardType {
  return typeof v === 'string' && (CARD_TYPES as readonly string[]).includes(v);
}

export function isRel(v: unknown): v is Rel {
  return typeof v === 'string' && (REL_TYPES as readonly string[]).includes(v);
}

export function isProvenance(v: unknown): v is Provenance {
  return typeof v === 'string' && (PROVENANCES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- rel 矩陣

/** 一條 rel 從某個型別出發時，允許指向哪些型別。 */
export interface RelSpec {
  rel: Rel;
  /** 允許的目標型別。這是規則，也是表單收窄選項的依據——但不顯示給使用者。 */
  targets: readonly CardType[];
}

/**
 * 誰能用哪條 rel 指向誰。這是唯一的真相來源——驗證、表單的下拉選項、
 * 卡片頁的動作按鈕，三處都問這張表，不各自寫一套條件分支。
 *
 * 兩條刻意的收窄，理由值得留著：
 *
 * `supports` 排除 `fleeting`：隨口的一句話不能拿來當依據。這一刀同時給了
 * `supports` 與 `related` 一個**結構上**的差別——矩陣裡其他每一條都靠目標
 * 型別區分，若這兩條的目標都是「任意」，它們在表單上會長得一模一樣，
 * 差別只剩一句說明文字，而「這是依據」還是「還不知道關係」正是建立當下
 * 最難做的判斷。
 *
 * `related` 只開放給 `thinking`：它是唯一沒有語義的 rel，若每一型都能用，
 * 會變成萬用逃生口而讓整個詞彙表失去作用。
 *
 * 這張表預期會隨使用調整。調整對既有卡片是免費的——規則不追溯，
 * 違反現行規則的舊卡片只會出現在重建報告的警告清單上（R4）。
 */
export const REL_MATRIX: Record<CardType, readonly RelSpec[]> = {
  original: [
    // part-of  摘錄卡片指向母文件
    { rel: 'part-of', targets: ['original'] },
    // updates  換上更完整或更正確的副本
    { rel: 'updates', targets: ['original'] },
  ],
  restatement: [
    // about    這則重述在講哪份原始資料（R1 要求至少一條）
    { rel: 'about', targets: ['original'] },
    // updates  修正誤讀
    { rel: 'updates', targets: ['restatement'] },
  ],
  thinking: [
    // about       這則思考在講什麼
    { rel: 'about', targets: ['original', 'restatement'] },
    // supports    這是我的依據
    { rel: 'supports', targets: ['original', 'restatement', 'thinking'] },
    // contradicts 兩者不相容，尚未裁決
    { rel: 'contradicts', targets: ['thinking', 'restatement'] },
    // refutes     推翻
    { rel: 'refutes', targets: ['thinking', 'fleeting'] },
    // updates     取代舊主張，或完整化碎片
    { rel: 'updates', targets: ['thinking', 'fleeting'] },
    // related     關係尚未定型
    { rel: 'related', targets: CARD_TYPES },
  ],
  // R2：碎片不得有任何連結。一旦開始建立關聯，做的就是 thinking 的工作。
  fleeting: [],
};

/** 這一型能用哪幾條 rel。 */
export function allowedRels(from: CardType): Rel[] {
  return REL_MATRIX[from].map((s) => s.rel);
}

/** 這一型用這條 rel 時能指向哪些型別。整條 rel 不允許時回 null。 */
export function allowedTargets(from: CardType, rel: Rel): readonly CardType[] | null {
  return REL_MATRIX[from].find((s) => s.rel === rel)?.targets ?? null;
}

// ---------------------------------------------------------------- 卡片頁的動作

/**
 * 從一張卡開一張新卡時，那顆按鈕做什麼。
 *
 * 建立卡片的入口應該長在它的參照對象上，而不是全域：連結只能指向已經
 * 存在的卡片，所以任何帶連結的卡片，你在建立它的時候一定已經在看目標了。
 * 「先導航、再建立」是自然順序。
 *
 * 每顆按鈕都預填好新卡片的型別與那條連結，使用者不需要知道 R1/R3 存在。
 */
export interface CardAction {
  /** 按鈕上的字。 */
  label: string;
  /** 按下去建立什麼型別。 */
  creates: CardType;
  /** 新卡指回當前這張卡的那條連結。 */
  rel: Rel;
}

/**
 * 當前卡片的型別決定選單裡有哪些按鈕。
 *
 * 名字的取捨值得留著：
 * - 一條 rel 會有好幾個名字，因為語境不同：`updates` 從一般的卡上是
 *   「更新」（換一個更好的版本），從碎片上是「完整化」（把隨口的話變成主張）；
 *   `supports` 從重述上是「引證」（參照外部來源），從思考上是
 *   「進一步論述」（承接自己的話）。
 * - `contradicts` 的按鈕是「牴觸的發想」而不是「牴觸」：按下去產生的是
 *   一張新的思考，不是對這張卡做一個標記。名字要說出它會生出什麼。
 * - `fleeting` 沒有 supports 的按鈕（矩陣排除了它），
 *   `restatement` 沒有「反駁」——重述錯的方式是誤讀，那是 updates 的責任，
 *   「推翻一則重述」是類別錯誤。
 *
 * **順序是有意義的**，由使用者排定，不要按 rel 或字母重排。
 *
 * 這張表的每一列都必須是 REL_MATRIX 允許的組合，否則按鈕會產生一張
 * 送不出去的表單。測試會盯著這件事。
 */
export const CARD_ACTIONS: Record<CardType, readonly CardAction[]> = {
  original: [
    { label: '節錄', creates: 'original', rel: 'part-of' },
    { label: '重新描述', creates: 'restatement', rel: 'about' },
    { label: '發想', creates: 'thinking', rel: 'about' },
    { label: '更新', creates: 'original', rel: 'updates' },
  ],
  restatement: [
    { label: '發想', creates: 'thinking', rel: 'about' },
    { label: '牴觸的發想', creates: 'thinking', rel: 'contradicts' },
    { label: '引證', creates: 'thinking', rel: 'supports' },
    { label: '更新', creates: 'restatement', rel: 'updates' },
  ],
  thinking: [
    { label: '發想', creates: 'thinking', rel: 'related' },
    { label: '牴觸的發想', creates: 'thinking', rel: 'contradicts' },
    { label: '進一步論述', creates: 'thinking', rel: 'supports' },
    { label: '反駁', creates: 'thinking', rel: 'refutes' },
    { label: '更新', creates: 'thinking', rel: 'updates' },
  ],
  fleeting: [
    { label: '完整化', creates: 'thinking', rel: 'updates' },
    { label: '反駁', creates: 'thinking', rel: 'refutes' },
    { label: '發想', creates: 'thinking', rel: 'related' },
  ],
};

// 選單分成「新增關聯」與「宣告作廢」兩組、中間畫一條分隔線的決定被推翻，
// 因為那條線分不出實際的差別：每一顆按鈕產生的都是一張新卡，
// 差別在關係而不在後果，而關係已經由圖示與名字說了。
// 順序改由 CARD_ACTIONS 自己排定。
