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
  AppSettings,
  ArticleContent,
  ArticleFilter,
  ArticleSummary,
  BlankAnalysis,
  FilterOptions,
  ImportReport,
  LexiconEntry,
  NoteMarks,
  NoteUpsertResult,
  PingResult,
  SentenceAnalysis,
  SentenceNote,
  StartupErrorInfo,
  TokenAnalysis,
  VocabAddResult,
  VocabEntry,
  VocabList,
  VocabPatch,
  Tag,
  WordNote,
} from "./types";
import type { VocabFilter, VocabGroupBy } from "./vocab";

/** 连通性探针：返回 pong 与 Cargo 包版本 */
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
