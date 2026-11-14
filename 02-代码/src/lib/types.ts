/**
 * 后端返回值类型（与 Rust 结构一一对应，docs D1 §8.2：类型定义放 types.ts）。
 * 边界一律 camelCase（§三.0 字段名口径表）：DB snake → Rust snake + rename_all="camelCase" → 这里。
 */

/** `ping` 命令返回体 */
export interface PingResult {
  pong: boolean;
  appVersion: string;
}

/** `get_settings` 返回体：app_setting 全量表（已知键：theme / guide_shown / review_intervals） */
export type AppSettings = Record<string, string>;

/** M6 · 记录页时间线一行（`get_reading_records`） */
export interface ReadingRecordView {
  articleId: number;
  title: string;
  /** 上次阅读位置（scrollTop 像素串；M6 之前的历史行可能为 null） */
  lastPosition: string | null;
  durationSec: number;
  completed: boolean;
  /** UTC 串（SQLite `datetime('now')`） */
  lastReadAt: string | null;
}

/** M6 · 统计卡六项 + 连续天数（`get_stats`） */
export interface StatsView {
  articleCount: number;
  completedCount: number;
  totalDurationSec: number;
  noteCount: number;
  vocabCount: number;
  reviewCount: number;
  streak: number;
}

/** 备份/恢复用的表行数 */
export interface TableCount {
  name: string;
  rows: number;
}

/** M6 · 生词导出结果（`export_vocab_html`） */
export interface ExportResult {
  path: string;
  count: number;
  bytes: number;
}

/** M6 · 备份结果（`backup_db`） */
export interface BackupResult {
  dbPath: string;
  metaPath: string;
  schemaVersion: number;
  tables: TableCount[];
}

/** M6 · 恢复结果（`restore_db`）：`diff` 为空表示与恢复前完全一致 */
export interface RestoreResult {
  restoredFrom: string;
  preBackupPath: string;
  tables: TableCount[];
  diff: string[];
}

/** 启动失败信息（`get_startup_error`）：`file` 只带 basename，成功启动时为 null */
export interface StartupErrorInfo {
  kind: string;
  message: string;
  file: string | null;
}

/** 文章库卡片（`list_articles` 一项） */
export interface ArticleSummary {
  /** 跳 `#/article/:id` 的唯一来源 */
  id: number;
  sourceKey: string;
  title: string;
  examType: string;
  examYear: number | null;
  examSet: string | null;
  sectionType: string | null;
  /** 中文题型名（卡片第三项；取内容包 manifest 的展示名） */
  sectionLabel: string | null;
  wordCount: number | null;
  /** 取冗余列 article.sentence_count（避免列表页聚合） */
  sentenceCount: number;
  source: string | null;
  visibility: string;
}

/** `list_articles` 的过滤条件：四类筛选 AND、同组多选 OR（空数组 = 不限） */
export interface ArticleFilter {
  visibility?: string;
  examTypes?: string[];
  years?: number[];
  sectionTypes?: string[];
  sources?: string[];
  keyword?: string;
}

/** `list_article_filter_options` 返回体 */
export interface FilterOptions {
  examTypes: string[];
  years: number[];
  sectionTypes: string[];
  sources: string[];
}

/** 精读页 token（IPC 形态） */
export interface ApiToken {
  id: number;
  /** 相对句子文本（ADR-008：UTF-16 code unit） */
  start: number;
  end: number;
  surface: string;
  normalized: string;
  /** **空格判定的唯一判据**：渲染时写 `isWord === false` */
  isWord: boolean;
}

export interface ApiSentence {
  /** M2 新增下发：`sentence.id`（查解析 / 存笔记的唯一句标识；`idx` 是篇内序号会跨段重复） */
  id: number;
  idx: number;
  start: number;
  end: number;
  text: string;
  tokens: ApiToken[];
  /** 该篇 blank_no 升序数组（后端按 blank 表给出，前端不猜） */
  blankNos: number[];
}

export interface ApiParagraph {
  idx: number;
  text: string;
  sentences: ApiSentence[];
}

export interface ApiQuestionOption {
  key: string;
  text: string;
}

export interface ApiQuestion {
  /** = 内容包 questions[].no（与 blank_no 同源） */
  idx: number;
  stem: string;
  options: ApiQuestionOption[];
  /** 随载荷下发（M2 判分用），**M1 页面不渲染** */
  answer: string | null;
}

export interface ApiArticleDetail {
  id: number;
  title: string;
  sourceKey: string;
  examType: string;
  examYear: number | null;
  examSet: string | null;
  sectionType: string | null;
  sectionLabel: string | null;
  passageLabel: string | null;
  wordCount: number | null;
  sentenceCount: number;
  source: string | null;
}

