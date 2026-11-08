/**
 * 导入页（M5 快速导入 + M5b AI 解析导入，02 v1.2a D3）。
 *
 * 双 Tab（`data-import-mode`）：
 *   - **快速导入**（M5，原样不动）：粘文本 → 预览 → 剔段/改标题 → 确认导入 → 跳精读
 *   - **AI 解析导入**（M5b）：选题型 → 粘原文（App 切段/切句/分词）→ 复制提示词给用户自己的 AI
 *     → 粘回 JSON → 覆盖率与未匹配清单 → 确认入库
 *
 * 红线（02 §四）：
 *   1. **校验与写库只有一份实现**（Rust `ai_import.rs`）。本文件不做形态校验、不改偏移、
 *      不猜句对齐——它只渲染和累积状态。
 *   2. App 管结构：段/句/词/偏移由 `parse_import_preview` 算一次；AI payload 里的数字一律不采信。
 *   3. 切 Tab 时 AI 中间态清空（AI 组件卸载即清空）；快速导入的既有 state **不进 `hidden` 之外的重构**。
 *   4. 允许不完整：解析/题目/逐空/词条任一缺失都能入库，覆盖率四类独立显示。
 *
 * ponytail: 多次粘贴的「累加」在前端按 (段,句) / 题号 / 空号 / 词条 去重合并（后者覆盖前者），
 * 再原样交给后端写库——后端不做跨调用状态（它每次只写传进来的那一份）。
 * 升级路径：若将来要「服务端权威累加」，把 merge 搬到 `match_ai_payload` 里加一个「已入库快照」入参即可。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildAiPrompt,
  commitAiImport,
  commitImport,
  getAiImportStats,
  getArticleContent,
  matchAiPayload,
  parseAiPayload,
  parseImportPreview,
  patchAiAnalysis,
  splitPassages,
  suggestSection,
} from "../lib/api";
import type {
  AiImportStats,
  AiMatched,
  AiPayload,
  AiPrompt,
  AiSection,
  AiSectionSuggestion,
  AiUnmatchedSentence,
  ArticleContent,
  ImportParagraph,
  ImportPreview,
  ImportStats,
  PassageSpan,
} from "../lib/types";

/** 题型选项（`exam_type` 枚举只有这三个，见 001_init.sql 的 CHECK） */
const EXAM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "other", label: "其他" },
  { value: "cet4", label: "CET-4" },
  { value: "cet6", label: "CET-6" },
];

/** 正文上限（与 Rust 侧 `MAX_BODY_CHARS` 一致，仅用于前端提示，真正的闸在后端） */
const MAX_BODY_CHARS = 20_000;

/**
 * 错误码 → 可操作提示（AC11）。键是 Rust `ImportCode` 的六个码；未登记的错误走后端 message。
 * 提示写「用户下一步做什么」，不写内部原因（L2 的真实成因是偏移错位，但用户能做的只有重新粘贴）。
 */
const ERROR_HINTS: Record<string, string> = {
  IMPORT_L1_STRUCTURE: "预览结构不完整（有段落或句子是空的），请把正文整理干净后重新解析。",
  IMPORT_L2_OFFSET: "文本含不可见字符，请重新粘贴",
  IMPORT_L3_COVERAGE: "分词没有覆盖全文（可能混入了异常符号），请检查正文后重新粘贴。",
  IMPORT_L4_BUSINESS: "正文太短或含不可见控制字符：至少 10 个单词，且不含制表符以外的控制字符。",
  IMPORT_TOO_LARGE: "正文超过 2 万字符，请分段导入",
  IMPORT_DUPLICATE_SOURCE: "这篇已导入过",
};

/** AI 解析导入的四个错误码（02 §五）+ 句子级的「跳过该句」提示 */
const AI_ERROR_HINTS: Record<string, string> = {
  AI_PAYLOAD_INVALID: "粘贴内容不是合法 JSON。请确认复制了完整的 { … } 块，且没有漏掉结尾的 }",
  AI_TYPE_MISMATCH: "题型或题目形态对不上：请确认模板选的题型与 AI 产物里的 section 一致，且选项数符合题型要求。",
  AI_MARKUP_UNBALANCED: "某句的结构标记不配平。可以点『跳过该句』继续导入。",
  AI_NO_MATCH: "粘贴的解析与当前文章完全不匹配：请确认复制的是这篇文章的模板产物。",
};

interface ImportError {
  /** 后端错误码；本地预检（如「一段都没留」）没有码，为 null */
  code: string | null;
  /** 展示文案 = 错误码对应提示；无提示时退回后端 message */
  hint: string;
  /** 后端给的定位（如 `sentences[11].analysis.structMarkup`） */
  path?: string | null;
  /**
   * M5c 优化轮 AC2：`AI_TYPE_MISMATCH` 时后端按 payload 结构推断出的题型建议。
   * 只有「推断出 ≠ 当前所选」才带上；带上了也**只是建议**——切换必须用户点按钮。
   */
  suggestion?: AiSectionSuggestion;
}

/** Tauri 拒绝值是 `CommandError {code,message,path}` 对象，不是 `Error` 实例 */
function readError(err: unknown, hints: Record<string, string> = ERROR_HINTS): ImportError {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    const path = (err as { path?: unknown }).path;
    const codeText = typeof code === "string" && code.trim() !== "" ? code : null;
    const messageText = typeof message === "string" ? message : "";
    return {
      code: codeText,
      hint: (codeText && hints[codeText]) || messageText || "操作失败，请重试。",
      path: typeof path === "string" ? path : null,
    };
  }
  return { code: null, hint: err instanceof Error ? err.message : String(err) };
}

/**
 * 剔除若干段后重算统计。
 *
 * 为什么必须重算：`commit_import` 直接拿 `preview.stats` 写 `article.sentence_count/word_count`
 * （AC7/B-3'：文章库卡片读它），而 L4 也用它判「句数 ≥1、词数 ≥10」。
 * 剔段后还回传旧 stats，库里就会记成剔除前的数字——这是数据错误，不是显示问题。
 * 注意这里只做**聚合计数**，不碰任何偏移（偏移由 Rust 产出，前端不得重算）。
 */
