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
  /** 用户自己导入的篇数（`article.visibility='user'`）——入门任务第 ③ 项据此判定 */
  userArticleCount: number;
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
  /** `system` 内置 / `user` 我导入的 */
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

// ───────────────── M5 · 用户导入（02 v1.1 D2；两阶段：预览不写库 → 提交四层校验后入库） ─────────

/**
 * 两阶段①：`parse_import_preview` 返回体，也是两阶段② `commit_import` 的**入参**（整对象回传）。
 *
 * 偏移口径（001_init.sql ADR-008）：句子的 `start/end` 相对 `paragraph.text`、
 * token 的 `start/end` 相对 `sentence.text`，单位一律 **UTF-16 code unit**
 * ——不是 UTF-8 字节（中文 3 字节/1 单位、emoji 4 字节/2 单位），也不是字符下标。
 * 渲染时按 `text.slice(start, end)` 取不到正确结果，必须走 `lib/render.ts` 的 UTF-16 切法。
 */
export interface ImportPreview {
  title: string;
  paragraphs: ImportParagraph[];
  stats: ImportStats;
}

/** 预览里的一段；`idx` 从 0 连续（用户剔段后重排） */
export interface ImportParagraph {
  idx: number;
  text: string;
  sentences: ImportSentence[];
}

/** 一句；`start/end` 相对**所在段落**文本，UTF-16 单位 */
export interface ImportSentence {
  idx: number;
  start: number;
  end: number;
  text: string;
  tokens: ImportToken[];
}

/** 一个 token；`start/end` 相对**所在句子**文本，UTF-16 单位 */
export interface ImportToken {
  start: number;
  end: number;
  surface: string;
  /** 非词（标点/数字）为 `null`；词为小写且去尾部撇号（`students'` → `students`） */
  normalized: string | null;
  isWord: boolean;
}

/** 预览页统计（提交前后端不重算，用它校验） */
export interface ImportStats {
  paragraphCount: number;
  sentenceCount: number;
  tokenCount: number;
  wordCount: number;
}

/**
 * 预览页可选题材信息；两项都可缺省。
 * `examType` 只接受 `cet4` / `cet6` / `other`（后端越界即 `IMPORT_L4_BUSINESS`）。
 */
export interface ImportMeta {
  examType?: string | null;
  examYear?: number | null;
}

/** 两阶段②返回值：新文章 id + 本次生成的 `user-<hex>` 源键（每次提交都是新文章） */
export interface ImportCommitResult {
  articleId: number;
  sourceKey: string;
  stats: ImportStats;
}

// ───────────────── M5b · AI 解析导入（02 v1.2a D2；命令名与形状由 05 §十一之二 冻结） ─────────────────
//
// 分工：App 管结构（段/句/词/偏移由 Rust 算），AI 只出语义（解析/题目/词条）。
// 所以这些类型里**没有任何偏移字段**——payload 里就算带 `start`/`end`/`offset` 也会被忽略（AC8）。

/** 题型（用户在选择器里选，随 `AiDraft` 传给后端；模板按它裁剪片段） */
export type AiSection = "careful" | "long" | "cloze";

/**
 * 三档需求（M5c 04 §6.2 第 2 步）：
 * - `plain`（A）只要原文：不要求 AI 产出，可直接入库
 * - `analysis`（B）原文 + 解析：提示词带正文全文，不带题目区
 * - `full`（C，默认）原文 + 题目答案 + 解析：另带题目区原文，档 C 逐字比对
 */
export type ImportMode = "plain" | "analysis" | "full";

/** `split_user_input` 返回体：一次粘贴后的正文区 / 题目区（`detected=false` 时题目区为空串，不猜） */
export interface UserInputSplit {
  bodyText: string;
  questionText: string;
  /** 题目区起点（1-based 行号）；未识别时为 null */
  questionStartLine: number | null;
  detected: boolean;
  reason: string;
  /** 题目区里命中题号的行数（界面「含 K 道题」） */
  questionCount: number;
}

/** 编辑元信息（`update_article_meta`）：缺省字段 = 不改 */
export interface ArticleMetaPatch {
  title?: string | null;
  examType?: string | null;
  examYear?: number | null;
  sectionType?: AiSection | null;
  source?: string | null;
  difficulty?: string | null;
}

/** 题目视图（`get_article_questions` 下发 / `replace_article_questions` 入参） */
export interface QuestionView {
  /** 试卷题号（写 `question.idx`） */
  no: number;
  stem: string;
  options: AiOption[];
  answer: string | null;
  explanation: string | null;
  /** `user` 用户给的 / `ai` AI 补的 / `none` 都没有（AC8） */
  answerSource: string;
}

/** AI 模式入参：`ImportPreview`（既有，不动）+ 所选题型 + 三档需求 + 题目区原文 */
export interface AiDraft {
  preview: ImportPreview;
  section: AiSection;
  /** 缺省 = `full`（与后端 `ImportMode::default()` 同口径） */
  mode?: ImportMode;
  /** 档 C 的题目区原文（切分产物，原样塞进提示词并用于逐字比对） */
  questionText?: string | null;
}

/** `build_ai_prompt` 返回体：整段可复制的提示词 + 分批元信息 */
export interface AiPrompt {
  text: string;
  section: AiSection;
  sentenceCount: number;
  batchSize: number;
  batchCount: number;
  /** 句数 > batchSize 时的「建议分批（当前 N 句）」；不阻断（AC2） */
  batchHint: string | null;
}

