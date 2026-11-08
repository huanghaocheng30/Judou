/**
 * 唯一后端入口（docs D1 §7.4 / §8.2）：全项目只有本文件允许出现 `invoke(`。
 * 组件一律 import 这里的 camelCase 封装，禁止裸 invoke 字符串。
 *
 * 参数命名：Tauri v2 命令参数按 camelCase 传（Rust 侧 snake_case 参数会自动对上），
 * 所以 `get_article_content(articleId)` 对应 Rust 的 `article_id`。
 *
 * ponytail: 每个命令一行的薄封装，不做统一 request 包装层——
 * 8 个命令时包装层只是多余的间接；等出现统一的错误码映射再抽。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AiCommitMeta,
  AiCommitReport,
  AiDraft,
  AiMatched,
  AiParseResult,
  AiPatchReport,
  AiPayload,
  AiPrompt,
  AiSectionSuggestion,
  AiImportStats,
  AppSettings,
  ArticleContent,
  ArticleFilter,
  ArticleMetaPatch,
  ArticleSummary,
  BlankAnalysis,
  DueReview,
  FilterOptions,
  ImportCommitResult,
  ImportMeta,
  ImportPreview,
  ImportReport,
  LastReadArticle,
  LexiconEntry,
  NoteMarks,
  NoteUpsertResult,
  PassageSpan,
  PingResult,
  QuestionView,
  ReviewLog,
  ReviewPlan,
  ReviewResult,
  SentenceAnalysis,
  SentenceNote,
  StartupErrorInfo,
  TokenAnalysis,
  VocabAddResult,
  VocabEntry,
  VocabList,
  VocabPatch,
  Tag,
  UpdateResult,
  UserInputSplit,
  WordNote,
} from "./types";
import type { VocabFilter, VocabGroupBy } from "./vocab";

/** 连通性探针：返回 pong 与 Cargo 包版本 */
import type {
  BackupResult,
  ExportResult,
  ReadingRecordView,
  RestoreResult,
  StatsView,
} from "./types";

/** M6 记录页时间线：`reading_record JOIN article`，按 `last_read_at` 倒序 */
export function getReadingRecords(): Promise<ReadingRecordView[]> {
  return invoke<ReadingRecordView[]>("get_reading_records");
}

/** M6 统计卡：六项数字 + 连续天数（`today` 传本地日期 `YYYY-MM-DD`） */
export function getStats(today: string): Promise<StatsView> {
  return invoke<StatsView>("get_stats", { today });
}

/** M6 阅读进度埋点：进入传 `("", 0)`，离开传当前位置与停留秒数（后端累加） */
export function touchReading(articleId: number, position: string, seconds: number): Promise<void> {
  return invoke<void>("touch_reading", { articleId, position, seconds });
}

/** M6 生词导出为自包含 HTML（省略 outPath 时写库同级 exports/） */
export function exportVocabHtml(outPath?: string): Promise<ExportResult> {
  return invoke<ExportResult>("export_vocab_html", { outPath });
}

/** M6 第四轮：生词导出为 **PDF 词表 HTML**（返回完整 HTML；前端用隐藏 iframe 触发系统打印） */
export function exportVocabSheet(
  mode: "a4" | "zh" | "en",
  shuffle: boolean,
  withAnswer = true,
): Promise<string> {
  return invoke<string>("export_vocab_sheet", { mode, shuffle, withAnswer });
}

/** M6 备份本地库（省略 outDir 时写库同级 exports/backups/） */
export function backupDb(outDir?: string, stamp?: string): Promise<BackupResult> {
  return invoke<BackupResult>("backup_db", { outDir, stamp });
}

/** M6 恢复本地库（先自动备份当前库；坏文件不破坏现库） */
export function restoreDb(srcPath: string, preDir?: string, stamp?: string): Promise<RestoreResult> {
  return invoke<RestoreResult>("restore_db", { srcPath, preDir, stamp });
}

export function ping(): Promise<PingResult> {
  return invoke<PingResult>("ping");
}

