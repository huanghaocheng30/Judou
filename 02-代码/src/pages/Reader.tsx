/**
 * 精读页（M1 只读渲染 + M2 交互接线 / 05 §四 / D9）。
 *
 * 硬要求（AC6 / AC7 / AC9 / AC10）：
 * - 词节点 `data-token-id` / `data-n` / `data-start`，空格节点 `data-blank-no`，句节点 `data-sentence-idx`
 *   ——M1 冻结的属性名**只加不改**（本包新增 `data-sentence-id` 与 `data-question-answer`）。
 * - **选中态三者互斥**：点词 → `word`（带 `normalized`，决策 #26）+ `stopPropagation`；点句 → `sentence`
 *   （带 `text`，决策 #23）；点空格 → `blank`（也 `stopPropagation`）。点「词之间的空白/句尾」落在句节点上
 *   → 句子卡出现、词卡不出现。
 * - **键盘可达**（AC10）：词/句/空节点 `tabIndex={0}` + `role="button"` + `Enter`/`Space` 触发同一选中。
 * - **题目区**：默认折叠；每题「显示答案」→ **只显示答案字母 + 对应选项文字**；`answer === null` →
 *   「本题无预置答案」（样本 `set2Long` 第 38 题）；**不判对错、不计分、不用「正确/错误」语义色**；
 *   选项是纯文本 `<li>`，**不可点选**（点击后 DOM 无变化）。
 * - **宽屏（≥1100px）**：`.reader-split` grid 双列（正文列 + 360px 右栏），点句**原地更换**、不遮挡正文
 *   （06 #6 / 决策 #17）；**窄屏**右栏退化为 `AnalysisPanel` 内的底部抽屉（`max-height ≤55vh` + Esc）。
 * - 空格判定走 `renderTokens` 纯函数（`isWord === false` ∧ 纯数字 ∧ ∈ blankNos），固有数字不得误判。
 *
 * ponytail: 整篇一次渲染（274 句上限，长文 1208 token 纯函数 < 50ms 已实测），不做虚拟滚动；
 * 等真的出现「万字级用户导入篇 + 卡顿」再上分段渲染（renderTokens 的节点契约不变）。
 */
import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnalysisPanel, useWideLayout } from "../components/AnalysisPanel";
import type { AnalysisSelection } from "../components/AnalysisPanel";
import { getArticleContent, getArticleNoteMarks } from "../lib/api";
import { renderParagraph, renderTokens } from "../lib/render";
import type { TokenNode } from "../lib/render";
import type { ApiSentence, ArticleContent, NoteMarks } from "../lib/types";
import { useReturn, useRoute } from "../shell/routes";

/** 触发键：Enter 与 Space（AC10「Enter/Space 能触发同一卡片」） */
function isActivationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}

interface SentenceProps {
  sentence: ApiSentence;
  /** 本句是否写过笔记（F4 批次查询的 `sentenceIds`）→ 句末「析」角标实心态 */
  hasNote: boolean;
  /** 本篇有词笔记的 tokenId 集合（F4 的 `tokenIds`）→ 词节点 `data-has-note="1"` */
  noteTokenIds: ReadonlySet<number>;
  onSelectSentence: (sentence: ApiSentence) => void;
  onSelectWord: (node: TokenNode) => void;
  onSelectBlank: (blankNo: number) => void;
}

/** 一句：纯函数切分成 text / word / blank 三类节点，按原顺序摊平（间隙文本原样保留空格） */
function Sentence({ sentence, hasNote, noteTokenIds, onSelectSentence, onSelectWord, onSelectBlank }: SentenceProps) {
  const nodes = renderTokens(sentence.text, sentence.tokens, sentence.blankNos);

  return (
    <span
      className="sentence"
      data-sentence-idx={sentence.idx}
      data-sentence-id={sentence.id}
      role="button"
      tabIndex={0}
      aria-label="查看本句解析"
      onClick={() => onSelectSentence(sentence)}
      onKeyDown={(event) => {
        if (!isActivationKey(event)) return;
        event.preventDefault();
        onSelectSentence(sentence);
      }}
    >
      {nodes.map((node, index) => {
        if (node.kind === "word") {
          return (
            <span
              key={index}
              className="tok"
              data-token-id={node.tokenId}
              data-n={node.normalized}
              data-start={node.start}
              data-has-note={node.tokenId !== undefined && noteTokenIds.has(node.tokenId) ? "1" : undefined}
              role="button"
              tabIndex={0}
              aria-label={`查看「${node.text}」的词卡`}
              onClick={(event) => {
                // 点词不触发句子卡（AC7 不误触）
                event.stopPropagation();
                onSelectWord(node);
              }}
              onKeyDown={(event) => {
                if (!isActivationKey(event)) return;
                event.preventDefault();
                event.stopPropagation();
                onSelectWord(node);
              }}
            >
              {node.text}
            </span>
          );
        }
        if (node.kind === "blank" && node.blankNo !== undefined) {
          const blankNo = node.blankNo;
          return (
            <span
              key={index}
              className="blank"
              data-blank-no={blankNo}
              data-token-id={node.tokenId}
              data-start={node.start}
              role="button"
              tabIndex={0}
              aria-label={`查看第 ${blankNo} 空解析`}
              onClick={(event) => {
                event.stopPropagation();
                onSelectBlank(blankNo);
              }}
              onKeyDown={(event) => {
                if (!isActivationKey(event)) return;
                event.preventDefault();
                event.stopPropagation();
                onSelectBlank(blankNo);
              }}
            >
              {node.text}
            </span>
          );
        }
        return node.text;
      })}
      {/* 句末角标（TP-修复1 F2 / AC-R2）：纯装饰提示「这句能点开解析」。
          为什么不用 <button>：外层 `.sentence` 已是 role="button" + tabIndex=0，嵌套按钮既制造嵌套交互语义、
          又会抢走 Tab 焦点；角标不接事件（点击冒泡给父节点），`aria-hidden` 免得屏幕阅读器重复念。
          `data-has-note="1"` 只在写过笔记时出现（F3/AC-R3 的视觉痕迹）。 */}
      <span className="sentence-mark" aria-hidden="true" data-sentence-mark data-has-note={hasNote ? "1" : undefined}>
        析
      </span>
    </span>
  );
}