/** `parse_ai_payload` 返回体：容错解析后的 payload + 被丢弃的说明文字字符数（AC13） */
export interface AiParseResult {
  payload: AiPayload;
  ignoredChars: number;
}

/** 轻量语义包（02 §三.1）；未知字段（offset/tokens/paragraphs…）后端忽略 */
/**
 * M5c 优化轮：`AI_TYPE_MISMATCH` 之后的题型建议。
 *
 * `null` ＝ 后端不敢猜（`suggest_section` 无匹配）——前端此时**不显示任何建议**，
 * 只保留原错误卡片，绝不替用户切题型。
 */
export type AiSectionSuggestion = AiSection | null;

export interface AiPayload {
  packVersion?: string | null;
  section: string;
  sentences: AiPayloadSentence[];
  questions?: AiPayloadQuestion[] | null;
  blankAnalyses?: AiBlankAnalysisInput[] | null;
  lexicon?: AiLexiconInput[] | null;
}

export interface AiPayloadSentence {
  /** 该句原文，必须与正文逐字符一致（App 用它对齐句子） */
  quote: string;
  /** 辅助编号：与 `quote` 冲突时以 `quote` 为准（AC18） */
  sNo?: string | null;
  analysis: AiAnalysis;
}

/** 句子解析九字段；`phrases` 两种形态后端都收（字符串项会投影成展示对象） */
export interface AiAnalysis {
  translationLiteral: string;
  translationNatural: string;
  structMarkup: string;
  structureSummary: string;
  components: AiComponentInput[];
  clauses?: string[] | null;
  phrases?: Array<string | AnalysisPhrase> | null;
  pitfalls?: string[] | null;
  paragraphRole?: string | null;
}

export interface AiComponentInput {
  part: string;
  role: string;
  note?: string;
}

export interface AiOption {
  key: string;
  text: string;
}

export interface AiPayloadQuestion {
  no: number;
  stem: string;
  /** careful 4 项 / long `[]` / cloze 15 项（形态错误会被拒收，见 AC7） */
  options?: AiOption[];
  /** 不在合法集合内 → 后端归一为无答案，不编造（AC16） */
  answer?: string | null;
  explanation?: string | null;
}

export interface AiBlankAnalysisInput {
  no: number;
  answerWord: string;
  reason: string;
  /** 契约是对象数组；字符串形态按非必填忽略（§三.4） */
  distractors?: unknown;
}

export interface AiLexiconInput {
  word: string;
  phonetic?: string | null;
  pos?: string | null;
  sense: string;
  collocations?: string[] | null;
  examples?: string[] | null;
  isCet4HighFreq?: boolean | null;
}

export interface AiMatchedSentence {
  paragraphIdx: number;
  sentenceIdx: number;
  quote: string;
  sNo?: string | null;
  analysis: AiAnalysis;
}

export interface AiUnmatchedSentence {
  quote: string;
  sNo?: string | null;
  /** 为什么没匹配上（界面逐条展示，不得静默丢弃） */
  reason: string;
}

export interface AiUnmatchedLexicon {
  word: string;
  reason: string;
}

export interface AiQuestionOut {
  idx: number;
  no: number;
  stem: string;
  options: AiOption[];
  answer: string | null;
  explanation: string | null;
  missingAnswer: boolean;
  /** M5c AC8：`user` 用户给的 / `ai` AI 补的 / `none` 都没有（库内 `question.answer_source`） */
  answerSource: string;
}

export interface AiBlankOut {
  no: number;
  answerWord: string;
  answerKey: string | null;
  reason: string;
  distractors: unknown[] | null;
}

/** 四类覆盖率（`x/y` 串；分母未知时只有 `x`，未知类别显示 `-`） */
export interface AiCoverage {
  analysis: string;
  questions: string;
  blanks: string;
  lexicon: number;
}

/** `match_ai_payload` 返回体，也是 `commit_ai_import` / `patch_ai_analysis` 的入参 */
export interface AiMatched {
  section: AiSection;
  matched: AiMatchedSentence[];
  unmatched: AiUnmatchedSentence[];
  unmatchedLexicon: AiUnmatchedLexicon[];
  questions: AiQuestionOut[];
  blanks: AiBlankOut[];
  lexicon: AiLexiconInput[];
  coverage: AiCoverage;
  /** AC18：编号与 quote 冲突、已按 quote 纠正的条数 */
  snoFixed: number;
  /** AC16：答案不在合法集合内、已归一为无答案的题数 */
  missingAnswer: number;
}

export interface AiCommitMeta {
  examType?: string | null;
  examYear?: number | null;
}

/** 覆盖率回读（补解析入口的初值；分母只有句数已知） */
export interface AiImportStats {
  sentences: number;
  analysisCovered: number;
  questions: number;
  blanks: number;
  lexicon: number;
}

export interface AiCommitReport {
  articleId: number;
  sourceKey: string;
  analysisWritten: number;
  questionsWritten: number;
  blanksWritten: number;
  lexiconInserted: number;
  coverage: AiCoverage;
  stats: AiImportStats;
}

export interface AiPatchReport {
  articleId: number;
  analysisWritten: number;
  questionsWritten: number;
  blanksWritten: number;
  lexiconInserted: number;
  stats: AiImportStats;
}

// ───────────────── M7 · 更新检查（离线优先，不引网络依赖；02 §三.1 裁定） ─────────────────

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