/** 读 app_setting 全量键值（docs C3 §5.8） */
export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/** 写单个设置键（docs C3 §5.8：只允许 review_intervals / guide_shown / theme） */
export function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}

/**
 * 启动错误通道（AC1 第 5 个命令）：成功启动返回 null。
 * **不依赖 Db**（O3）——库打不开时这条仍要能答，错误页才显示得出来。
 */
export function getStartupError(): Promise<StartupErrorInfo | null> {
  return invoke<StartupErrorInfo | null>("get_startup_error");
}

/** 文章库列表（四类筛选 AND、同组多选 OR、标题模糊搜索） */
export function listArticles(filter: ArticleFilter = {}): Promise<ArticleSummary[]> {
  return invoke<ArticleSummary[]>("list_articles", { filter });
}

/** 文章库筛选器选项（来源选项 = DISTINCT source） */
export function listArticleFilterOptions(): Promise<FilterOptions> {
  return invoke<FilterOptions>("list_article_filter_options");
}

/** 精读页载荷（段落/句子/词 + 空格号 + 题目） */
export function getArticleContent(articleId: number): Promise<ArticleContent> {
  return invoke<ArticleContent>("get_article_content", { articleId });
}

/** 手动触发一次内置内容包导入（正常路径由启动流程自动跑） */
export function importContentPack(): Promise<ImportReport> {
  return invoke<ImportReport>("import_content_pack");
}

// ───────────────── M2 · 解析 / 词卡 / 空格 / 笔记（8 个命令各一层，不造统一包装层） ─────────────────

/** 句子的六段式解析（查不到返回 null → 组件走「本段暂无解析」降级） */
export function getSentenceAnalysis(sentenceId: number): Promise<SentenceAnalysis | null> {
  return invoke<SentenceAnalysis | null>("get_sentence_analysis", { sentenceId });
}

/** 词的语境解析（查不到返回 null） */
export function getTokenAnalysis(tokenId: number): Promise<TokenAnalysis | null> {
  return invoke<TokenAnalysis | null>("get_token_analysis", { tokenId });
}

/** 全局词库按 `normalized` 主键查询（查不到返回 null） */
export function lookupLexicon(normalized: string): Promise<LexiconEntry | null> {
  return invoke<LexiconEntry | null>("lookup_lexicon", { normalized });
}

/** 选词填空逐空解析（查不到返回 null） */
export function getBlankAnalysis(articleId: number, blankNo: number): Promise<BlankAnalysis | null> {
  return invoke<BlankAnalysis | null>("get_blank_analysis", { articleId, blankNo });
}

/** 句子笔记（未写过返回 null） */
export function getSentenceNote(sentenceId: number): Promise<SentenceNote | null> {
  return invoke<SentenceNote | null>("get_sentence_note", { sentenceId });
}

/** 词笔记（未写过返回 null） */
export function getWordNote(tokenId: number): Promise<WordNote | null> {
  return invoke<WordNote | null>("get_word_note", { tokenId });
}

/**
 * 本篇笔记标记（TP-修复1 F4 / AC-R3）：一次 IPC 拿到本篇有笔记的 `sentenceIds` / `tokenIds`。
 * 正文层用它给句角标与词节点打标记；**不要**改成逐句 `getSentenceNote`（274 句 = 数百次 IPC）。
 */
export function getArticleNoteMarks(articleId: number): Promise<NoteMarks> {
  return invoke<NoteMarks>("get_article_note_marks", { articleId });
}

/** 句子笔记 upsert：三栏 TRIM 后全空 → 删除该行（`deleted=true`） */
export function upsertSentenceNote(
  sentenceId: number,
  translation: string,
  grammarNote: string,
  phraseNote: string,
): Promise<NoteUpsertResult> {
  return invoke<NoteUpsertResult>("upsert_sentence_note", { sentenceId, translation, grammarNote, phraseNote });
}

/** 词笔记 upsert：三栏 TRIM 后全空 → 删除该行 */
export function upsertWordNote(
  tokenId: number,
  contextMeaning: string,
  collocation: string,
  example: string,
): Promise<NoteUpsertResult> {
  return invoke<NoteUpsertResult>("upsert_word_note", { tokenId, contextMeaning, collocation, example });
}

