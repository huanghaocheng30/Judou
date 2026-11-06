/**
 * 精读解析纯函数层（M2 D3）：标记解析 / 六段模型 / 词卡三态 / 空格拆条 / 列表归一。
 *
 * 三条纪律（沿用 M1 R8，`scripts/verify-analysis.mjs` 要 node 直接 import）：
 * 1. **不依赖 DOM**；
 * 2. **只用 erasable 语法**（禁 `enum` / `namespace` / 参数属性），类型导入一律 `import type`；
 * 3. **不 import `.css` / `.tsx`**。
 *
 * 四个模型类型（`MarkupPart` / `SentenceCardModel` / `WordCardModel` / `BlankCardModel`）
 * 定义并导出在本文件（02 D3 / 评审 N-8），不塞进 `types.ts`——它们只服务纯函数与卡片组件。
 */
import type {
  AnalysisComponent,
  AnalysisPhrase,
  BlankAnalysis,
  LexiconEntry,
  ListLike,
  MoreInfo,
  SentenceAnalysis,
  TokenAnalysis,
} from "./types";

// ─────────────────────────── ① 标记解析（AC3 核心） ───────────────────────────

/** 标记种类：五种成分 + 普通文本 */
export type MarkupKind = "subject" | "predicate" | "object" | "clause" | "phrase" | "text";

/** 解析出的一段 */
export interface MarkupPart {
  kind: MarkupKind;
  /**
   * 该段要显示的文本——**一律已去掉 `_` / `~` 标记符**（`【】`/`{}`/`()` 原样保留）。
   * 统一口径是「274/274 文本守恒」可达的必要条件（02 D3 第 1 条 / 决策记录 #20）。
   */
  text: string;
  /** 仅 fail-closed 退化时出现的单个 text part 携带（供断言；其余 part 为 undefined） */
  failedClosed?: boolean;
}

interface MarkupMarker {
  open: string;
  close: string;
  kind: Exclude<MarkupKind, "text">;
}

/**
 * 标记表：按「外层优先」扫描，顺序只影响同一位置的优先级（当前五类起始符互不相同，无歧义）。
 * `_…_` / `~…~` 是**样式标记**（标记符本身要去掉）；`【】` / `{}` / `()` 是**要显示的括号**（保留）。
 */
const MARKERS: MarkupMarker[] = [
  { open: "【", close: "】", kind: "subject" },
  { open: "{", close: "}", kind: "clause" },
  { open: "(", close: ")", kind: "phrase" },
  { open: "_", close: "_", kind: "predicate" },
  { open: "~", close: "~", kind: "object" },
];

/** 去标记符：只去掉 `_` 与 `~`，绝不碰 `【】{}()` */
function stripMarks(text: string): string {
  return text.replace(/[_~]/g, "");
}

function countChar(source: string, char: string): number {
  let count = 0;
  for (const ch of source) if (ch === char) count += 1;
  return count;
}

/**
 * `struct_markup` → 带样式的段序列。
 *
 * - `【…】`→subject、`_…_`→predicate、`~…~`→object、`{…}`→clause、`(…)`→phrase、其余→text
 * - **所有 part.text 一律去 `_`/`~`**（含嵌套内层）；因此
 *   `parts.map(p => p.text).join("") === markup.replace(/[_~]/g, "")` 恒等成立
 * - **fail-closed**：`_` 或 `~` 计数为奇数（标记未闭合）→ 整串退化为单个 text part、
 *   置 `failedClosed: true`，**不抛错**（内容包实有 7 句，白名单见 02 AC3）
 * - **嵌套按外层优先切、内层不展开**：`~{that …}~` 得到一个 object part，内部 `{}` 不另成段
 *
 * ponytail: 故意只支持五类**非嵌套**标记（天花板）——内容是题库标注、不是通用排版语言；
 * 若内容包 v2 真出现「嵌套语义」需求，再换栈式解析器（本函数签名与守恒判据不变）。
 */