function statsOf(paragraphs: ImportParagraph[]): ImportStats {
  let sentenceCount = 0;
  let tokenCount = 0;
  let wordCount = 0;
  for (const paragraph of paragraphs) {
    sentenceCount += paragraph.sentences.length;
    for (const sentence of paragraph.sentences) {
      tokenCount += sentence.tokens.length;
      wordCount += sentence.tokens.filter((token) => token.isWord).length;
    }
  }
  return { paragraphCount: paragraphs.length, sentenceCount, tokenCount, wordCount };
}

// ───────────────────────── M5b · AI 解析导入 ─────────────────────────

/** 题型三选一（A4：用户明确指定，不自动猜） */
const SECTION_OPTIONS: Array<{ value: AiSection; label: string }> = [
  { value: "careful", label: "仔细阅读" },
  { value: "long", label: "长篇阅读" },
  { value: "cloze", label: "选词填空" },
];

/** 上次选题型的记忆键（A4：「记住上次选择」） */
const LAST_SECTION_KEY = "judou.aiImport.section";
/** 模板建议批大小（15 是建议值，不是硬上限，见 02 §三.7） */
const AI_BATCH_SIZE = 15;

function isAiSection(value: string | null | undefined): value is AiSection {
  return value === "careful" || value === "long" || value === "cloze";
}

function readLastSection(): AiSection | "" {
  try {
    const saved = localStorage.getItem(LAST_SECTION_KEY);
    return isAiSection(saved) ? saved : "";
  } catch {
    return "";
  }
}

function rememberSection(section: AiSection): void {
  try {
    localStorage.setItem(LAST_SECTION_KEY, section);
  } catch {
    // localStorage 不可用（隐私模式）：不记也行，只是下次要重选
  }
}

/** 题型中文标签（建议文案与按钮文案共用一份映射，避免两处各写一遍） */
function sectionLabel(section: AiSection): string {
  return SECTION_OPTIONS.find((option) => option.value === section)?.label ?? section;
}

/**
 * M5c 优化轮 AC2：`AI_TYPE_MISMATCH` 之后补一条「可执行的下一步」。
 *
 * 只有「后端推断出题型」且「与当前所选不同」时才带建议；`null`（不敢猜）或与当前所选
 * 相同时**原样退回**——此时错的不是题型，给建议只会误导用户改错方向。
 * 建议只进显示层：切不切由用户点 `data-section-suggest` 决定，本函数不切换、不重试。
 */
async function withSectionSuggestion(
  base: ImportError,
  payload: AiPayload | null,
  current: AiSection,
): Promise<ImportError> {
  if (base.code !== "AI_TYPE_MISMATCH" || !payload) return base;
  try {
    const suggested = await suggestSection(payload);
    if (!suggested || suggested === current) return base;
    return { ...base, suggestion: suggested };
  } catch {
    // 建议是锦上添花：推断失败不得掩盖真实错误，也不得阻断用户后续操作
    return base;
  }
}

/** 句子清单里每句原文展示的字符数（与 Rust `SENTENCE_PREVIEW_CHARS` 同口径） */
function sentencePreview(text: string): string {
  const chars = [...text];
  return chars.length <= 24 ? text : `${chars.slice(0, 24).join("")}…`;
}

/**
 * 取粘贴内容里最外层 `{ … }`（**只为「跳过该句」做文本外科手术**，不做任何校验）。
 *
 * 校验与解析的唯一实现在后端 `ai_import.rs`：这里拿不到 payload，是因为 markup 错误让后端
 * 整包拒收（AC6），而 AC6 还要求「用户选『跳过该句』后可入库」——所以前端把用户粘贴的那一段里
 * 出问题的句子删掉，再交回后端重跑。括号扫描与后端同口径（跳过字符串字面量里的花括号）。
 */
function outerJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** 合并两次粘贴的结果：同一句/同一题/同一空/同一词条以**后到者**为准（02 §三.7③） */
function mergeMatched(prev: AiMatched | null, next: AiMatched): AiMatched {
  if (!prev) return next;
  const sentenceKey = (item: { paragraphIdx: number; sentenceIdx: number }) => `${item.paragraphIdx}:${item.sentenceIdx}`;
  const matched = new Map(prev.matched.map((item) => [sentenceKey(item), item]));
  for (const item of next.matched) matched.set(sentenceKey(item), item);
  // 题目按**试卷题号** `no` 合并/排序：`idx` 只是批内槽位（后端写库的是 `no`，见 ai_import.rs）
  const questions = new Map(prev.questions.map((item) => [item.no, item]));
  for (const item of next.questions) questions.set(item.no, item);
  const blanks = new Map(prev.blanks.map((item) => [item.no, item]));
  for (const item of next.blanks) blanks.set(item.no, item);
  const lexicon = new Map(prev.lexicon.map((item) => [item.word.toLowerCase(), item]));
  for (const item of next.lexicon) lexicon.set(item.word.toLowerCase(), item);
  return {
    section: next.section,
    matched: [...matched.values()].sort((a, b) =>
      a.paragraphIdx === b.paragraphIdx ? a.sentenceIdx - b.sentenceIdx : a.paragraphIdx - b.paragraphIdx,
    ),
    unmatched: next.unmatched,
    unmatchedLexicon: next.unmatchedLexicon,
    questions: [...questions.values()].sort((a, b) => a.no - b.no),
    blanks: [...blanks.values()].sort((a, b) => a.no - b.no),
    lexicon: [...lexicon.values()],
    coverage: next.coverage,
    snoFixed: prev.snoFixed + next.snoFixed,
    missingAnswer: prev.missingAnswer + next.missingAnswer,
  };
}

interface AiImportProps {
  /** 有值 = 补解析（patch）模式：原文从文章库回读，终点命令是 `patch_ai_analysis` */
  articleId?: number;
  /** 入库/补解析成功后跳转（默认跳精读页） */
  onImported: (articleId: number) => void;
}

/**
 * `get_article_content` → `ImportPreview`（02 §四.3 的 `toImportPreview()`）。
 *
 * **零新增命令**：精读页载荷已经带段/句/词与偏移（UTF-16），这里只换字段名。
 * 偏移与 `idx` 一律原样搬运——前端不得重算（重算就等于第二套切句/分词实现）。
 */
