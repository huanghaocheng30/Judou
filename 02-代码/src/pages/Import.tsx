/**
 * 导入页（M5c：**单一「AI 解析导入」流程**，02 §二 D3）。
 *
 * 页面只有一个流程，进入即见**四步引导条**（不需要先粘完才看到下一步）：
 *   ① 一次粘贴「原文 + 题目 + 答案」→ App 自动切分正文区 / 题目区
 *   ② 选三档需求（A 只要原文 / B 原文 + 解析 / C 原文 + 题目答案 + 解析，默认 C）
 *   ③ 一键复制「提示词 + 我的全部文本」交给自己的 AI
 *   ④ 粘回 JSON → 对齐校验 → 入库
 *
 * 红线（02 §四）：
 *   1. **校验与写库只有一份实现**（Rust `ai_import.rs`）：本文件不做形态校验、不改偏移、
 *      不猜句对齐——它只渲染和累积状态。
 *   2. App 管结构：段/句/词/偏移由 `parse_import_preview` 算一次；切分由 `split_user_input` 算一次。
 *   3. 保留 M5b 的全部 `data-ai-*` 钩子（36 个属性名 / 37 处），M5c 只新增钩子、不删旧钩子。
 *   4. 允许不完整：解析/题目/逐空/词条任一缺失都能入库；档 A 连解析都不需要。
 *
 * ponytail: 多次粘贴的「累加」在前端按 (段,句) / 题号 / 空号 / 词条 去重合并（后者覆盖前者），
 * 再原样交给后端写库——后端不做跨调用状态（它每次只写传进来的那一份）。
 * 升级路径：若将来要「服务端权威累加」，把 merge 搬到 `match_ai_payload` 里加一个「已入库快照」入参即可。
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildAiPrompt,
  commitAiImport,
  getAiImportStats,
  getArticleContent,
  matchAiPayload,
  parseAiPayload,
  parseImportPreview,
  patchAiAnalysis,
  splitUserInput,
} from "../lib/api";
import type {
  AiImportStats,
  AiMatched,
  AiPrompt,
  AiSection,
  AiUnmatchedSentence,
  ArticleContent,
  ImportMode,
  ImportParagraph,
  ImportPreview,
  ImportStats,
  UserInputSplit,
} from "../lib/types";

/** 正文上限（与 Rust 侧 `MAX_BODY_CHARS` 一致，仅用于前端提示，真正的闸在后端） */
const MAX_BODY_CHARS = 20_000;

/** AI 解析导入的五个错误码（02 §五；M5c 新增 AI_QUESTION_MISMATCH） */
const AI_ERROR_HINTS: Record<string, string> = {
  AI_PAYLOAD_INVALID: "粘贴内容不是合法 JSON。请确认复制了完整的 { … } 块，且没有漏掉结尾的 }",
  AI_TYPE_MISMATCH: "题型或题目形态对不上：请确认模板选的题型与 AI 产物里的 section 一致，且选项数符合题型要求。",
  AI_MARKUP_UNBALANCED: "某句的结构标记不配平。可以点『跳过该句』继续导入。",
  AI_NO_MATCH: "粘贴的解析与当前文章完全不匹配：请确认复制的是这篇文章的模板产物。",
  AI_QUESTION_MISMATCH:
    "题目与你在题目区给的不一致：题目只能对齐、不能生成。请让 AI 逐字照抄题干 / 选项 / 答案（定位见下方 path）。",
};

interface ImportError {
  code: string | null;
  hint: string;
  path?: string | null;
}