// ───────────────── M3 · 生词本（8 个命令各一层） ─────────────────

/**
 * 生词列表：**平铺行 + tagNames**（一次 IPC 取全，不逐条查）。
 * `groupBy` / `filter` 只是契约占位——三轴分组与筛选的唯一实现在 `lib/vocab.ts`（AC3 的断言在那里），
 * 传了也不会在 Rust 侧再筛一遍（避免两处规则漂移）。
 */
export function listVocab(groupBy?: VocabGroupBy, filter?: VocabFilter): Promise<VocabList> {
  return invoke<VocabList>("list_vocab", { groupBy: groupBy ?? null, filter: filter ?? null });
}

/** 从词节点收藏：同词已在生词本时 `created=false` 且**不改任何列**（保留首次来源与语境义） */
export function addVocabFromToken(tokenId: number): Promise<VocabAddResult> {
  return invoke<VocabAddResult>("add_vocab_from_token", { tokenId });
}

/** 编辑生词：只能改语境义/音标/词性/掌握状态四列；`null` = 清空该字段 */
export function updateVocab(vocabId: number, patch: VocabPatch): Promise<VocabEntry> {
  return invoke<VocabEntry>("update_vocab", { vocabId, patch });
}

/** 移出生词本（标签关联连带清，标签本身保留）；返回是否真的删掉了 */
export function deleteVocab(vocabId: number): Promise<boolean> {
  return invoke<boolean>("delete_vocab", { vocabId });
}

/** 按 `normalized` 查词（词卡判断「已在生词本」；查不到返回 null） */
export function getVocabByNormalized(normalized: string): Promise<VocabEntry | null> {
  return invoke<VocabEntry | null>("get_vocab_by_normalized", { normalized });
}

/** 全部标签（按名升序） */
export function listTags(): Promise<Tag[]> {
  return invoke<Tag[]>("list_tags");
}

/** 全量替换某词的标签（传进来的名单就是最终名单），返回替换后的标签 */
export function setVocabTags(vocabId: number, tagNames: string[]): Promise<Tag[]> {
  return invoke<Tag[]>("set_vocab_tags", { vocabId, tagNames });
}

/** 删标签（连带解除关联，生词条目保留）；返回是否真的删掉了 */
export function deleteTag(tagId: number): Promise<boolean> {
  return invoke<boolean>("delete_tag", { tagId });
}

// ──────────────── M4 · 复习（7 个封装；`today` 一律由调用方按本地日期 YYYY-MM-DD 传入） ────────────────

/** 标记本篇完成：建计划（若无）+ 写 reading_record.completed；**幂等**（已有计划原样返回） */
export function markArticleCompleted(articleId: number, today: string): Promise<ReviewPlan> {
  return invoke<ReviewPlan>("mark_article_completed", { articleId, today });
}

/** 今日到期（active 且 nextReviewAt <= today，按到期日升序）；0 篇返回空数组 */
export function getDueReviews(today: string): Promise<DueReview[]> {
  return invoke<DueReview[]>("get_due_reviews", { today });
}

/** 单篇计划（没建过计划返回 null） */
export function getReviewPlan(articleId: number): Promise<ReviewPlan | null> {
  return invoke<ReviewPlan | null>("get_review_plan", { articleId });
}

/** 完成复习 / 还需再看：顺延计划 + 记一行日志；plan 不存在时 reject code=REVIEW_PLAN_MISSING */
export function completeReview(articleId: number, result: ReviewResult, today: string): Promise<ReviewPlan> {
  return invoke<ReviewPlan>("complete_review", { articleId, result, today });
}

/** 手动重启计划：回到四档起点（active / index 0 / 明天） */
export function restartReviewPlan(articleId: number, today: string): Promise<ReviewPlan> {
  return invoke<ReviewPlan>("restart_review_plan", { articleId, today });
}

/** 复习日志（给 articleId 只看那篇；按 reviewedAt 降序） */
export function listReviewLogs(articleId?: number): Promise<ReviewLog[]> {
  return invoke<ReviewLog[]>("list_review_logs", { articleId });
}