function toImportPreview(content: ArticleContent): ImportPreview {
  const paragraphs: ImportParagraph[] = content.paragraphs.map((paragraph) => ({
    idx: paragraph.idx,
    text: paragraph.text,
    sentences: paragraph.sentences.map((sentence) => ({
      idx: sentence.idx,
      start: sentence.start,
      end: sentence.end,
      text: sentence.text,
      tokens: sentence.tokens.map((token) => ({
        start: token.start,
        end: token.end,
        surface: token.surface,
        normalized: token.isWord ? token.normalized : null,
        isWord: token.isWord,
      })),
    })),
  }));
  return { title: content.article.title, paragraphs, stats: statsOf(paragraphs) };
}

/** 从 `#/import?articleId=<id>` 里取补解析目标（只看查询串，判定口径见 §四.2） */
function readPatchArticleId(): number | undefined {
  const raw = window.location.hash;
  const mark = raw.indexOf("?");
  if (mark < 0) return undefined;
  const value = Number(new URLSearchParams(raw.slice(mark + 1)).get("articleId"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function AiImport({ articleId, onImported }: AiImportProps) {
  const patchMode = articleId !== undefined;
  const [section, setSection] = useState<AiSection | "">(() => readLastSection());
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [prompt, setPrompt] = useState<AiPrompt | null>(null);
  const [payloadText, setPayloadText] = useState("");
  const [merged, setMerged] = useState<AiMatched | null>(null);
  const [stats, setStats] = useState<AiImportStats | null>(null);
  const [ignoredChars, setIgnoredChars] = useState(0);
  const [batchHint, setBatchHint] = useState<string | null>(null);
  const [regenText, setRegenText] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [copied, setCopied] = useState<"prompt" | "regen" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [busy, setBusy] = useState<"parse" | "match" | "commit" | "load" | null>(null);

  // ── D-M5c-2 整卷多篇（最小版）：只做「检测 + 逐篇走」，不做并行导入/批量事务 ──
  /** 整卷原文：只在多篇模式下与 `text` 不同（`text` 变成「当前这一篇」的切片） */
  const [volume, setVolume] = useState("");
  const [passageSpans, setPassageSpans] = useState<PassageSpan[]>([]);
  const [passageIndex, setPassageIndex] = useState(0);
  const [donePassages, setDonePassages] = useState<number[]>([]);

  const chars = text.length;
  const overLimit = chars > MAX_BODY_CHARS;

  /** 句子清单（`S编号` + 原文前 24 字符 + 段/句位置） */
  const sentenceList = useMemo(() => {
    if (!preview) return [];
    const rows: Array<{ ordinal: number; paragraphIdx: number; sentenceIdx: number; text: string }> = [];
    for (const paragraph of preview.paragraphs) {
      for (const sentence of paragraph.sentences) {
        rows.push({
          ordinal: rows.length + 1,
          paragraphIdx: paragraph.idx,
          sentenceIdx: sentence.idx,
          text: sentence.text,
        });
      }
    }
    return rows;
  }, [preview]);

  /** 选题型 → 记住上次；有预览则顺手重新生成模板（片段随题型变） */
  const chooseSection = (value: string) => {
    if (!isAiSection(value)) {
      setSection("");
      return;
    }
    setSection(value);
    rememberSection(value);
    setPrompt(null);
  };

  /**
   * 把整卷的第 `index` 篇装进「原文」框并清掉上一篇的中间态（匹配/跳过/提示词都不再适用）。
   *
   * `source` 显式传入而不是读 `text`：自动装载发生在检测回调里，那时 `setText(整卷)` 可能还没生效。
   * 逐篇**不改题型选择**（AC2：题型保留用户上次选择）。
   */
  const applyPassage = useCallback((source: string, spans: PassageSpan[], index: number) => {
    const span = spans[index];
    if (!span) return;
    const lines = source.split(/\r?\n/);
    setVolume(source);
    setText(lines.slice(span.startLine - 1, span.endLine).join("\n"));
    setPassageSpans(spans);
    setPassageIndex(index);
    setPreview(null);
    setPrompt(null);
    setMerged(null);
    setSkipped([]);
    setRegenText("");
    setIgnoredChars(0);
  }, []);

  /**
   * 粘贴后自动检测分篇（防抖 300ms）。**只有多篇才切**：单篇时 `passageSpans.length <= 1`，
   * 界面不渲染篇列表（AC1），`text` 原样留给单篇流程。
   */
  useEffect(() => {
    if (volume !== "") return; // 已进入多篇模式：`text` 只是当前这一篇，不再重新分篇
    const raw = text;
    if (raw.trim() === "") {
      setPassageSpans([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      splitPassages(raw)
        .then((spans) => {
          if (cancelled) return;
          if (spans.length > 1) applyPassage(raw, spans, 0); // AC2：默认第 1 篇
          else setPassageSpans(spans);
        })
        .catch(() => {
          if (!cancelled) setPassageSpans([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, volume, applyPassage]);

  /** 用户在原文框里手动改写 = 退出多篇模式（下次粘贴重新检测） */
  const onTextChange = (value: string) => {
    setText(value);
    if (volume !== "") {
      setVolume("");
      setPassageSpans([]);
      setPassageIndex(0);
      setDonePassages([]);
    }
  };

  useEffect(() => {
    if (!preview || !isAiSection(section)) return;
    let cancelled = false;
    buildAiPrompt({ preview, section }, AI_BATCH_SIZE)
      .then((next) => {
        if (cancelled) return;
        setPrompt(next);
        setBatchHint(next.batchHint);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(readError(err, AI_ERROR_HINTS));
      });
    return () => {
      cancelled = true;
    };
  }, [preview, section]);

  async function onParseText() {
    if (!isAiSection(section)) {
      setError({ code: null, hint: "请先选题型（仔细阅读 / 长篇阅读 / 选词填空）。" });
      return;
    }
    setBusy("parse");
    setError(null);
    try {
      const next = await parseImportPreview(text);
      setPreview(next);
      // 新原文 = 新句集合：上一批的匹配结果与跳过清单不再适用
      setMerged(null);
      setIgnoredChars(0);
      setSkipped([]);
      setRegenText("");
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt.text);
      setCopied("prompt");
    } catch {
      // 剪贴板被拒（非安全上下文/权限）：prompt 文本已在只读框里，用户可手动复制
      setCopied(null);
    }
  }

  /**
   * 真正跑一次匹配。`target` 显式传入而不是读 `section` state：
   * 「切换题型并重试」时 `setSection` 还没刷新，读 state 会拿到旧值。
   */
  async function runMatch(target: AiSection) {
    if (!preview) {
      setError({ code: null, hint: "请先解析原文。" });
      return;
    }
    if (payloadText.trim() === "") {
      setError({ code: null, hint: "请把 AI 返回的 JSON 粘到上面的框里。" });
      return;
    }
    setBusy("match");
    setError(null);
    // payload 提到 try 外：判 AI_TYPE_MISMATCH 时要拿它去问「这看起来是哪种题型」
    let payload: AiPayload | null = null;
    try {
      const parsed = await parseAiPayload(payloadText);
      payload = parsed.payload;
      const next = await matchAiPayload({ preview, section: target }, payload);
      setIgnoredChars(parsed.ignoredChars);
      setMerged((prev) => mergeMatched(prev, next));
    } catch (err) {
      setError(await withSectionSuggestion(readError(err, AI_ERROR_HINTS), payload, target));
    } finally {
      setBusy(null);
    }
  }

  async function onMatch() {
    if (!isAiSection(section)) {
      setError({ code: null, hint: "请先选题型并解析原文。" });
      return;
    }
    await runMatch(section);
  }

  /**
   * AC3：点「切换为 X 并重试」→ 切题型 + **自动重新匹配**（用户不必再点一次「解析并匹配」）。
   *
   * 这是**用户显式点**的动作；`suggestion` 只在用户点击后被消费，不存在自动切换路径。
   */
  async function applySectionSuggestion() {
    const next = error?.suggestion;
    if (!next) return;
    setSection(next);
    rememberSection(next);
    setPrompt(null);
    setError(null);
    await runMatch(next);
  }

  /** AC5/AC14①：「跳过」只把这条从待处置清单里去掉（该句照常无解析），不影响其余入库 */
  function skipUnmatched(item: AiUnmatchedSentence) {
    setSkipped((prev) => (prev.includes(item.quote) ? prev : [...prev, item.quote]));
    setMerged((prev) => (prev ? { ...prev, unmatched: prev.unmatched.filter((row) => row.quote !== item.quote) } : prev));
  }

  /**
   * AC14②：「重新生成该句」→ 复制只含该句的单句小模板（含 `S编号` + 原文）。
   * 原文取**声明编号**对应的 App 侧句子（`sNo` 只是辅助，见 AC18）；声明编号缺失/越界时退回 AI 给的 quote。
   */
  function regenerate(item: AiUnmatchedSentence) {
    const declared = item.sNo?.match(/\d+/)?.[0];
    const ordinal = declared ? Number(declared) : NaN;
    const row = Number.isInteger(ordinal) ? sentenceList.find((entry) => entry.ordinal === ordinal) : undefined;
    const quote = row?.text ?? item.quote;
    const sNo = row ? `S${row.ordinal}` : (item.sNo ?? "S?");
    const body = [
      "请只解析下面这一句，仍按之前的 JSON 契约输出（可以只给 sentences 数组）：",
      `{"packVersion":"2026.11.08-1","section":"${section || "careful"}","sentences":[{"sNo":"${sNo}","quote":"${quote}","analysis":{/* 九字段 */}}]}`,
      "",
      `句子编号：${sNo}`,
      `句子原文：${quote}`,
      "",
      "注意：quote 必须与上面原文逐字符一致（含标点、引号、连字符），否则 App 仍然对不上。",
    ].join("\n");
    setRegenText(body);
    navigator.clipboard?.writeText(body).catch(() => {
      // 剪贴板被拒时正文已展示在 data-ai-regen-text，用户可手动复制
    });
    setCopied("regen");
  }

  /**
   * 补解析：进页面即回读原文与题型（02 §四.3）。
   * 原文来自库（`get_article_content`）→ `toImportPreview()`；覆盖率初值取 `get_ai_import_stats` 的真读数（不是 0）。
   * 题型初值取 `article.section_type`；为 NULL 或不在枚举内时**不预选、要求用户选**（不猜）。
   */
  useEffect(() => {
    if (articleId === undefined) return;
    let cancelled = false;
    setBusy("load");
    Promise.all([getArticleContent(articleId), getAiImportStats(articleId)])
      .then(([content, nextStats]) => {
        if (cancelled) return;
        setPreview(toImportPreview(content));
        setStats(nextStats);
        const stored = content.article.sectionType;
        setSection(isAiSection(stored) ? stored : "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(readError(err, AI_ERROR_HINTS));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  /** 累计覆盖率读数（提交/补解析前的工作集；补解析另加库里已有的真读数） */
  const baseline = patchMode ? stats : null;
  const covered = (baseline?.analysisCovered ?? 0) + (merged?.matched.length ?? 0);
  const totalSentences = baseline?.sentences ?? preview?.stats.sentenceCount ?? 0;
  const questionCount = (baseline?.questions ?? 0) + (merged?.questions.length ?? 0);
  // 词条**不加 baseline**：`lexicon` 是全局词库（表里没有 article_id），按篇归因不了；
  // 补解析时的这个数字只表示「本批要写的词条数」，与 commit 模式同口径。
  const lexiconCount = merged?.lexicon.length ?? 0;
  const blankCount = (baseline?.blanks ?? 0) + (merged?.blanks.length ?? 0);
  /**
   * 逐空覆盖率的分母：`coverage.blanks` 为 `k/分母` 时取分母；
   * 无题号区间（cloze 缺 `questions`）时分母未知——按 02 §三.1 **只显示已解析数 `k`**，不编分母。
   */
  const blankTotal = useMemo(() => {
    const raw = merged?.coverage.blanks ?? "-";
    const denominator = raw.includes("/") ? raw.split("/")[1] : "";
    if (denominator) return denominator;
    return merged && merged.questions.length > 0 ? String(merged.questions.length) : "";
  }, [merged]);
  const pendingCount = merged?.matched.length ?? 0;

  /** markup 不配平时的「跳过该句」入口：从错误 path 里取句序号（AC6 的逃生口） */
  const markupSkipIndex = useMemo(() => {
    if (error?.code !== "AI_MARKUP_UNBALANCED") return null;
    const matched = error.path?.match(/^sentences\[(\d+)\]/);
    return matched ? Number(matched[1]) : null;
  }, [error]);

  /** AC6：把出问题的那一句从粘贴内容里删掉后重跑（其余句子照常入库） */
  async function skipUnbalancedSentence() {
    if (markupSkipIndex === null || !preview || !isAiSection(section)) return;
    const slice = outerJsonObject(payloadText);
    if (!slice) {
      setError({ code: null, hint: "没能从粘贴内容里定位 JSON 块，请手动删掉这一句后再试。" });
      return;
    }
    setBusy("match");
    try {
      const parsedJson = JSON.parse(slice) as { sentences?: unknown[] };
      if (!Array.isArray(parsedJson.sentences) || markupSkipIndex >= parsedJson.sentences.length) {
        setError({ code: null, hint: "句子序号越界，请手动删掉这一句后再试。" });
        return;
      }
      parsedJson.sentences.splice(markupSkipIndex, 1);
      const rewritten = JSON.stringify(parsedJson);
      setPayloadText(rewritten);
      setError(null);
      const parsed = await parseAiPayload(rewritten);
      const next = await matchAiPayload({ preview, section }, parsed.payload);
      setIgnoredChars(parsed.ignoredChars);
      setMerged((prev) => mergeMatched(prev, next));
    } catch (err) {
      setError(readError(err, AI_ERROR_HINTS));
    } finally {
      setBusy(null);
    }
  }

  async function onCommit() {
    if (!preview || !isAiSection(section)) {
      setError({ code: null, hint: "请先选题型并解析原文。" });
      return;
    }
    if (!merged || merged.matched.length === 0) {
      setError({ code: null, hint: "还没有任何一句解析能对上原文，先粘回 AI 的 JSON 或检查题型。" });
      return;
    }
    setBusy("commit");
    setError(null);
    setNotice(null);
    try {
      if (articleId !== undefined) {
        // 补解析：只写解析四表（原文结构不动，笔记/生词引用不失效）
        const result = await patchAiAnalysis(articleId, merged);
        const nextStats = await getAiImportStats(articleId);
        setStats(nextStats);
        setMerged(null);
        setPayloadText("");
        setSkipped([]);
        setNotice(
          `已补充解析：本次写入 ${result.analysisWritten} 句解析 / ${result.questionsWritten} 题 / ${result.blanksWritten} 空 / 新增词条 ${result.lexiconInserted}`,
        );
      } else {
        const result = await commitAiImport({ preview, section }, merged, {});
        if (volume !== "") {
          // 整卷多篇：**不跳走**——先给本篇打「已完成」，用户才能接着点「下一篇」（AC2）
          setDonePassages((prev) => (prev.includes(passageIndex) ? prev : [...prev, passageIndex]));
          setMerged(null);
          setPayloadText("");
          setSkipped([]);
          setNotice(`第 ${passageIndex + 1} 篇已入库（文章 #${result.articleId}），点「下一篇」继续。`);
        } else {
          onImported(result.articleId);
        }
      }
    } catch (err) {
      setError(readError(err, AI_ERROR_HINTS));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ai-import" data-ai-panel>
      {/*
        AC4：错误卡片**置顶**（页面最上方、粘回框与各步卡片之上）。
        实测根因之一就是「拒收发生在页面中部，用户看不到，以为点了没反应」——
        位置与视觉强调同时到位，才谈得上「告诉用户怎么办」。
      */}
      {error ? (
        <div className="import-error import-error-strong" role="alert" data-ai-error>
          <span className="import-error-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="import-error-code" data-ai-error-code>
            {error.code ?? "提示"}
          </span>
          <span className="import-error-hint">怎么办：{error.hint}</span>
          {error.suggestion ? (
            <span className="import-error-suggest" data-ai-error-suggest>
              这看起来是「{sectionLabel(error.suggestion)}」
              {isAiSection(section) ? `，你现在选的是「${sectionLabel(section)}」` : ""}。
              <button
                type="button"
                className="btn btn-primary"
                data-section-suggest
                disabled={busy !== null}
                onClick={applySectionSuggestion}
              >
                切换为{sectionLabel(error.suggestion)}并重试
              </button>
            </span>
          ) : null}
          {error.path ? (
            <span className="import-error-path" data-ai-error-path>
              定位：{error.path}
            </span>
          ) : null}
          {markupSkipIndex !== null ? (
            <button type="button" className="btn" data-ai-skip-sentence onClick={skipUnbalancedSentence}>
              跳过该句（第 {markupSkipIndex + 1} 句）
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="card" aria-labelledby="ai-section-title">
        <h2 id="ai-section-title">① 选题型</h2>
        <p className="card-hint">
          题型决定模板片段与形态校验：仔细阅读每题 4 个选项、长篇阅读每题空选项 + 段落字母、选词填空每题 15 项词库。
          选错会被拒收（错误码 AI_TYPE_MISMATCH）。App 只算结构与偏移，语义解析由你自己的 AI 生成。
        </p>
        <label className="import-field">
          <span>题型</span>
          <select data-ai-section value={section} onChange={(event) => chooseSection(event.target.value)}>
            <option value="">请选择题型…</option>
            {SECTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/*
        D-M5c-2 AC1/AC2：整卷多篇。**单篇时整块不渲染**（避免视觉噪音）。
        逐篇走：点「本篇」把该篇原文装进下面的原文框 → 独立选题型/解析/入库 → 入库即标「已完成」。
      */}
      {passageSpans.length > 1 ? (
        <section className="card" aria-labelledby="ai-passage-title" data-passage-count={passageSpans.length}>
          <h2 id="ai-passage-title">检测到 {passageSpans.length} 篇</h2>
          <p className="card-hint">
            整卷按小标题切成 {passageSpans.length} 篇。每篇**独立选题型、独立解析、独立入库**；题型选择沿用你上次的选择（不重置）。
          </p>
          <ol className="ai-passage-list">
            {passageSpans.map((span, i) => (
              <li
                key={span.index}
                className={i === passageIndex ? "ai-passage-item current" : "ai-passage-item"}
                data-passage-item
                data-passage-index={span.index}
                data-passage-start={span.startLine}
                data-passage-end={span.endLine}
              >
                <span className="ai-passage-label">{span.label}</span>
                <span className="ai-hint" data-passage-range>
                  第 {span.startLine}~{span.endLine} 行 · {span.preview}
                </span>
                {donePassages.includes(i) ? (
                  <span className="badge" data-passage-done={i + 1}>
                    已完成
                  </span>
                ) : null}
                <button type="button" className="btn" data-passage-use={i + 1} onClick={() => applyPassage(volume, passageSpans, i)}>
                  {i === passageIndex ? "重新装本篇" : "用本篇"}
                </button>
              </li>
            ))}
          </ol>
          <div className="import-row">
            <span className="import-counter" data-passage-current>
              当前第 {passageIndex + 1} 篇
            </span>
            <button
              type="button"
              className="btn"
              data-passage-next
              disabled={passageIndex + 1 >= passageSpans.length}
              onClick={() => applyPassage(volume, passageSpans, passageIndex + 1)}
            >
              下一篇
            </button>
          </div>
        </section>
      ) : null}

      <section className="card" aria-labelledby="ai-text-title">
        <h2 id="ai-text-title">② 原文</h2>
        {patchMode ? (
          // 补解析：原文来自文章库，**粘原文这一步锁定**（这是 AC9 的前提：结构不变）
          <p className="import-stats" data-ai-loaded data-article-id={articleId}>
            已从文章库载入：{preview?.title ?? "读取中…"} · 段 {preview?.stats.paragraphCount ?? "—"} / 句{" "}
            {preview?.stats.sentenceCount ?? "—"}
            {busy === "load" ? "（读取中…）" : ""}
          </p>
        ) : (
          <>
            <p className="card-hint">一段一行、段间空行。解析只做预览，不写库。</p>
            <textarea
              className="import-textarea"
              data-ai-text
              rows={10}
              spellCheck={false}
              placeholder="在这里粘贴英文正文……"
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
            />
            <div className="import-row">
              <span className={overLimit ? "import-counter over" : "import-counter"}>
                {chars.toLocaleString("en-US")} 字符
                {overLimit ? `（超出 ${(chars - MAX_BODY_CHARS).toLocaleString("en-US")}）` : ""}
              </span>
              <button
                type="button"
                className="btn btn-primary"
                data-ai-parse
                disabled={busy !== null || text.trim() === "" || !isAiSection(section)}
                onClick={onParseText}
              >
                {busy === "parse" ? "解析中…" : "解析原文"}
              </button>
            </div>
            {preview ? (
              <p
                className="import-stats"
                data-ai-stats
                data-paragraph-count={preview.stats.paragraphCount}
                data-sentence-count={preview.stats.sentenceCount}
              >
                段 {preview.stats.paragraphCount} / 句 {preview.stats.sentenceCount}
              </p>
            ) : null}
          </>
        )}
        {batchHint ? (
          <p className="ai-hint ai-hint-batch" data-ai-batch-hint>
            {batchHint}（不阻断：可以一次粘完，也可以分几次粘回，覆盖率累加）
          </p>
        ) : null}
        {sentenceList.length > 0 ? (
          <ol className="ai-sentence-list" data-ai-sentence-list>
            {sentenceList.map((row) => (
              <li key={`${row.paragraphIdx}-${row.sentenceIdx}`} data-ai-sentence data-s-no={`S${row.ordinal}`}>
                <span className="ai-s-no">S{row.ordinal}</span>
                <span className="ai-s-text">{sentencePreview(row.text)}</span>
                <span className="ai-s-pos">
                  第 {row.paragraphIdx + 1} 段第 {row.sentenceIdx + 1} 句
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {preview ? (
        <section className="card" aria-labelledby="ai-prompt-title">
          <h2 id="ai-prompt-title">③ 复制提示词给 AI</h2>
          <p className="card-hint">
            点「复制提示词」把它和自己的原文一起交给你的 AI（模板已含题型片段与句子清单；不用把 key 交给任何人）。
          </p>
          <div className="import-row">
            <button
              type="button"
              className="btn btn-primary"
              data-ai-prompt-copy
              disabled={!prompt}
              onClick={copyPrompt}
            >
              {copied === "prompt" ? "已复制" : "复制提示词 + 句子清单"}
            </button>
            {prompt ? (
              <span className="ai-hint" data-ai-prompt-meta>
                {prompt.sentenceCount} 句 · 建议每批 {prompt.batchSize} 句 · 共 {prompt.batchCount} 批
              </span>
            ) : null}
          </div>
          {prompt ? (
            <textarea className="import-textarea ai-prompt-text" data-ai-prompt rows={10} readOnly value={prompt.text} />
          ) : null}
        </section>
      ) : null}

      {preview ? (
        <section className="card" aria-labelledby="ai-payload-title">
          <h2 id="ai-payload-title">④ 粘回 AI 的 JSON</h2>
          <p className="card-hint">
            可以直接粘 AI 的整段回复（带 ``` 围栏或前后说明也行，App 只取最外层 {"{ … }"}，其余丢弃并计数）。
            可以分几次粘，覆盖率累加。
          </p>
          <textarea
            className="import-textarea"
            data-ai-payload
            rows={8}
            spellCheck={false}
            placeholder='{"packVersion":"2026.11.08-1","section":"…","sentences":[…]}'
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
          />
          <div className="import-row">
            <button
              type="button"
              className="btn btn-primary"
              data-ai-match
              disabled={busy !== null || payloadText.trim() === ""}
              onClick={onMatch}
            >
              {busy === "match" ? "匹配中…" : "解析并匹配"}
            </button>
            {ignoredChars > 0 ? (
              <span className="ai-hint" data-ai-ignored-chars>
                已忽略 {ignoredChars} 字说明文字
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {merged || baseline ? (
        <section className="card" aria-labelledby="ai-coverage-title" data-ai-result>
          <h2 id="ai-coverage-title">⑤ 覆盖率与未匹配清单</h2>
          <p className="import-stats" data-ai-coverage>
            解析 {covered}/{totalSentences} · 题目 {questionCount} · 词条 {lexiconCount}
          </p>
          <p className="ai-hint" data-ai-blank-coverage>
            {section === "cloze"
              ? blankTotal
                ? `逐空 ${blankCount}/${blankTotal}`
                : `逐空 ${blankCount}`
              : "逐空 -（非选词填空）"}
          </p>
          <p className="ai-hint" data-ai-missing-answer>
            题目缺答案 {merged?.missingAnswer ?? 0} 题
          </p>
          <p className="ai-hint" data-ai-sno-fixed>
            编号已纠正 {merged?.snoFixed ?? 0} 条
          </p>

          {merged ? (
            <div className="ai-unmatched" data-ai-unmatched>
            <h3 className="ai-subtitle">未匹配（{merged.unmatched.length}）</h3>
            {merged.unmatched.length === 0 ? (
              <p className="ai-hint">全部句子都对上了。</p>
            ) : (
              <ul className="ai-unmatched-list">
                {merged.unmatched.map((item) => (
                  <li key={item.quote} data-ai-unmatched-item data-unmatched-reason={item.reason}>
                    <p className="ai-unmatched-quote">{sentencePreview(item.quote)}</p>
                    <p className="ai-unmatched-reason">
                      {item.sNo ? `${item.sNo} · ` : ""}
                      {item.reason}
                    </p>
                    <div className="import-row">
                      <button type="button" className="btn" data-ai-skip onClick={() => skipUnmatched(item)}>
                        跳过该句
                      </button>
                      <button type="button" className="btn" data-ai-regen onClick={() => regenerate(item)}>
                        重新生成该句
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {merged.unmatchedLexicon.length > 0 ? (
              <ul className="ai-unmatched-list" data-ai-unmatched-lexicon>
                {merged.unmatchedLexicon.map((item) => (
                  <li key={item.word} data-ai-unmatched-word data-unmatched-reason={item.reason}>
                    <p className="ai-unmatched-quote">{item.word}</p>
                    <p className="ai-unmatched-reason">{item.reason}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            </div>
          ) : (
            <p className="ai-hint" data-ai-patch-baseline>
              这是已入库文章：上面是库里已有的覆盖率。粘回新的解析后按（段,句）合并，覆盖率累加。
            </p>
          )}

          {regenText ? (
            <textarea className="import-textarea ai-prompt-text" data-ai-regen-text rows={8} readOnly value={regenText} />
          ) : null}

          <div className="import-row import-row-end">
            <span className="ai-hint" data-ai-skipped-count>
              已跳过 {skipped.length} 条
              {patchMode && pendingCount > 0 ? ` · 本批待补 ${pendingCount} 句` : ""}
            </span>
            {patchMode ? (
              <button
                type="button"
                className="btn btn-primary"
                data-ai-patch-commit
                disabled={busy !== null || !merged || merged.matched.length === 0}
                onClick={onCommit}
              >
                {busy === "commit" ? "写入中…" : "补充解析"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                data-ai-commit
                disabled={busy !== null || !merged || merged.matched.length === 0}
                onClick={onCommit}
              >
                {busy === "commit" ? "写入中…" : "导入这篇文章"}
              </button>
            )}
          </div>
        </section>
      ) : null}

      {notice ? (
        <p className="ai-hint ai-notice" role="status" data-ai-notice>
          {notice}
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────── 页面（双 Tab） ─────────────────────────

type ImportMode = "quick" | "ai";

export function Import() {
  /** 补解析入口（`#/import?articleId=<id>`）→ 直接进 AI 模式（§四.2 只看 articleId 是否存在） */
  const [patchArticleId, setPatchArticleId] = useState<number | undefined>(() => readPatchArticleId());
  const [mode, setMode] = useState<ImportMode>(patchArticleId !== undefined ? "ai" : "quick");

  /**
   * 补解析 URL 变化必须自己跟：`#/import?articleId=N` 与 `#/import` 的 path 都是 `#/import`，
   * React 会复用同一个 Import 实例（不重挂载）——只听首帧的话，从补解析页点侧栏「导入」会
   * 永远停在 patch 模式（粘原文框再也不出现）。
   */
  useEffect(() => {
    const onHashChange = () => {
      const next = readPatchArticleId();
      setPatchArticleId(next);
      // 有 articleId → 补解析（AI 模式）；没有 → 回到默认的快速导入首屏
      setMode(next !== undefined ? "ai" : "quick");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /** 粘贴的原文（**失败不丢**：AC11） */
  const [text, setText] = useState("");
  /** 预览（null = 还没解析过；解析失败时**保持原值**，不清空） */
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /** 被剔除的段落 idx（勾上 = 剔除） */
  const [excluded, setExcluded] = useState<number[]>([]);
  /** 标题（解析成功后回填后端给的默认标题；用户改动后就以用户为准） */
  const [title, setTitle] = useState("");
  const [examType, setExamType] = useState("other");
  const [examYear, setExamYear] = useState("");
  const [error, setError] = useState<ImportError | null>(null);
  const [busy, setBusy] = useState<"parse" | "commit" | null>(null);

  const chars = text.length;
  const overLimit = chars > MAX_BODY_CHARS;

  /** 保留的段落 + 重排 `idx`（L1 要求 idx 从 0 连续） */
  const kept = useMemo<ImportParagraph[]>(() => {
    if (!preview) return [];
    return preview.paragraphs
      .filter((paragraph) => !excluded.includes(paragraph.idx))
      .map((paragraph, index) => ({ ...paragraph, idx: index }));
  }, [preview, excluded]);

  const keptStats = useMemo(() => statsOf(kept), [kept]);

  async function onParse() {
    setBusy("parse");
    setError(null);
    try {
      const next = await parseImportPreview(text, title.trim() === "" ? undefined : title.trim());
      setPreview(next);
      setTitle(next.title);
      // 新预览 = 新段落集合：旧的剔除选择不再有意义（但**文本不清**，用户可改完再解析）
      setExcluded([]);
    } catch (err) {
      // AC11：只记错误，preview/excluded/title/text 全部保留
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  async function onCommit() {
    if (!preview) return;
    if (kept.length === 0) {
      setError({ code: null, hint: "至少要保留一段再导入。" });
      return;
    }
    setBusy("commit");
    setError(null);
    try {
      const payload: ImportPreview = {
        ...preview,
        title: title.trim() === "" ? preview.title : title.trim(),
        paragraphs: kept,
        stats: keptStats,
      };
      const yearText = examYear.trim();
      const year = yearText === "" ? null : Number(yearText);
      const result = await commitImport(payload, {
        examType,
        examYear: Number.isFinite(year) ? year : null,
      });
      window.location.hash = `#/article/${result.articleId}`;
    } catch (err) {
      // AC11：提交失败同样保留全部编辑（用户可以改标题/恢复段落后再试）
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  const goArticle = useCallback((articleId: number) => {
    window.location.hash = `#/article/${articleId}`;
  }, []);

  return (
    <div className="import-page">
      <div className="import-tabs" role="tablist" aria-label="导入方式">
        <button
          type="button"
          role="tab"
          className={mode === "quick" ? "import-tab active" : "import-tab"}
          aria-selected={mode === "quick"}
          data-import-mode="quick"
          onClick={() => setMode("quick")}
        >
          快速导入（只要原文）
        </button>
        <button
          type="button"
          role="tab"
          className={mode === "ai" ? "import-tab active" : "import-tab"}
          aria-selected={mode === "ai"}
          data-import-mode="ai"
          onClick={() => setMode("ai")}
        >
          AI 解析导入（原文 + 解析）
        </button>
      </div>

      {/* 快速导入：M5 六步，**原样保留**（AC1 不回归）。用 hidden 而不是卸载，
          切回来自动还在原状态（AI 侧反过来：卸载即清空中间态，见 §四.5）。 */}
      <div hidden={mode !== "quick"} data-quick-panel>
        <section className="card" aria-labelledby="import-input-title">
          <h2 id="import-input-title">粘贴正文</h2>
          <p className="card-hint">
            纯文本，一段一行、段间空行。英文正文；单篇上限 {MAX_BODY_CHARS.toLocaleString("en-US")} 字符
            （超了按段拆开分次导入）。解析只做预览，**不写库**。
          </p>
          <label className="import-label" htmlFor="import-text">
            正文
          </label>
          <textarea
            id="import-text"
            className="import-textarea"
            data-import-text
            value={text}
            rows={12}
            spellCheck={false}
            placeholder="在这里粘贴英文正文……"
            onChange={(event) => setText(event.target.value)}
          />
          <div className="import-row">
            <span className={overLimit ? "import-counter over" : "import-counter"} data-import-counter>
              {chars.toLocaleString("en-US")} 字符
              {overLimit ? `（超出 ${(chars - MAX_BODY_CHARS).toLocaleString("en-US")}）` : ""}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              data-import-parse
              disabled={busy !== null || text.trim() === ""}
              onClick={onParse}
            >
              {busy === "parse" ? "解析中…" : "解析预览"}
            </button>
          </div>
        </section>

        {error ? (
          <div className="import-error" role="alert" data-import-error>
            <span className="import-error-code" data-import-error-code>
              {error.code ?? "提示"}
            </span>
            <span className="import-error-hint">{error.hint}</span>
          </div>
        ) : null}

        {preview ? (
          <section className="card" aria-labelledby="import-preview-title" data-import-preview>
            <h2 id="import-preview-title">预览</h2>
            <p
              className="import-stats"
              data-import-stats
              data-paragraph-count={preview.stats.paragraphCount}
              data-sentence-count={preview.stats.sentenceCount}
              data-word-count={preview.stats.wordCount}
              data-token-count={preview.stats.tokenCount}
              data-kept-paragraph-count={keptStats.paragraphCount}
              data-kept-sentence-count={keptStats.sentenceCount}
              data-kept-word-count={keptStats.wordCount}
            >
              段 {preview.stats.paragraphCount} · 句 {preview.stats.sentenceCount} · 词{" "}
              {preview.stats.wordCount}
              {excluded.length > 0 ? `（保留 ${keptStats.paragraphCount} 段 / ${keptStats.wordCount} 词）` : ""}
            </p>

            <div className="import-meta">
              <label className="import-field">
                <span>标题</span>
                <input
                  type="text"
                  data-import-title
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="import-field import-field-narrow">
                <span>题型</span>
                <select data-import-exam-type value={examType} onChange={(event) => setExamType(event.target.value)}>
                  {EXAM_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="import-field import-field-narrow">
                <span>年份</span>
                <input
                  type="text"
                  inputMode="numeric"
                  data-import-exam-year
                  value={examYear}
                  placeholder="可留空"
                  onChange={(event) => setExamYear(event.target.value)}
                />
              </label>
            </div>

            <ol className="import-paragraphs">
              {preview.paragraphs.map((paragraph) => {
                const removed = excluded.includes(paragraph.idx);
                return (
                  <li
                    key={paragraph.idx}
                    className={removed ? "import-paragraph removed" : "import-paragraph"}
                    data-import-paragraph
                    data-paragraph-idx={paragraph.idx}
                    data-paragraph-excluded={removed ? "true" : "false"}
                  >
                    <label className="import-paragraph-head">
                      <input
                        type="checkbox"
                        data-import-paragraph-toggle
                        checked={removed}
                        onChange={() =>
                          setExcluded((prev) =>
                            prev.includes(paragraph.idx)
                              ? prev.filter((item) => item !== paragraph.idx)
                              : [...prev, paragraph.idx],
                          )
                        }
                      />
                      <span className="import-paragraph-idx">第 {paragraph.idx + 1} 段</span>
                      <span className="import-paragraph-meta">{paragraph.sentences.length} 句</span>
                      <span className="import-paragraph-hint">{removed ? "已剔除（不导入）" : "勾选可剔除"}</span>
                    </label>
                    <p className="import-paragraph-text">{paragraph.text}</p>
                  </li>
                );
              })}
            </ol>

            <div className="import-row import-row-end">
              <button
                type="button"
                className="btn btn-primary"
                data-import-commit
                disabled={busy !== null || kept.length === 0}
                onClick={onCommit}
              >
                {busy === "commit" ? "导入中…" : "确认导入"}
              </button>
            </div>
          </section>
        ) : null}
      </div>

      {mode === "ai" ? (
        <AiImport key={patchArticleId ?? "new"} articleId={patchArticleId} onImported={goArticle} />
      ) : null}
    </div>
  );
}