/** Tauri 拒绝值是 `CommandError {code,message,path}` 对象，不是 `Error` 实例 */
function readError(err: unknown, hints: Record<string, string> = AI_ERROR_HINTS): ImportError {
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

/** 剔除若干段后重算统计（`commit_import` 直接拿 `stats` 写 `article.sentence_count`） */
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

/** 题型三选一（用户明确指定，不自动猜） */
const SECTION_OPTIONS: Array<{ value: AiSection; label: string }> = [
  { value: "careful", label: "仔细阅读" },
  { value: "long", label: "长篇阅读" },
  { value: "cloze", label: "选词填空" },
];

/** 三档需求（04 §6.2 第 2 步） */
const MODE_OPTIONS: Array<{ value: ImportMode; key: string; hook: string; label: string; hint: string }> = [
  {
    value: "plain",
    key: "a",
    hook: "data-import-mode-a",
    label: "A 只要原文",
    hint: "不要求 AI 做任何事，直接入库；只想读原文、点词、写笔记时用。",
  },
  {
    value: "analysis",
    key: "b",
    hook: "data-import-mode-b",
    label: "B 原文 + 解析",
    hint: "只要句级解析与词条；提示词带正文全文，不带题目区。",
  },
  {
    value: "full",
    key: "c",
    hook: "data-import-mode-c",
    label: "C 原文 + 题目答案 + 解析",
    hint: "真题整篇（最常见）：题目与答案只对齐、不生成。",
  },
];

/** 四步引导条文案（未输入时四步全可见，AC1） */
const STEPS = [
  "① 粘原文 + 题目 + 答案",
  "② 选三档需求",
  "③ 复制给 AI",
  "④ 粘回 JSON 与入库",
];

/** 上次选题型的记忆键（A4：「记住上次选择」） */
const LAST_SECTION_KEY = "judou.aiImport.section";
/** 模板建议批大小（15 是建议值，不是硬上限） */
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

/** 句子清单里每句原文展示的字符数（与 Rust `SENTENCE_PREVIEW_CHARS` 同口径） */
function sentencePreview(text: string): string {
  const chars = [...text];
  return chars.length <= 24 ? text : `${chars.slice(0, 24).join("")}…`;
}

/**
 * 取粘贴内容里最外层 `{ … }`（**只为「跳过该句」做文本外科手术**，不做任何校验）。
 * 校验与解析的唯一实现在后端 `ai_import.rs`。
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

/** `get_article_content` → `ImportPreview`（偏移与 idx 一律原样搬运，前端不得重算） */
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

/** 从 `#/import?articleId=<id>` 里取补解析目标（只看查询串） */
function readPatchArticleId(): number | undefined {
  const raw = window.location.hash;
  const mark = raw.indexOf("?");
  if (mark < 0) return undefined;
  const value = Number(new URLSearchParams(raw.slice(mark + 1)).get("articleId"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 档 A 的空匹配包：后端 `commit_ai_import` 对 `mode=plain` 允许 `matched` 为空 */
function emptyMatched(section: AiSection): AiMatched {
  return {
    section,
    matched: [],
    unmatched: [],
    unmatchedLexicon: [],
    questions: [],
    blanks: [],
    lexicon: [],
    coverage: { analysis: "-", questions: "-", blanks: "-", lexicon: 0 },
    snoFixed: 0,
    missingAnswer: 0,
  };
}

function AiImport({ articleId, onImported }: AiImportProps) {
  const patchMode = articleId !== undefined;
  const [section, setSection] = useState<AiSection | "">(() => readLastSection());
  const [mode, setMode] = useState<ImportMode>("full");
  /** 一次性粘贴的整块文本（原文 + 题目 + 答案） */
  const [text, setText] = useState("");
  const [split, setSplit] = useState<UserInputSplit | null>(null);
  const [questionText, setQuestionText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [prompt, setPrompt] = useState<AiPrompt | null>(null);
  const [payloadText, setPayloadText] = useState("");
  const [merged, setMerged] = useState<AiMatched | null>(null);
  const [stats, setStats] = useState<AiImportStats | null>(null);
  const [ignoredChars, setIgnoredChars] = useState(0);
  const [batchHint, setBatchHint] = useState<string | null>(null);
  const [regenText, setRegenText] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [copied, setCopied] = useState<"all" | "prompt" | "regen" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [busy, setBusy] = useState<"parse" | "match" | "commit" | "load" | null>(null);

  const chars = text.length;
  const overLimit = chars > MAX_BODY_CHARS;

  /** 当前步（高亮用）：1 未粘 → 2 已切分 → 3 已匹配中/待粘回 → 4 有结果 */
  const activeStep = merged || (stats && patchMode) ? 4 : payloadText.trim() !== "" ? 3 : preview ? 2 : 1;

  /** AI 模式入参（三档 + 题目区原文都在这里；后端按 mode 决定提示词与校验） */
  const draft = useMemo(() => {
    if (!preview || !isAiSection(section)) return null;
    return { preview, section, mode, questionText: questionText === "" ? null : questionText };
  }, [preview, section, mode, questionText]);

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

  const chooseSection = (value: string) => {
    if (!isAiSection(value)) {
      setSection("");
      return;
    }
    setSection(value);
    rememberSection(value);
    setPrompt(null);
  };

  /** 档 B/C 才需要提示词；档 A 不生成（不要求 AI 产出） */
  useEffect(() => {
    if (!draft || draft.mode === "plain") {
      setPrompt(null);
      return;
    }
    let cancelled = false;
    buildAiPrompt(draft, AI_BATCH_SIZE)
      .then((next) => {
        if (cancelled) return;
        setPrompt(next);
        setBatchHint(next.batchHint);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(readError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [draft]);

  /** 一次粘贴 → 自动切分（正文区 / 题目区）→ 正文区走既有结构解析 */
  async function onPasteAndSplit() {
    if (!isAiSection(section)) {
      setError({ code: null, hint: "请先选题型（仔细阅读 / 长篇阅读 / 选词填空）。" });
      return;
    }
    setBusy("parse");
    setError(null);
    try {
      const nextSplit = await splitUserInput(text);
      const nextPreview = await parseImportPreview(nextSplit.bodyText);
      setSplit(nextSplit);
      setQuestionText(nextSplit.questionText);
      setPreview(nextPreview);
      setMerged(null);
      setIgnoredChars(0);
      setSkipped([]);
      setRegenText("");
      setPayloadText("");
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  /** AC4「整篇都是正文」：清掉题目区（不报错） */
  function treatAllAsBody() {
    setQuestionText("");
    setSplit((prev) =>
      prev
        ? { ...prev, questionText: "", questionStartLine: null, detected: false, reason: "整篇都是正文（你指定的）", questionCount: 0 }
        : prev,
    );
    setError(null);
  }

  /** AC4「手动标记题目区起点」：从第 N 行起算题目区（用户明确指定，不算猜） */
  function markQuestionStart() {
    const raw = window.prompt("从第几行开始算题目区？（行号从 1 开始）", "1");
    if (!raw) return;
    const startLine = Number(raw);
    const lines = text.split("\n");
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length) {
      setError({ code: null, hint: "行号超出范围，请重新输入。" });
      return;
    }
    const body = lines.slice(0, startLine - 1).join("\n").trimEnd();
    const questions = lines.slice(startLine - 1).join("\n").trimEnd();
    const questionCount = questions.split("\n").filter((line) => /^\s*\d{1,3}\s*[.、．)]\s*\S/.test(line)).length;
    setQuestionText(questions);
    setSplit({
      bodyText: body,
      questionText: questions,
      questionStartLine: startLine,
      detected: true,
      reason: `第 ${startLine} 行起按你的标记算题目区`,
      questionCount,
    });
    setError(null);
    void parseImportPreview(body)
      .then((next) => setPreview(next))
      .catch((err: unknown) => setError(readError(err)));
  }

  /** AC5：一键复制「提示词 + 我的全部文本」——用户不需要自己拼 */
  async function copyAll() {
    const body = prompt ? prompt.text : "";
    const mine = patchMode ? "" : text;
    const payload = mine.trim() === "" ? body : `${body}\n\n【我的文本（原文 + 题目 + 答案，已含在提示词里，此处再附一份原文）】\n${mine}`;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied("all");
    } catch {
      setCopied(null);
    }
  }

  async function copyPromptOnly() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt.text);
      setCopied("prompt");
    } catch {
      setCopied(null);
    }
  }

  async function onMatch() {
    if (!draft) {
      setError({ code: null, hint: "请先选题型并解析原文。" });
      return;
    }
    if (payloadText.trim() === "") {
      setError({ code: null, hint: "请把 AI 返回的 JSON 粘到上面的框里。" });
      return;
    }
    setBusy("match");
    setError(null);
    try {
      const parsed = await parseAiPayload(payloadText);
      const next = await matchAiPayload(draft, parsed.payload);
      setIgnoredChars(parsed.ignoredChars);
      setMerged((prev) => mergeMatched(prev, next));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  function skipUnmatched(item: AiUnmatchedSentence) {
    setSkipped((prev) => (prev.includes(item.quote) ? prev : [...prev, item.quote]));
    setMerged((prev) => (prev ? { ...prev, unmatched: prev.unmatched.filter((row) => row.quote !== item.quote) } : prev));
  }

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

  /** 补解析：进页面即回读原文与题型；覆盖率初值取库里的真读数（不是 0） */
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
        if (!cancelled) setError(readError(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  const baseline = patchMode ? stats : null;
  const covered = (baseline?.analysisCovered ?? 0) + (merged?.matched.length ?? 0);
  const totalSentences = baseline?.sentences ?? preview?.stats.sentenceCount ?? 0;
  const questionCount = (baseline?.questions ?? 0) + (merged?.questions.length ?? 0);
  const lexiconCount = merged?.lexicon.length ?? 0;
  const blankCount = (baseline?.blanks ?? 0) + (merged?.blanks.length ?? 0);
  const blankTotal = useMemo(() => {
    const raw = merged?.coverage.blanks ?? "-";
    const denominator = raw.includes("/") ? raw.split("/")[1] : "";
    if (denominator) return denominator;
    return merged && merged.questions.length > 0 ? String(merged.questions.length) : "";
  }, [merged]);
  const pendingCount = merged?.matched.length ?? 0;

  /** AC8：答案来源三值分布（`user` 用户给的 / `ai` AI 补的 / `none` 都没有） */
  const answerSources = useMemo(() => {
    const questions = merged?.questions ?? [];
    return {
      user: questions.filter((item) => item.answerSource === "user").length,
      ai: questions.filter((item) => item.answerSource === "ai").length,
      none: questions.filter((item) => item.answerSource === "none").length,
    };
  }, [merged]);

  const markupSkipIndex = useMemo(() => {
    if (error?.code !== "AI_MARKUP_UNBALANCED") return null;
    const matched = error.path?.match(/^sentences\[(\d+)\]/);
    return matched ? Number(matched[1]) : null;
  }, [error]);

  async function skipUnbalancedSentence() {
    if (markupSkipIndex === null || !draft) return;
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
      const next = await matchAiPayload(draft, parsed.payload);
      setIgnoredChars(parsed.ignoredChars);
      setMerged((prev) => mergeMatched(prev, next));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  /** 入库：档 A 不需要匹配结果；档 B/C 至少要有 1 句解析能对上 */
  async function onCommit() {
    if (!draft) {
      setError({ code: null, hint: "请先选题型并解析原文。" });
      return;
    }
    const matchedToWrite = merged ?? (draft.mode === "plain" ? emptyMatched(draft.section) : null);
    if (!matchedToWrite) {
      setError({ code: null, hint: "还没有任何一句解析能对上原文，先粘回 AI 的 JSON 或检查题型。" });
      return;
    }
    if (draft.mode !== "plain" && matchedToWrite.matched.length === 0) {
      setError({ code: null, hint: "还没有任何一句解析能对上原文，先粘回 AI 的 JSON 或检查题型。" });
      return;
    }
    setBusy("commit");
    setError(null);
    setNotice(null);
    try {
      if (articleId !== undefined) {
        const result = await patchAiAnalysis(articleId, draft, matchedToWrite);
        const nextStats = await getAiImportStats(articleId);
        setStats(nextStats);
        setMerged(null);
        setPayloadText("");
        setSkipped([]);
        setNotice(
          `已补充解析：本次写入 ${result.analysisWritten} 句解析 / ${result.questionsWritten} 题 / ${result.blanksWritten} 空 / 新增词条 ${result.lexiconInserted}`,
        );
      } else {
        const result = await commitAiImport(draft, matchedToWrite, {});
        onImported(result.articleId);
      }
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  }

  const plainMode = mode === "plain";

  return (
    <div className="ai-import" data-ai-panel>
      {/* 四步引导条：进页即见，未粘任何内容时四步全部可见（AC1） */}
      <ol className="import-steps" data-import-steps data-step-active={activeStep}>
        {STEPS.map((label, index) => (
          <li
            key={label}
            className={activeStep === index + 1 ? "import-step active" : "import-step"}
            data-step
            data-step-index={index + 1}
            data-step-active={activeStep === index + 1 ? "true" : "false"}
          >
            {label}
          </li>
        ))}
      </ol>

      <section className="card" aria-labelledby="import-section-title">
        <h2 id="import-section-title">题型</h2>
        <p className="card-hint">
          题型决定模板片段与形态校验：仔细阅读每题 4 个选项、长篇阅读每题空选项 + 段落字母、选词填空每题 15 项词库。
          App 只算结构与偏移，语义解析由你自己的 AI 生成。
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

      {/* 第 1 步：一次粘贴「原文 + 题目 + 答案」 */}
      <section className="card" aria-labelledby="import-text-title">
        <h2 id="import-text-title">① 粘贴原文 + 题目 + 答案（一次）</h2>
        {patchMode ? (
          <p className="import-stats" data-ai-loaded data-article-id={articleId}>
            已从文章库载入：{preview?.title ?? "读取中…"} · 段 {preview?.stats.paragraphCount ?? "—"} / 句{" "}
            {preview?.stats.sentenceCount ?? "—"}
            {busy === "load" ? "（读取中…）" : ""}
          </p>
        ) : (
          <>
            <p className="card-hint">
              把真题卷 / 外刊页面的**整块文本**粘一次即可：App 自动切出正文区与题目区（题目区不进正文）。
              单篇上限 {MAX_BODY_CHARS.toLocaleString("en-US")} 字符（超了按段拆开分次导入）。解析只做预览，不写库。
            </p>
            <textarea
              className="import-textarea"
              data-ai-text
              rows={12}
              spellCheck={false}
              placeholder="在这里一次粘贴「英文正文 + 题目 + 答案」……"
              value={text}
              onChange={(event) => setText(event.target.value)}
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
                onClick={onPasteAndSplit}
              >
                {busy === "parse" ? "切分中…" : "切分并解析"}
              </button>
            </div>
          </>
        )}

        {/* 切分可视化（AC3 / AC4） */}
        {preview ? (
          <p className="import-stats" data-split-body>
            正文：{preview.stats.paragraphCount} 段 / {preview.stats.sentenceCount} 句
            {split ? `（题目区 ${split.questionText === "" ? 0 : split.questionText.split("\n").length} 行不计入正文句数）` : ""}
          </p>
        ) : null}
        {split ? (
          split.detected && split.questionText !== "" ? (
            <details className="split-question" data-split-question>
              <summary>
                已识别题目区：{split.questionText.split("\n").length} 行（含 {split.questionCount} 道题）
              </summary>
              <pre className="split-question-text">{split.questionText}</pre>
            </details>
          ) : (
            <div className="split-none" data-split-none-state>
              <p className="ai-hint">没识别到题目区（App 不猜）：可以手动标记起点，或当作整篇正文。</p>
              <div className="import-row">
                <button type="button" className="btn" data-split-from onClick={markQuestionStart}>
                  手动标记题目区起点
                </button>
                <button type="button" className="btn" data-split-none onClick={treatAllAsBody}>
                  这就是整篇正文
                </button>
              </div>
            </div>
          )
        ) : null}
      </section>

      {/* 第 2 步：三档需求（默认 C） */}
      <section className="card" aria-labelledby="import-mode-title">
        <h2 id="import-mode-title">② 选三档需求</h2>
        <div className="import-modes" role="radiogroup" aria-label="三档需求">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              className={mode === option.value ? "import-mode active" : "import-mode"}
              data-import-mode-a={option.value === "plain" ? "true" : undefined}
              data-import-mode-b={option.value === "analysis" ? "true" : undefined}
              data-import-mode-c={option.value === "full" ? "true" : undefined}
              data-import-mode-value={option.value}
              onClick={() => setMode(option.value)}
            >
              <span className="import-mode-label">{option.label}</span>
              <span className="import-mode-hint">{option.hint}</span>
            </button>
          ))}
        </div>
      </section>

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

      {error ? (
        <div className="import-error" role="alert" data-ai-error>
          <span className="import-error-code" data-ai-error-code>
            {error.code ?? "提示"}
          </span>
          <span className="import-error-hint">{error.hint}</span>
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

      {/* 第 3 步：复制（档 A 不需要 AI，按钮不出现） */}
      {preview && !plainMode ? (
        <section className="card" aria-labelledby="import-prompt-title">
          <h2 id="import-prompt-title">③ 复制给 AI</h2>
          <p className="card-hint">
            一次复制**提示词 + 我的全部文本**（提示词里已内嵌正文全文{mode === "full" ? "与题目区原文" : ""}），
            整段贴给你的 AI 即可，不用自己拼接。
          </p>
          <div className="import-row">
            <button type="button" className="btn btn-primary" data-copy-all disabled={!prompt} onClick={copyAll}>
              {copied === "all" ? "已复制（提示词 + 我的文本）" : "一键复制（提示词 + 我的文本）"}
            </button>
            <button type="button" className="btn" data-ai-prompt-copy disabled={!prompt} onClick={copyPromptOnly}>
              {copied === "prompt" ? "已复制" : "只复制提示词"}
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

      {preview && plainMode ? (
        <p className="ai-hint" data-ai-plain-hint>
          档 A 只读原文，不需要 AI：无需复制提示词，直接点下面的「导入这篇文章」即可入库。
        </p>
      ) : null}

      {/* 第 4 步：粘回 JSON + 入库（档 A 跳过） */}
      {preview && !plainMode ? (
        <section className="card" aria-labelledby="import-payload-title">
          <h2 id="import-payload-title">④ 粘回 AI 的 JSON</h2>
          <p className="card-hint">
            可以直接粘 AI 的整段回复（带 ``` 围栏或前后说明也行，App 只取最外层 {"{ … }"}，其余丢弃并计数）。
            可以分几次粘，覆盖率累加。档 C 的题干 / 选项 / 答案必须与你的题目区逐字一致，否则会被拒收。
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
        <section className="card" aria-labelledby="import-coverage-title" data-ai-result>
          <h2 id="import-coverage-title">覆盖率与未匹配清单</h2>
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
          <p className="ai-hint" data-ai-answer-source>
            答案来源：用户给的 {answerSources.user} · AI 补的 {answerSources.ai} · 都没有 {answerSources.none}
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
                disabled={busy !== null || !merged || (merged.matched.length === 0 && !plainMode)}
                onClick={onCommit}
              >
                {busy === "commit" ? "写入中…" : "补充解析"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                data-ai-commit
                disabled={busy !== null || (!merged && !plainMode)}
                onClick={onCommit}
              >
                {busy === "commit" ? "写入中…" : "导入这篇文章"}
              </button>
            )}
          </div>
        </section>
      ) : null}

      {/* 档 A：没有覆盖率也可以直接入库（AC2/AC5） */}
      {preview && plainMode && !merged ? (
        <div className="import-row import-row-end">
          <button type="button" className="btn btn-primary" data-ai-commit disabled={busy !== null} onClick={onCommit}>
            {busy === "commit" ? "写入中…" : "导入这篇文章（档 A 不需要 AI）"}
          </button>
        </div>
      ) : null}

      {notice ? (
        <p className="ai-hint ai-notice" role="status" data-ai-notice>
          {notice}
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────── 页面（单一流程，无 Tab） ─────────────────────────

export function Import() {
  const [patchArticleId, setPatchArticleId] = useState<number | undefined>(() => readPatchArticleId());

  /**
   * 补解析 URL 变化必须自己跟：`#/import?articleId=N` 与 `#/import` 的 path 都是 `#/import`，
   * React 会复用同一个实例（不重挂载）。
   */
  useEffect(() => {
    const onHashChange = () => setPatchArticleId(readPatchArticleId());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const goArticle = useMemo(
    () => (articleId: number) => {
      window.location.hash = `#/article/${articleId}`;
    },
    [],
  );

  return (
    <div className="import-page">
      <AiImport key={patchArticleId ?? "new"} articleId={patchArticleId} onImported={goArticle} />
    </div>
  );
}