/** `get_article_content` 返回体 */
export interface ArticleContent {
  article: ApiArticleDetail;
  paragraphs: ApiParagraph[];
  questions: ApiQuestion[];
  /** M1 恒 true（内置 12 篇全有 sentence_analysis）；无解析篇的降级属 M5 */
  hasAnalysis: boolean;
}

/** `import_content_pack` 返回体 */
export interface ImportReport {
  imported: number;
  skipped: number;
  elapsedMs: number;
}

// ───────────────── M2 · 解析 / 词卡 / 空格 / 笔记（§三.0 字段名口径） ─────────────────

/**
 * 列表类字段的两形态：真实数据里 `more.synonyms`/`more.confusables` 数组与字符串都有
 * （string 130 / array 83）；`blank.distractors` 也有两形态（string 20 / array 10）。
 * 归一由纯函数 `normalizeList` 负责（`src/lib/analysis.ts`）。
 */
export type ListLike = string[] | string | null;

/** 句子成分（`components_json` 单项） */
export interface AnalysisComponent {
  part: string;
  role: string | null;
  note: string | null;
}

/** 重点短语（`phrases_json` 单项） */
export interface AnalysisPhrase {
  text: string;
  meaning: string | null;
  usage: string | null;
  example: string | null;
}

/** `get_sentence_analysis` 返回体：9 个解析字段 + 句标识（查不到返回 null） */
export interface SentenceAnalysis {
  sentenceId: number;
  translationLiteral: string | null;
  translationNatural: string | null;
  structMarkup: string | null;
  structureSummary: string | null;
  paragraphRole: string | null;
  components: AnalysisComponent[];
  clauses: string[];
  phrases: AnalysisPhrase[];
  pitfalls: string[];
}

/** `more` 字段（`more_json`）：值为对象，内部三项可能是数组也可能是字符串 */
export interface MoreInfo {
  roots?: ListLike;
  synonyms?: ListLike;
  confusables?: ListLike;
}

/** `get_token_analysis` 返回体（`isCet4HighFreq`——注意是 cet4，表结构如此） */
export interface TokenAnalysis {
  tokenId: number;
  phonetic: string | null;
  pos: string | null;
  senseInContext: string | null;
  collocations: ListLike;
  examples: ListLike;
  isCet4HighFreq: boolean;
  more: MoreInfo | null;
}

/** `lookup_lexicon` 返回体（`isCetHighFreq`——注意**不是** cet4） */
export interface LexiconEntry {
  normalized: string;
  word: string;
  phonetic: string | null;
  pos: string | null;
  sense: string | null;
  lemma: string | null;
  collocations: ListLike;
  examples: ListLike;
  isCetHighFreq: boolean;
  more: MoreInfo | null;
}

/** `get_blank_analysis` 返回体：字段钉死 5 个（02 D1） */
export interface BlankAnalysis {
  blankNo: number;
  answerKey: string | null;
  answerWord: string | null;
  reason: string | null;
  distractors: ListLike;
}

/** 句子笔记（3 栏，与表结构一一对应） */
export interface SentenceNote {
  sentenceId: number;
  translation: string | null;
  grammarNote: string | null;
  phraseNote: string | null;
  updatedAt: string;
}

/** 词笔记（3 栏） */
export interface WordNote {
  tokenId: number;
  contextMeaning: string | null;
  collocation: string | null;
  example: string | null;
  updatedAt: string;
}

/** `upsert_*_note` 返回体：全空清空 → 删行（deleted=true, updatedAt=null） */
export interface NoteUpsertResult {
  deleted: boolean;
  updatedAt: string | null;
}

/**
 * `get_article_note_marks` 返回体（TP-修复1 F4 / AC-R3）：**本篇**有笔记的句 / 词两组 id。
 * 一次 IPC 取全篇标记，正文层据此给句末角标与词节点打 `data-has-note`；
 * 空数组＝本篇暂无笔记（正常状态，不是错误）。
 */
export interface NoteMarks {
  sentenceIds: number[];
  tokenIds: number[];
}

// ───────────────── M3 · 生词本（5 个接口；VocabGroup / VocabFilter / VocabCardModel 在 lib/vocab.ts） ─────────────────

/**
 * 生词条目：`vocab_entry` 全列 + 来源文章标题 + 标签名。
 * `tagNames` 与条目同批返回（Rust 侧两次查询、不 N+1）；分组/筛选在 `lib/vocab.ts` 纯函数层做。
 */