export function parseMarkup(markup: string): MarkupPart[] {
  const source = typeof markup === "string" ? markup : "";
  if (source === "") return [];

  if (countChar(source, "_") % 2 === 1 || countChar(source, "~") % 2 === 1) {
    return [{ kind: "text", text: stripMarks(source), failedClosed: true }];
  }

  const parts: MarkupPart[] = [];
  let buffer = "";
  let index = 0;

  const flushText = (): void => {
    if (buffer === "") return;
    parts.push({ kind: "text", text: stripMarks(buffer) });
    buffer = "";
  };

  while (index < source.length) {
    const char = source[index];
    const marker = MARKERS.find((item) => item.open === char);
    if (!marker) {
      buffer += char;
      index += 1;
      continue;
    }
    const closeIndex = source.indexOf(marker.close, index + 1);
    if (closeIndex === -1) {
      // 闭合符缺失（但总计数为偶数，说明是错配）→ 当普通字符，不吞字
      buffer += char;
      index += 1;
      continue;
    }
    flushText();
    // 取**含括号**的整段再去 `_`/`~`：`【】`/`{}`/`()` 是要显示的括号（原样保留），
    // `_ _`/`~ ~` 的标记符本身要去掉（02 D3 第 1 条 / 决策记录 #19）。
    parts.push({ kind: marker.kind, text: stripMarks(source.slice(index, closeIndex + 1)) });
    index = closeIndex + 1;
  }
  flushText();

  return parts;
}

// ─────────────────────────── 通用小工具 ───────────────────────────

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `collocations` / `examples` / `more.*` / `distractors` 的两形态归一。
 *
 * - 数组：逐项取字符串、trim、去空（**不再按 `、` 二次拆**——数组项里的顿号是正文）
 * - 字符串：按 `、` 或换行逐条拆、去空
 * - JSON 数组文本：先按数组解析再归一（Rust 侧已解析，这里是构造用例与未来形态的兜底）
 *
 * ponytail: 分隔符只认 `、` 与换行（02 D3 口径）；英文串里的常见分隔 `/` 不拆——
 * 宁可把 `really / in fact` 当成一条完整释义，也不把 `A/B 测试` 这类词条劈开。
 */
