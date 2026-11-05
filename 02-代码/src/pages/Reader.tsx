/**
 * 精读页（M1 只读渲染 / 05 §四）：逐段逐句 + 词/空格节点 + 题目折叠区 + 返回。
 *
 * 硬要求（AC6 / AC7）：
 * - 词节点 `data-token-id` / `data-n` / `data-start`，空格节点 `data-blank-no`，**属性名不得改**（M2 起依赖）。
 * - 空格判定走 `renderTokens` 纯函数（`isWord === false` ∧ 纯数字 ∧ ∈ blankNos），固有数字不得误判。
 * - 题目区**默认折叠**（原生 `<details>`），选项是纯文本 `<li>`（**不可点、不渲染答案**——M2 才做交互）。
 * - 返回接路由历史（AC7 三态见 routes.tsx 的 `useReturn`）。
 *
 * ponytail: 整篇一次渲染（274 句上限，长文 1208 token 纯函数 < 50ms 已实测），不做虚拟滚动；
 * 等真的出现「万字级用户导入篇 + 卡顿」再上分段渲染（renderTokens 的节点契约不变）。
 */
import { useEffect, useState } from "react";
import { getArticleContent } from "../lib/api";
import { renderTokens } from "../lib/render";
import type { ApiSentence, ArticleContent } from "../lib/types";
import { useReturn, useRoute } from "../shell/routes";

/** 一句：纯函数切分成 text / word / blank 三类节点，按原顺序摊平（间隙文本原样保留空格） */
function Sentence({ sentence }: { sentence: ApiSentence }) {
  const nodes = renderTokens(sentence.text, sentence.tokens, sentence.blankNos);
  return (
    <span className="sentence" data-sentence-idx={sentence.idx}>
      {nodes.map((node, index) => {
        if (node.kind === "word") {
          return (
            <span
              key={index}
              className="tok"
              data-token-id={node.tokenId}
              data-n={node.normalized}
              data-start={node.start}
            >
              {node.text}
            </span>
          );
        }
        if (node.kind === "blank") {
          return (
            <span
              key={index}
              className="blank"
              data-blank-no={node.blankNo}
              data-token-id={node.tokenId}
              data-start={node.start}
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

  return (
    <section className="reader">
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
            {paragraph.sentences.map((sentence) => (
              <Sentence key={sentence.idx} sentence={sentence} />
            ))}
          </p>
        ))}
      </article>

      {content.questions.length > 0 && (
        <section className="questions" data-testid="questions" data-question-count={content.questions.length}>
          {/* 默认折叠：<details> 不带 open 属性 */}
          <details>
            <summary className="questions-summary">题目（{content.questions.length}）</summary>
            <ol className="question-list">
              {content.questions.map((question) => (
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
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
    </section>
  );
}