export interface VocabEntry {
  id: number;
  /** 聚合键（UNIQUE）：同词不同句只有一条 */
  normalized: string;
  /** 首次加入形态（重复收藏不改它） */
  surface: string;
  phonetic: string | null;
  pos: string | null;
  /** 语境义：收藏瞬间的快照，内容包升级也不回溯 */
  contextMeaning: string | null;
  sourceSentenceId: number | null;
  sourceArticleId: number | null;
  /** 三档：`new` / `fuzzy` / `known`（DB CHECK 约束）；展示与顺序见 lib/vocab.ts 的 `Mastery` */
  mastery: string;
  /** M4 写、M3 只读 */
  reviewCount: number;
  /** M4 写、M3 只读 */
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tagNames: string[];
  /** 来源已删（`source_article_id` 被 SET NULL）时为 null */
  articleTitle: string | null;
}

/** `list_vocab` 返回体：包一层而不是裸数组，将来加分页/统计字段不必改命令契约 */
export interface VocabList {
  entries: VocabEntry[];
}

/**
 * `update_vocab` 的补丁：**只这四个字段**（表里没有搭配/例句列，也不许加列）。
 * 字段缺省 = 不改；显式 `null` = 清空；`mastery` 不接受 null（列 NOT NULL + CHECK）。
 */
export interface VocabPatch {
  contextMeaning?: string | null;
  phonetic?: string | null;
  pos?: string | null;
  mastery?: string;
}

/** 标签 */
export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

/** `add_vocab_from_token` 返回体：`created=false` 表示已在生词本（按钮文案用） */
export interface VocabAddResult {
  entry: VocabEntry;
  created: boolean;
}

// ──────────────── M4 · 复习（4 个类型；顺延纯函数在 lib/review.ts） ────────────────

/** 复习结果：done = 完成复习（顺延一档）/ need_more = 还需再看（不前进、明天再看） */
export type ReviewResult = "done" | "need_more";

/** 计划状态：active 参与到期查询 / paused 暂停（本包不做 UI）/ done 四档走完 */
export type ReviewPlanStatus = "active" | "paused" | "done";

/**
 * review_plan 一行。
 * nextReviewAt 是**本地日期** YYYY-MM-DD（不是时间戳、不用 UTC）；
 * intervalIndex = 已完成次数（0~3，走完四档后为 4 且 status='done'）。
 */
export interface ReviewPlan {
  articleId: number;
  nextReviewAt: string;
  intervalIndex: number;
  status: ReviewPlanStatus;
  /** 记录时刻（datetime('now')），不参与到期判定 */
  updatedAt: string;
  /**
   * 文章标题 —— **只有 `list_review_plans()` 会填**（JOIN `article`），
   * 其余 5 个返回计划的命令恒为空串 `""`（Rust `PLAN_SELECT` 不带 join）。
   *
   * concern 7 修复：复习页「已完成」区要显示标题而不是「文章 #id」。用**可选字段**而不是新类型
   * `ReviewPlanWithTitle`——`listReviewPlans()` 与其余 5 个命令共用 `ReviewPlan`，拆类型会让
   * api.ts 的 4 处既有用法跟着分叉；差异只在「有没有 title」这一处，留在类型上即可，
   * 消费方（Review.tsx）自己回退。
   */
  title?: string;
}

/** 今日到期的一行：计划 + 文章标题（复习页列表标题来源） */
export interface DueReview {
  articleId: number;
  title: string;
  nextReviewAt: string;
  intervalIndex: number;
}

/** 复习日志一行；intervalIndex 记的是**这次复习完成前**的档位 */
export interface ReviewLog {
  id: number;
  articleId: number;
  reviewedAt: string;
  intervalIndex: number;
  result: ReviewResult;
}

/**
 * `get_last_read_article` 返回体（TP-修复5 / M4-U3）：今日页「继续精读」栏的一行。
 * 无任何阅读记录时该命令返回 `null`（不是空数组、不是错误）。
 *
 * `lastReadAt` 是 `reading_record.last_read_at` 的**原样**值（SQLite `datetime('now')` 的 UTC 串），
 * 显示成 `MM-DD` 请走 `lib/date.ts::formatReadAt`（它按 UTC 解析再转本地，直接切字符串会差 8 小时）。
 */
export interface LastReadArticle {
  articleId: number;
  title: string;
  lastReadAt: string;
}

/**
 * `check_update` 返回体：三态由 `available` + `reason` 表达。
 *
 * - `available=true` → `version` 必有；`notes`/`url` 可能为 null（manifest 没给）
 * - `available=false` → `reason` 说明降级原因：
 *   `up-to-date` 已是最新 / `no-manifest` 还没发布过 manifest / `offline` 读不到或读坏了
 *
 * **该命令永不 reject**（后端把一切失败降级成 `available:false`），前端只按它改按钮旁文案，
 * 不弹技术错误（AC7）。
 */
export interface UpdateResult {
  available: boolean;
  version: string | null;
  notes: string | null;
  url: string | null;
  reason: string | null;
}