export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeList(parsed);
    } catch {
      // 不是合法 JSON 数组 → 落到按分隔符拆
    }
  }
  return trimmed
    .split(/[、\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// ─────────────────────────── ② 六段式句子卡模型（AC2 / AC3） ───────────────────────────

/** 成分表一行（`components_json` 单项；`role`/`note` 允许缺失） */
export interface ComponentRow {
  part: string;
  role: string | null;
  note: string | null;
}

/** 短语一行（`phrases_json` 单项） */
export interface PhraseRow {
  text: string;
  meaning: string | null;
  usage: string | null;
  example: string | null;
}

/** ②段内容：结构摘要 + 成分表（`components` 收在这里，**模型不设顶层 components 字段**——决策 #23） */
export interface SentenceStructure {
  summary: string | null;
  components: ComponentRow[];
}

/** 六段各自「本段暂无解析」的判据 */
export interface SentenceCardEmptyFlags {
  translation: boolean;
  structure: boolean;
  clauses: boolean;
  phrases: boolean;
  pitfalls: boolean;
  paragraphRole: boolean;
}

/** 句子卡模型（`structMarkup` 单独保留——②段要先渲染符号句，不塞进 structure 免得丢原始标记串） */
export interface SentenceCardModel {
  /** ①直译 + 顺译合成为两行（`\n` 分隔），都空则 null */
  translation: string | null;
  /** ②主干与成分划分 */
  structure: SentenceStructure;
  /** ②段先渲染的符号句原文（交给 `parseMarkup`） */
  structMarkup: string | null;
  /** ③从句与语法点 */
  clauses: string[];
  /** ④重点短语 */
  phrases: PhraseRow[];
  /** ⑤易错点 */
  pitfalls: string[];
  /** ⑥段落作用 */
  paragraphRole: string | null;
  emptyFlags: SentenceCardEmptyFlags;
}

/** 六段固定序（唯一来源：组件按它渲染、门禁按它断言） */
export const SENTENCE_SEGMENT_ORDER = [
  "translation",
  "structure",
  "clauses",
  "phrases",
  "pitfalls",
  "paragraphRole",
] as const;

export type SentenceSegmentKey = (typeof SENTENCE_SEGMENT_ORDER)[number];

function toComponentRow(row: AnalysisComponent): ComponentRow {
  return {
    part: String(row?.part ?? ""),
    role: trimOrNull(row?.role ?? null),
    note: trimOrNull(row?.note ?? null),
  };
}

function toPhraseRow(row: AnalysisPhrase): PhraseRow {
  return {
    text: String(row?.text ?? ""),
    meaning: trimOrNull(row?.meaning ?? null),
    usage: trimOrNull(row?.usage ?? null),
    example: trimOrNull(row?.example ?? null),
  };
}

function composeTranslation(literal: string | null, natural: string | null): string | null {
  const lines: string[] = [];
  if (literal) lines.push(`直译：${literal}`);
  if (natural) lines.push(`顺译：${natural}`);
  return lines.length ? lines.join("\n") : null;
}

const EMPTY_SENTENCE_CARD: SentenceCardModel = {
  translation: null,
  structure: { summary: null, components: [] },
  structMarkup: null,
  clauses: [],
  phrases: [],
  pitfalls: [],
  paragraphRole: null,
  emptyFlags: {
    translation: true,
    structure: true,
    clauses: true,
    phrases: true,
    pitfalls: true,
    paragraphRole: true,
  },
};

/**
 * `SentenceAnalysis`（9 个解析字段）→ 六段固定序模型。`null`（无解析行）→ 全段降级。
 *
 * 缺字段的段只标 `empty: true`，**不做文案**——「本段暂无解析」由组件渲染（纯函数不管展示）。
 */
export function toSentenceCard(row: SentenceAnalysis | null): SentenceCardModel {
  if (!row) return { ...EMPTY_SENTENCE_CARD, structure: { summary: null, components: [] } };

  const translation = composeTranslation(trimOrNull(row.translationLiteral), trimOrNull(row.translationNatural));
  const summary = trimOrNull(row.structureSummary);
  const components = Array.isArray(row.components) ? row.components.map(toComponentRow) : [];
  const structMarkup = trimOrNull(row.structMarkup);
  const clauses = Array.isArray(row.clauses) ? row.clauses.filter((item) => trimOrNull(item) !== null) : [];
  const phrases = Array.isArray(row.phrases) ? row.phrases.map(toPhraseRow) : [];
  const pitfalls = Array.isArray(row.pitfalls) ? row.pitfalls.filter((item) => trimOrNull(item) !== null) : [];
  const paragraphRole = trimOrNull(row.paragraphRole);

  return {
    translation,
    structure: { summary, components },
    structMarkup,
    clauses,
    phrases,
    pitfalls,
    paragraphRole,
    emptyFlags: {
      translation: translation === null,
      structure: summary === null && components.length === 0 && structMarkup === null,
      clauses: clauses.length === 0,
      phrases: phrases.length === 0,
      pitfalls: pitfalls.length === 0,
      paragraphRole: paragraphRole === null,
    },
  };
}

// ─────────────────────────── ③ 词卡三态（AC4） ───────────────────────────

export type WordCardMode = "context" | "generic" | "none";

/** `more` 归一后的三项（默认折叠展示） */
export interface WordCardMore {
  roots: string[];
  synonyms: string[];
  confusables: string[];
}

export interface WordCardModel {
  /** 三态**唯一判定**（组件只读 mode，禁止再判一次——02 风险表） */
  mode: WordCardMode;
  headword: string | null;
  phonetic: string | null;
  pos: string | null;
  /** context → 语境义；generic → 通用义；none → null */
  sense: string | null;
  isCetHighFreq: boolean;
  collocations: string[];
  examples: string[];
  more: WordCardMore | null;
}

const EMPTY_WORD_CARD: WordCardModel = {
  mode: "none",
  headword: null,
  phonetic: null,
  pos: null,
  sense: null,
  isCetHighFreq: false,
  collocations: [],
  examples: [],
  more: null,
};

function mergeMore(primary: MoreInfo | null | undefined, secondary: MoreInfo | null | undefined): WordCardMore | null {
  const keys = ["roots", "synonyms", "confusables"] as const;
  const merged: WordCardMore = { roots: [], synonyms: [], confusables: [] };
  const primaryRecord = primary && typeof primary === "object" ? (primary as Record<string, ListLike>) : null;
  const secondaryRecord = secondary && typeof secondary === "object" ? (secondary as Record<string, ListLike>) : null;
  let any = false;
  for (const key of keys) {
    const first = normalizeList(primaryRecord?.[key]);
    const list = first.length ? first : normalizeList(secondaryRecord?.[key]);
    merged[key] = list;
    if (list.length) any = true;
  }
  return any ? merged : null;
}

function buildWordCard(
  mode: WordCardMode,
  tokenAnalysis: TokenAnalysis | null,
  lexicon: LexiconEntry | null,
  sense: string,
): WordCardModel {
  return {
    mode,
    headword: trimOrNull(lexicon?.word) ?? trimOrNull(lexicon?.normalized),
    phonetic: trimOrNull(tokenAnalysis?.phonetic) ?? trimOrNull(lexicon?.phonetic),
    pos: trimOrNull(tokenAnalysis?.pos) ?? trimOrNull(lexicon?.pos),
    sense,
    isCetHighFreq: Boolean(tokenAnalysis?.isCet4HighFreq) || Boolean(lexicon?.isCetHighFreq),
    collocations: normalizeList(tokenAnalysis?.collocations ?? lexicon?.collocations),
    examples: normalizeList(tokenAnalysis?.examples ?? lexicon?.examples),
    more: mergeMore(tokenAnalysis?.more, lexicon?.more),
  };
}

/**
 * 三态降级判定（**唯一实现**）：
 * ① 有 `token_analysis` 且语境义非空 → `context`
 * ② 否则有 `lexicon` 且通用义非空 → `generic`（标题显示「词义（通用）」）
 * ③ 都没有 → `none`（显示「暂无预置解析」，不留空白卡）
 */
export function pickWordCard(
  tokenAnalysis: TokenAnalysis | null,
  lexicon: LexiconEntry | null,
): WordCardModel {
  const contextSense = trimOrNull(tokenAnalysis?.senseInContext);
  if (contextSense) return buildWordCard("context", tokenAnalysis, lexicon, contextSense);
  const genericSense = trimOrNull(lexicon?.sense);
  if (genericSense) return buildWordCard("generic", tokenAnalysis, lexicon, genericSense);
  return { ...EMPTY_WORD_CARD };
}

// ─────────────────────────── ④ 空格三段式（AC5） ───────────────────────────

/** 空格卡模型；`empty: true` 表示该空无预置解析（只显示「第 N 空」+ 词库选项） */
export interface BlankCardModel {
  blankNo: number;
  answerKey: string | null;
  answerWord: string | null;
  reason: string | null;
  distractors: string[];
  empty: boolean;
}

/**
 * `blank` 行 → 空格卡模型。`row === null`（该空无行）→ 降级模型，**不报错、不留白**。
 *
 * `distractors` 两形态：数组直用（逐项）、字符串按 `、`/换行逐条换行（真实分布 string 20 / array 10）。
 */
export function toBlankCard(row: BlankAnalysis | null, blankNo: number): BlankCardModel {
  if (!row) {
    return { blankNo, answerKey: null, answerWord: null, reason: null, distractors: [], empty: true };
  }
  const answerKey = trimOrNull(row.answerKey);
  const answerWord = trimOrNull(row.answerWord);
  const reason = trimOrNull(row.reason);
  const distractors = normalizeList(row.distractors);
  return {
    blankNo: typeof row.blankNo === "number" ? row.blankNo : blankNo,
    answerKey,
    answerWord,
    reason,
    distractors,
    empty: answerKey === null && answerWord === null && reason === null && distractors.length === 0,
  };
}
