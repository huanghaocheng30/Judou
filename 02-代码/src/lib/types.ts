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