/** **全部**计划（含 status='done'）——「已完成」区与「重新加入复习」的数据源 */
export function listReviewPlans(): Promise<ReviewPlan[]> {
  return invoke<ReviewPlan[]>("list_review_plans");
}

/**
 * 最近读过的一篇（TP-修复5 / M4-U3）：`reading_record` 按 `last_read_at DESC` 取 1 条。
 * 无记录返回 `null` —— 今日页据此**不渲染**「继续精读」栏（而不是渲染一个空卡片）。
 * 只读命令，不碰 `last_position` / `duration_sec`（位置恢复归 M6）。
 */
export function getLastReadArticle(): Promise<LastReadArticle | null> {
  return invoke<LastReadArticle | null>("get_last_read_article");
}

// ───────────────── M5 · 用户导入（两阶段：预览 → 提交；D3 只加 2 个封装，不开第三层） ─────────────────

/**
 * 两阶段①：粘贴文本 → 预览（清洗/分段/切句/分词 + stats）。**不写库**。
 *
 * 超 20000 字 → reject `IMPORT_TOO_LARGE`；`title` 空串等价于未给（走后端三级回退）。
 * 返回的 `ImportPreview` 原样回传给 `commitImport` —— **不要**在前端重算偏移或 stats。
 */
export function parseImportPreview(text: string, title?: string): Promise<ImportPreview> {
  return invoke<ImportPreview>("parse_import_preview", { text, title });
}

/**
 * 两阶段②：预览（用户可剔段/改标题后回传）→ 四层校验 → 单事务入库 → 新文章。
 *
 * 失败码（任一失败库中零写入、整体回滚）：`IMPORT_L1_STRUCTURE` / `IMPORT_L2_OFFSET` /
 * `IMPORT_L3_COVERAGE` / `IMPORT_L4_BUSINESS` / `IMPORT_TOO_LARGE` / `IMPORT_DUPLICATE_SOURCE`。
 * 每次提交都生成新的 `source-<hex>` → 同一篇再导一次是**两篇**，不是覆盖（AC7）。
 */
export function commitImport(preview: ImportPreview, meta: ImportMeta = {}): Promise<ImportCommitResult> {
  return invoke<ImportCommitResult>("commit_import", { preview, meta });
}

// ───────────────── M5b · AI 解析导入（6 个封装；命令名由 05 §十一之二 冻结，不得改名/合并） ─────────────────

/**
 * ① 生成提示词模板 + 本批句子清单 + 题型片段。**纯字符串、不写库**。
 *
 * `batchSize` 只是模板里的分批建议（默认 15），**不是拒收阈值**：
 * 句数 > 15 时后端仍返回全文清单，只在 `batchHint` 里提示「建议分批」（AC2）。
 */
export function buildAiPrompt(draft: AiDraft, batchSize = 15): Promise<AiPrompt> {
  return invoke<AiPrompt>("build_ai_prompt", { draft, batchSize });
}

/**
 * ② 容错解析：剥 ``` 围栏、只取最外层 `{}`、丢掉前后说明文字（丢弃字数在 `ignoredChars`）。
 *
 * 失败码：`AI_PAYLOAD_INVALID`（不是合法 JSON）/ `AI_TYPE_MISMATCH`（`section` 不在枚举内）/
 * `AI_MARKUP_UNBALANCED`（某句 `structMarkup` 不配平）。
 */
export function parseAiPayload(text: string): Promise<AiParseResult> {
  return invoke<AiParseResult>("parse_ai_payload", { text });
}

/**
 * ③ 按 `quote` 对齐句子 → `matched` / `unmatched` / 四类覆盖率。**纯函数、不写库**。
 *
 * 部分不匹配不是错误（`unmatched` 交给用户处置）；一句都没命中才 reject `AI_NO_MATCH`。
 * 形态错误（AC7 六种）在这里被拒：`AI_TYPE_MISMATCH`。
 */
export function matchAiPayload(draft: AiDraft, payload: AiPayload): Promise<AiMatched> {
  return invoke<AiMatched>("match_ai_payload", { draft, payload });
}

