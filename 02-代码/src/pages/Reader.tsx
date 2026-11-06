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
import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnalysisPanel, useWideLayout } from "../components/AnalysisPanel";
import type { AnalysisSelection } from "../components/AnalysisPanel";
import { getArticleContent } from "../lib/api";
import { renderParagraph, renderTokens } from "../lib/render";
import type { TokenNode } from "../lib/render";
import type { ApiSentence, ArticleContent } from "../lib/types";
import { useReturn, useRoute } from "../shell/routes";

/** 触发键：Enter 与 Space（AC10「Enter/Space 能触发同一卡片」） */
function isActivationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}

interface SentenceProps {
  sentence: ApiSentence;
  onSelectSentence: (sentence: ApiSentence) => void;
  onSelectWord: (node: TokenNode) => void;
  onSelectBlank: (blankNo: number) => void;
}

/** 一句：纯函数切分成 text / word / blank 三类节点，按原顺序摊平（间隙文本原样保留空格） */
function Sentence({ sentence, onSelectSentence, onSelectWord, onSelectBlank }: SentenceProps) {
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

      <AnalysisPanel articleId={detail.id} selection={selection} onClose={() => setSelection({ kind: "none" })} />
    </section>
  );
}