export function Reader() {
  const [route] = useRoute();
  const goBack = useReturn();
  const articleId = route.articleId;
  const [content, setContent] = useState<ArticleContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<AnalysisSelection>({ kind: "none" });
  const [revealed, setRevealed] = useState<number[]>([]);
  /** 本篇笔记标记（F4/AC-R3）：一次 IPC 全量取，句末角标与词节点据此打 `data-has-note` */
  const [noteMarks, setNoteMarks] = useState<NoteMarks>({ sentenceIds: [], tokenIds: [] });
  const wide = useWideLayout();

  useEffect(() => {
    if (!articleId) {
      setContent(null);
      setError("这个地址缺文章编号（应为 #/article/<id>）。");
      return;
    }
    let cancelled = false;
    setContent(null);
    setError(null);
    getArticleContent(articleId)
      .then((value) => {
        if (!cancelled) setContent(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  // 换篇目：关掉解析面板与已展开的答案（不把别篇的选中态带过来）
  useEffect(() => {
    setSelection({ kind: "none" });
    setRevealed([]);
  }, [articleId]);

  // 本篇笔记标记（TP-修复1 F4 / AC-R3）：**一次** IPC 拿全篇「哪些句 / 哪些词写过笔记」。
  // 独立于正文加载：标记查询失败只让标记缺失（降级空集合 + 控制台留痕），不能拖垮正文阅读。
  // 注意**不要**改成逐句 getSentenceNote（274 句 × 2 表 = 数百次 IPC）。
  useEffect(() => {
    if (!articleId) {
      setNoteMarks({ sentenceIds: [], tokenIds: [] });
      return;
    }
    let cancelled = false;
    getArticleNoteMarks(articleId)
      .then((marks) => {
        if (!cancelled) setNoteMarks(marks);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("[judou] 读本篇笔记标记失败，正文标记降级为空：", err);
          setNoteMarks({ sentenceIds: [], tokenIds: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  // 写/清笔记后就地更新标记（F3/AC-R3「写后出现、清空消失」）：**零额外 IPC**——
  // 用 NoteEditor 保存成功回调做本地增量，不为一次标记变化再查一遍全篇。
  // 无变化时返回同一个对象引用，React 不重渲染。
  const handleNoteSaved = useCallback((kind: "sentence" | "word", id: number, hasContent: boolean): void => {
    setNoteMarks((current) => {
      if (kind === "sentence") {
        if (current.sentenceIds.includes(id) === hasContent) return current;
        return {
          ...current,
          sentenceIds: hasContent
            ? [...current.sentenceIds, id]
            : current.sentenceIds.filter((item) => item !== id),
        };
      }
      if (current.tokenIds.includes(id) === hasContent) return current;
      return {
        ...current,
        tokenIds: hasContent ? [...current.tokenIds, id] : current.tokenIds.filter((item) => item !== id),
      };
    });
  }, []);

  /**
   * 关闭解析面板的**唯一出口**（关闭按钮 / Esc / 宽屏 Esc 共用，TP-修复1 F1）。
   *
   * 为什么不需要另写 flush：面板一关 → `NoteEditor` 卸载 → `useDebouncedSave` 的卸载清理会
   * `flushAll()` 把待落库草稿发出去（M2 已验收路径），所以「关前 flush」走的是既有链路。
   * 关后把焦点还给刚操作的句子（02 §四 缓解措施）：宽屏右栏收起后键盘用户不至于丢失位置。
   *
   * 位置硬约束：本 hook 必须在下面 `if (error)` / `if (!content)` 两个早退**之前**——
   * 放到早退之后就变成条件调用，两次渲染的 hook 数量不同，React 会直接抛
   * 「Rendered more hooks than during the previous render」并崩白页（本次实测过一次，见自测）。
   */
  const closePanel = useCallback((): void => {
    const sentenceId = selection.kind === "sentence" ? selection.id : null;
    setSelection({ kind: "none" });
    if (sentenceId !== null) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-sentence-id="${sentenceId}"]`)?.focus();
      });
    }
  }, [selection]);

  const backButton = (
    <button type="button" className="btn reader-back" onClick={goBack} data-testid="reader-back">
      ‹ 返回文章库
    </button>
  );

  if (error) {
    return (
      <section className="reader">
        <div className="empty" data-testid="reader-error">
          <p>读不到这篇：{error}</p>
          {backButton}
        </div>
      </section>
    );
  }

  if (!content) {
    return (
      <section className="reader">
        <p className="reader-loading" data-testid="reader-loading">
          读取中…
        </p>
      </section>
    );
  }

  const detail = content.article;
  // Set 化词标记：正文有 274 句 / 数千词，避免每个词对数组做一次线性 includes（F3）
  const noteTokenIdSet = new Set(noteMarks.tokenIds);
  const meta = [
    detail.sectionLabel,
    detail.passageLabel,
    detail.wordCount === null ? null : `${detail.wordCount} 词`,
    `${detail.sentenceCount} 句`,
    detail.source,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const toggleAnswer = (questionNo: number): void => {
    setRevealed((current) =>
      current.includes(questionNo) ? current.filter((item) => item !== questionNo) : [...current, questionNo],
    );
  };

  return (
    <section className={wide ? "reader reader-split" : "reader"} data-reader-layout={wide ? "wide" : "narrow"}>
      <div className="reader-main">
        <header className="reader-head">
          {backButton}
          <div className="reader-headline">
            <h1 className="reader-title" data-testid="reader-title">
              {detail.title}
            </h1>
            <p className="reader-meta" data-testid="reader-meta">
              {meta}
            </p>
          </div>
        </header>

        <article className="reader-body" data-testid="reader-body">
          {content.paragraphs.map((paragraph) => (
            <p className="para" key={paragraph.idx} data-paragraph-idx={paragraph.idx}>
              {/* 段落级忠实切片：句间/句末空隙取 `paragraph.text`，否则英文正文会句子粘连 */}
              {renderParagraph(paragraph.text, paragraph.sentences).map((part) =>
                part.kind === "sentence" ? (
                  <Sentence
                    key={part.sentenceIndex}
                    sentence={paragraph.sentences[part.sentenceIndex]}
                    hasNote={noteMarks.sentenceIds.includes(paragraph.sentences[part.sentenceIndex].id)}
                    noteTokenIds={noteTokenIdSet}
                    onSelectSentence={(sentence) =>
                      setSelection({ kind: "sentence", id: sentence.id, text: sentence.text })
                    }
                    onSelectWord={(node) =>
                      setSelection({ kind: "word", id: node.tokenId ?? 0, normalized: node.normalized })
                    }
                    onSelectBlank={(blankNo) => setSelection({ kind: "blank", no: blankNo })}
                  />
                ) : (
                  part.text
                ),
              )}
            </p>
          ))}
        </article>

        {content.questions.length > 0 && (
          <section className="questions" data-testid="questions" data-question-count={content.questions.length}>
            {/* 默认折叠：<details> 不带 open 属性 */}
            <details>
              <summary className="questions-summary">题目（{content.questions.length}）</summary>
              <ol className="question-list">
                {content.questions.map((question) => {
                  const isRevealed = revealed.includes(question.idx);
                  const answerText =
                    question.answer === null
                      ? null
                      : question.options.find((option) => option.key === question.answer)?.text ?? null;
                  return (
                    <li className="question" key={question.idx} data-question-no={question.idx}>
                      <p className="question-stem">{question.stem}</p>
                      <ul className="options">
                        {question.options.map((option) => (
                          // 纯文本选项：不可点选、不显示对错、不渲染答案（04 §6.7 / AC6）
                          <li className="option" key={option.key} data-option-key={option.key}>
                            {option.key}. {option.text}
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="btn question-toggle"
                        onClick={() => toggleAnswer(question.idx)}
                        data-question-toggle={question.idx}
                      >
                        {isRevealed ? "收起答案" : "显示答案"}
                      </button>
                      {isRevealed ? (
                        question.answer === null ? (
                          <p className="question-answer" data-question-answer="none">
                            本题无预置答案
                          </p>
                        ) : (
                          <p className="question-answer" data-question-answer={question.answer}>
                            {question.answer}
                            {answerText ? `. ${answerText}` : ""}
                          </p>
                        )
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </details>
          </section>
        )}
      </div>

      <AnalysisPanel
        articleId={detail.id}
        selection={selection}
        onClose={closePanel}
        onNoteSaved={handleNoteSaved}
      />
    </section>
  );
}
