/**
 * 导入页（M5 / 02 D4，AC10 + AC11）：**两阶段**，预览不写库。
 *
 * ① 粘贴纯文本 →「解析预览」→ `parse_import_preview`（Rust 侧清洗/分段/切句/分词，前端只渲染）
 * ② 预览页可改标题、剔段、选题型年份 →「确认导入」→ `commit_import`（四层校验 + 单事务）→ 跳 `#/article/<id>`
 *
 * **AC11（错误交互）的实现在状态设计里**：`preview` / `excluded` / `title` / 正文 `text` 各自独立存，
 * 解析或提交失败时**只写 `error`、绝不 reset 其它状态**——用户剔过的段与改过的标题必须还在。
 * 错误一律给「错误码 + 可操作提示」（只给码用户不知道下一步做什么）。
 *
 * ponytail: 剔段用段落 `idx` 集合（不是在下标数组里 splice）——原文不动、预览不重排，
 * 只在提交前 `kept()` 时过滤 + 重排 `idx`。这样「取消勾选」天然可逆，也不会把偏移弄脏。
 */
import { useMemo, useState } from "react";
import { commitImport, parseImportPreview } from "../lib/api";
import type { ImportParagraph, ImportPreview, ImportStats } from "../lib/types";

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

interface ImportError {
  /** 后端错误码；本地预检（如「一段都没留」）没有码，为 null */
  code: string | null;
  /** 展示文案 = 错误码对应提示；无提示时退回后端 message */
  hint: string;
}

/** Tauri 拒绝值是 `CommandError {code,message,path}` 对象，不是 `Error` 实例 */
function readError(err: unknown): ImportError {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    const codeText = typeof code === "string" && code.trim() !== "" ? code : null;
    const messageText = typeof message === "string" ? message : "";
    return {
      code: codeText,
      hint: (codeText && ERROR_HINTS[codeText]) || messageText || "导入失败，请重试。",
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

export function Import() {
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

  return (
    <div className="import-page">
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
  );
}
