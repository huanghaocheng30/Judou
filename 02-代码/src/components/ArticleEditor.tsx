/**
 * M5c D5：文章编辑面板（元信息 + 题目）。
 *
 * - 元信息 → `update_article_meta`（只写 `article` 的六列，不动原文与解析）
 * - 题目   → `replace_article_questions`（只写 `question` 表，`answer_source` 原样保留）
 *
 * 两处入口（D4）：文章库卡片 `data-article-edit` 与精读页页头 `data-article-edit`。
 * AC9 / AC10 的界面侧钩子就在本文件：`data-meta-save` / `data-question-edit` / `data-question-save`。
 */
import { useEffect, useState } from "react";
import { getArticleQuestions, replaceArticleQuestions, updateArticleMeta } from "../lib/api";
import type { AiSection, QuestionView } from "../lib/types";

interface ArticleEditorProps {
  articleId: number;
  /** 初值（来自列表/精读页已有数据，省一次 IPC） */
  initialTitle: string;
  initialExamYear?: number | null;
  initialSectionLabel?: string | null;
  onClose: () => void;
  /** 保存成功后的回调（页面据此刷新标题） */
  onSaved?: (patch: { title: string }) => void;
}

/** `answer_source` 三值的中文标签（AC8：用户给的 / AI 补的 / 都没有） */
const SOURCE_LABEL: Record<string, string> = {
  user: "你给的",
  ai: "AI 补的",
  none: "无",
};

export function ArticleEditor(props: ArticleEditorProps) {
  const { articleId, initialTitle, initialExamYear, initialSectionLabel, onClose, onSaved } = props;

  const [title, setTitle] = useState(initialTitle);
  const [examYear, setExamYear] = useState(initialExamYear == null ? "" : String(initialExamYear));
  const [sectionType, setSectionType] = useState(initialSectionLabel ?? "");
  const [metaState, setMetaState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; message?: string }>({ kind: "idle" });

  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [questionState, setQuestionState] = useState<{ kind: "loading" | "idle" | "saving" | "saved" | "error"; message?: string }>({
    kind: "loading",
  });

  useEffect(() => {
    let alive = true;
    getArticleQuestions(articleId)
      .then((rows) => {
        if (alive) setQuestions(rows);
        if (alive) setQuestionState({ kind: "idle" });
      })
      .catch((err: unknown) => {
        if (alive) setQuestionState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
  }, [articleId]);

  const saveMeta = async () => {
    setMetaState({ kind: "saving" });
    try {
      const year = examYear.trim() === "" ? null : Number.parseInt(examYear.trim(), 10);
      if (examYear.trim() !== "" && !Number.isFinite(year as number)) {
        setMetaState({ kind: "error", message: "年份只能是数字" });
        return;
      }
      await updateArticleMeta(articleId, {
        title: title.trim(),
        examYear: year,
        sectionType: sectionType.trim() === "" ? null : (sectionType.trim() as AiSection),
      });
      setMetaState({ kind: "saved" });
      onSaved?.({ title: title.trim() });
    } catch (err: unknown) {
      setMetaState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const patchQuestion = (no: number, patch: Partial<QuestionView>) => {
    setQuestions((rows) => rows.map((row) => (row.no === no ? { ...row, ...patch } : row)));
    setQuestionState({ kind: "idle" });
  };

  const saveQuestions = async () => {
    setQuestionState({ kind: "saving" });
    try {
      const written = await replaceArticleQuestions(articleId, questions);
      setQuestions(written);
      setQuestionState({ kind: "saved" });
    } catch (err: unknown) {
      setQuestionState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="article-editor" data-article-editor data-article-id={articleId}>
      <div className="editor-head">
        <h2>编辑文章</h2>
        <button type="button" className="link-btn" onClick={onClose} data-editor-close>
          关闭
        </button>
      </div>

      <section className="editor-block">
        <h3>元信息</h3>
        <label className="editor-field">
          <span>标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} data-meta-title />
        </label>
        <label className="editor-field">
          <span>年份</span>
          <input value={examYear} onChange={(event) => setExamYear(event.target.value)} data-meta-year />
        </label>
        <label className="editor-field">
          <span>题型</span>
          <select value={sectionType} onChange={(event) => setSectionType(event.target.value)} data-meta-section>
            <option value="">（不改）</option>
            <option value="careful">仔细阅读</option>
            <option value="long">长篇阅读</option>
            <option value="cloze">选词填空</option>
          </select>
        </label>
        <div className="editor-actions">
          <button type="button" className="btn" onClick={saveMeta} disabled={metaState.kind === "saving"} data-meta-save>
            {metaState.kind === "saving" ? "保存中…" : "保存元信息"}
          </button>
          {metaState.kind === "saved" && <span className="editor-ok" data-meta-saved>已保存</span>}
          {metaState.kind === "error" && <span className="editor-err" data-meta-error>{metaState.message}</span>}
        </div>
      </section>

      <section className="editor-block">
        <h3>题目（{questions.length} 道）</h3>
        {questionState.kind === "loading" && <p className="editor-hint">读取中…</p>}
        {questionState.kind === "error" && <p className="editor-err">{questionState.message}</p>}
        {/* 只改「题干 + 答案」，选项由 AI 逐字对齐入库，界面不给改（避免与原文脱钩） */}
        {questions.map((question) => (
          <div className="editor-question" key={question.no} data-question-row={question.no}>
            <span className="editor-qno">{question.no}.</span>
            <input
              className="editor-stem"
              value={question.stem}
              onChange={(event) => patchQuestion(question.no, { stem: event.target.value })}
              data-question-edit={question.no}
            />
            <input
              className="editor-answer"
              value={question.answer ?? ""}
              onChange={(event) => patchQuestion(question.no, { answer: event.target.value === "" ? null : event.target.value })}
              data-question-answer={question.no}
            />
            <span className="editor-source" data-answer-source={question.answerSource}>
              {SOURCE_LABEL[question.answerSource] ?? question.answerSource}
            </span>
          </div>
        ))}
        <div className="editor-actions">
          <button
            type="button"
            className="btn"
            onClick={saveQuestions}
            disabled={questionState.kind === "saving"}
            data-question-save
          >
            {questionState.kind === "saving" ? "保存中…" : "保存题目"}
          </button>
          {questionState.kind === "saved" && <span className="editor-ok" data-question-saved>已保存（原文与解析未动）</span>}
          {questionState.kind === "error" && <span className="editor-err" data-question-error>{questionState.message}</span>}
        </div>
      </section>
    </div>
  );
}
