// 共享类型：前端页面、纯函数与后端命令的契约（纯类型，无运行时副作用）。

export interface ArticleSummary {
  sourceKey: string;
  /** 套号（AC1 三套分组用；02 §三 D4 字段清单未列，但分组必需，见自测说明） */
  setNo: number;
  title: string;
  examYear: number;
  examMonth: number;
  section: string;
  wordCount: number;
  sentenceCount: number;
}

export interface ParagraphDto {
  idx: number;
  text: string;
}

export interface SentenceDto {
  paraIdx: number;
  idx: number;
  start: number;
  end: number;
  text: string;
}

export interface TokenDto {
  paraIdx: number;
  sentIdx: number;
  idx: number;
  start: number;
  end: number;
  surface: string;
  normalized: string | null;
  isWord: boolean;
}

export interface ArticleContent {
  article: ArticleSummary;
  paragraphs: ParagraphDto[];
  sentences: SentenceDto[];
  tokens: TokenDto[];
  blankNos: number[];
}

export interface ImportReport {
  imported: number;
  updated: number;
  skipped: number;
  packVersion: string;
  elapsedMs: number;
  dbRebuilt: string | null;
}

/** 后端 StartupError 的序列化形状（serde tag="kind"）。 */
export type StartupError =
  | { kind: 'packMissing'; file: string }
  | { kind: 'packCorrupt'; file: string; detail: string }
  | { kind: 'packInvalid'; file: string; detail: string }
  | { kind: 'db'; message: string };

/** renderTokens 输出的节点：text / word / blank 三类。 */
export interface TokenNode {
  type: 'text' | 'word' | 'blank';
  text: string;
  /** 单词节点：normalized（data-n） */
  n?: string;
  /** 单词与空格节点：句内字符偏移（data-start） */
  start?: number;
  /** 空格节点：空号（data-blank-no） */
  blankNo?: number;
}