/**
 * ③-b 只读题型推断（M5c 优化轮 AC1）：这份 payload **看起来**是哪种题型。
 *
 * `null` ＝ 结构上不敢猜（无题 / 选项数既非 4 也非 15 / 空选项但答案不是单字母）。
 * 只在 `match_ai_payload` 判 `AI_TYPE_MISMATCH` 之后调用，**只用于显示建议**：
 * 切不切由用户点按钮决定（禁止自动猜并静默切换）。
 */
export function suggestSection(payload: AiPayload): Promise<AiSectionSuggestion> {
  return invoke<AiSectionSuggestion>("suggest_section", { payload });
}

/** ④ 首次导入：结构四表 + 解析四表一起入库（失败整篇回滚），返回新文章与覆盖率 */
export function commitAiImport(
  draft: AiDraft,
  matched: AiMatched,
  meta: AiCommitMeta = {},
): Promise<AiCommitReport> {
  return invoke<AiCommitReport>("commit_ai_import", { draft, matched, meta });
}

/**
 * ⑤ 后补解析：只写解析四表，**不动** `paragraph`/`sentence`/`token`（笔记与生词引用不失效）
 *
 * 第三参 `draft` 可选（M5c 回退兼容）：M5b 版导入页只传 `matched`，后端收到 `None`
 * 时跳过 `answer_source` 写入与档 C 逐字比对（列保持默认 `'none'`），其余行为不变。
 */
export function patchAiAnalysis(
  articleId: number,
  matched: AiMatched,
  draft?: AiDraft,
): Promise<AiPatchReport> {
  const args: Record<string, unknown> = { articleId, matched };
  if (draft) args.draft = draft;
  return invoke<AiPatchReport>("patch_ai_analysis", args);
}

/** ⑥ 覆盖率回读（补解析入口的初值不是 0） */
export function getAiImportStats(articleId: number): Promise<AiImportStats> {
  return invoke<AiImportStats>("get_ai_import_stats", { articleId });
}

// ───────── M5c · 导入重做（4 个封装：切分 / 编辑元信息 / 读题目 / 换题目） ─────────

/** ⑦ 一次粘贴「原文 + 题目 + 答案」→ 自动切分（纯函数，不写库；切不中时 `detected=false`） */
export function splitUserInput(raw: string): Promise<UserInputSplit> {
  return invoke<UserInputSplit>("split_user_input", { raw });
}

/** 整卷多篇切分（D-M5c-2）：纯函数，不读写库；单篇返回 1 个元素、空输入返回空数组 */
export function splitPassages(raw: string): Promise<PassageSpan[]> {
  return invoke<PassageSpan[]>("split_passages", { raw });
}

/** ⑧ 改元信息（只改 article 行；原文三表不动） */
export function updateArticleMeta(articleId: number, patch: ArticleMetaPatch): Promise<void> {
  return invoke<void>("update_article_meta", { articleId, patch });
}

/** ⑨ 读该篇题目（编辑面板初值） */
export function getArticleQuestions(articleId: number): Promise<QuestionView[]> {
  return invoke<QuestionView[]>("get_article_questions", { articleId });
}

/** ⑩ 整批替换该篇题目（只写 question 表；`answerSource` 原样保留） */
export function replaceArticleQuestions(articleId: number, questions: QuestionView[]): Promise<QuestionView[]> {
  return invoke<QuestionView[]>("replace_article_questions", { articleId, questions });
}

// ───────────────── M7 · 发布链路（1 个封装：更新检查，离线优先） ─────────────────

/**
 * 检查更新：**永不 reject**——后端把一切失败降级成 `available:false` + `reason`
 * （`up-to-date` / `no-manifest` / `offline`），设置页只按文案降级，不弹技术错误（AC7）。
 *
 * 本包为离线优先实现（读应用数据目录下的 `latest.json`）；联网检查归 M7 后续（见 README）。
 */
export function checkUpdate(): Promise<UpdateResult> {
  return invoke<UpdateResult>("check_update");
}