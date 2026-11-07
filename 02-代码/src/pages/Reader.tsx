/**
 * 精读页（M1 只读渲染 + M2 交互接线 / 05 §四 / D9）。
 *
 * 硬要求（AC6 / AC7 / AC9 / AC10）：
 * - 词节点 `data-token-id` / `data-n` / `data-start`，空格节点 `data-blank-no`，句节点 `data-sentence-idx`
 *   ——M1 冻结的属性名**只加不改**（M2 新增 `data-sentence-id` 与 `data-question-answer`；
 *   M3 D6 新增只读消费的 `data-highlight="1"`，只在 2s 高亮期间出现）。
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
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnalysisPanel, useWideLayout } from "../components/AnalysisPanel";
import { ArticleEditor } from "../components/ArticleEditor";
import type { AnalysisSelection } from "../components/AnalysisPanel";
import { completeReview, getArticleContent, getArticleNoteMarks, getReviewPlan, markArticleCompleted, touchReading } from "../lib/api";
import { renderParagraph, renderTokens } from "../lib/render";
import type { TokenNode } from "../lib/render";
import type { ApiSentence, ArticleContent, NoteMarks, ReviewPlan, ReviewResult } from "../lib/types";
import { localToday } from "../lib/date";
import { useReturn, useRoute } from "../shell/routes";

/** 点回原句的高亮停留时长（AC5：2 秒后自动消退） */
const HIGHLIGHT_MS = 2000;

/**
 * 点回原句的高亮状态（D6）。
 * `seq` 是自增序号：**同一句被连点两次时 state 值不变**，React 不会重渲染，
 * 2s 定时器也就不会重置；带上序号每次都是新对象，计时重新开始。
 */
interface HighlightState {
  sentenceId: number;
  /** `?token=` 指定的词（可选；生产路径目前只带 `sentence`，见 `lib/vocab.ts` 的 `vocabSourceHref`） */
  tokenId: number | null;
  seq: number;
}

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
  /** 本句是否处于「点回原句」的 2s 高亮（AC5）→ `data-highlight="1"` + `.sentence-flash` */
  highlighted: boolean;
  /** 要高亮的词 id（`?token=`，可选；null = 只高亮整句） */
  highlightTokenId: number | null;
  onSelectSentence: (sentence: ApiSentence) => void;
  onSelectWord: (node: TokenNode) => void;
  onSelectBlank: (blankNo: number) => void;
}

/** 一句：纯函数切分成 text / word / blank 三类节点，按原顺序摊平（间隙文本原样保留空格） */
function Sentence({
  sentence,
  hasNote,
  noteTokenIds,
  highlighted,
  highlightTokenId,
  onSelectSentence,
  onSelectWord,
  onSelectBlank,
}: SentenceProps) {
  const nodes = renderTokens(sentence.text, sentence.tokens, sentence.blankNos);

  return (
    <span
      className={highlighted ? "sentence sentence-flash" : "sentence"}
      data-sentence-idx={sentence.idx}
      data-sentence-id={sentence.id}
      data-highlight={highlighted ? "1" : undefined}
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
          const tokenHighlighted = highlightTokenId !== null && node.tokenId === highlightTokenId;
          return (
            <span
              key={index}
              className={tokenHighlighted ? "tok tok-flash" : "tok"}
              data-token-id={node.tokenId}
              data-n={node.normalized}
              data-start={node.start}
              data-highlight={tokenHighlighted ? "1" : undefined}
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
  // 点回原句参数（D6）：从 hash 的 query 取；**消费时机见下方的定位 effect**（必须等 content 就绪）
  const sentenceParam = route.query.get("sentence");
  const tokenParam = route.query.get("token");
  /**
   * 复习模式（M4 D4 / 决策 #6、#10 裁定 10）：`#/article/<id>?mode=review`。
   * **只影响呈现**（隐藏笔记提示与生词收藏按钮、底部换成复习按钮），**不影响** `?sentence=`/`?token=` 高亮（N7）。
   */
  const reviewMode = route.query.get("mode") === "review";
  /** 本地 today（复习写路径的日期由前端传，02 日期来源禁令） */
  const today = useRef(localToday());
  const [content, setContent] = useState<ArticleContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<AnalysisSelection>({ kind: "none" });
  /** M5c D4/D5：编辑面板开关 + 保存后的标题覆盖（避免重拉整篇） */
  const [editorOpen, setEditorOpen] = useState(false);
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<number[]>([]);
  /** 本篇笔记标记（F4/AC-R3）：一次 IPC 全量取，句末角标与词节点据此打 `data-has-note` */
  const [noteMarks, setNoteMarks] = useState<NoteMarks>({ sentenceIds: [], tokenIds: [] });
  const wide = useWideLayout();

  // M6 · AC4 阅读埋点：进入写一次 `last_read_at`，离开时累加 `duration_sec` 并记下位置。
  // **重复进出累加**（后端 `duration_sec = duration_sec + ?`），换篇目时先结算旧篇。
  useEffect(() => {
    if (!articleId) return;
    void touchReading(articleId, "", 0).catch(() => {
      // 埋点失败不影响阅读（不弹错、不阻塞正文）
    });
    const startedAt = Date.now();
    return () => {
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const position = `${Math.round(window.scrollY)}`;
      void touchReading(articleId, position, seconds).catch((err: unknown) => {
        console.warn("记录阅读进度失败", err);
      });
    };
  }, [articleId]);

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
  /** 非复习模式的「完成本篇」按钮反馈（D5）：null = 还没点过 */
  const [completedHint, setCompletedHint] = useState<string | null>(null);
  /** 复习模式的写操作状态（D4） */
  const [reviewSaving, setReviewSaving] = useState<ReviewResult | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [savedPlan, setSavedPlan] = useState<ReviewPlan | null>(null);

  /** 进复习模式时先读一次计划：给底部条一个「当前第几档」的上下文，失败不阻塞复习 */
  useEffect(() => {
    if (!reviewMode || !articleId) {
      setSavedPlan(null);
      return;
    }
    let cancelled = false;
    getReviewPlan(articleId)
      .then((plan) => {
        if (!cancelled) setSavedPlan(plan);
      })
      .catch(() => {
        if (!cancelled) setSavedPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewMode, articleId]);

  /** AC7：复习完回列表（列表页自己重新取数，角标也会随路由刷新） */
  const backToReviewList = useCallback((): void => {
    window.location.hash = "#/review";
  }, []);

  const handleCompleteArticle = useCallback((): void => {
    if (!articleId) return;
    setCompletedHint("正在加入…");
    markArticleCompleted(articleId, today.current)
      .then((plan) => {
        // 幂等：已有计划时 `nextReviewAt` 不是明天（说明早就排过），文案据实说
        setCompletedHint(
          plan.intervalIndex === 0 ? "已加入复习计划（明天到期）" : `已在复习计划中（${plan.nextReviewAt} 到期）`,
        );
      })
      .catch((err: unknown) => setCompletedHint(err instanceof Error ? err.message : String(err)));
  }, [articleId]);

  const handleReviewResult = useCallback(
    (result: ReviewResult): void => {
      if (!articleId) return;
      setReviewSaving(result);
      setReviewError(null);
      completeReview(articleId, result, today.current)
        .then((plan) => {
          setSavedPlan(plan);
          backToReviewList();
        })
        .catch((err: unknown) => setReviewError(err instanceof Error ? err.message : String(err)))
        .finally(() => setReviewSaving(null));
    },
    [articleId, backToReviewList],
  );

  const closePanel = useCallback((): void => {
    const sentenceId = selection.kind === "sentence" ? selection.id : null;
    setSelection({ kind: "none" });
    if (sentenceId !== null) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-sentence-id="${sentenceId}"]`)?.focus();
      });
    }
  }, [selection]);

  /** 点回原句的 2s 高亮（D6）：null = 无高亮 */
  const [highlight, setHighlight] = useState<HighlightState | null>(null);
  const highlightSeq = useRef(0);

  /**
   * 消费 `?sentence=` / `?token=`：滚动到该句并高亮（D6 / AC5）。
   *
   * **必须在 `content` 就绪之后消费**（02 评审 N-7）：内容还没加载时正文节点根本不存在，
   * 早读 query 会 `querySelector` 到 null 并静默失效——本文件 227-229 行已为同类问题留过警告。
   *
   * **fail-safe（AC5 断言 `scrollTop` 前后不变）**：参数不是正整数 / 该句不属于本篇 / 找不到节点
   * → **不滚动、不报错、停留原位**，绝不 `scrollTo(0)` 或跳到顶部。
   */
  useEffect(() => {
    if (!content) return;
    if (sentenceParam === null) return;
    const sentenceId = Number(sentenceParam);
    if (!Number.isInteger(sentenceId) || sentenceId <= 0) return;
    // 「属于本篇」按内容数据判定（DOM 里没有就等于不属于，不必再猜）
    const owned = content.paragraphs.some((paragraph) =>
      paragraph.sentences.some((sentence) => sentence.id === sentenceId),
    );
    if (!owned) return;
    const node = document.querySelector<HTMLElement>(`[data-sentence-id="${sentenceId}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    const parsedTokenId = tokenParam === null ? null : Number(tokenParam);
    highlightSeq.current += 1;
    setHighlight({
      sentenceId,
      // `Number.isInteger` 不是 TS 的类型守卫，这里先判 null 再判正整数（`?token=` 只是可选加强）
      tokenId: parsedTokenId !== null && Number.isInteger(parsedTokenId) && parsedTokenId > 0 ? parsedTokenId : null,
      seq: highlightSeq.current,
    });
  }, [content, sentenceParam, tokenParam]);

  // 高亮 2s 后自动消退；卸载或再次跳转时清定时器（不泄漏——切页后不留 setTimeout）
  useEffect(() => {
    if (highlight === null) return undefined;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

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
    <section
      className={wide ? "reader reader-split" : "reader"}
      data-reader-layout={wide ? "wide" : "narrow"}
      /* 复习模式标记（D4 / 决策 #10）：挂**成功态主容器**，不挂错误态（395/406，均为失败分支的 reader 容器）与题目区（485） */
      data-review-mode={reviewMode ? "1" : undefined}
    >
      <div className="reader-main">
        <header className="reader-head">
          {backButton}
          <div className="reader-headline">
            <h1 className="reader-title" data-testid="reader-title">
              {titleOverride ?? detail.title}
            </h1>
            <p className="reader-meta" data-testid="reader-meta">
              {meta}
            </p>
          </div>
          {/* M5b D4：精读页页头的「补全解析」入口（AC9）→ 跳 `#/import?articleId=<id>`（patch 模式） */}
          <a
            className="link-btn reader-patch"
            data-ai-patch
            data-article-id={content.article.id}
            href={`#/import?articleId=${content.article.id}`}
          >
            补全解析
          </a>
          {/* M5c D4：编辑入口（AC9/AC10）→ 打开 ArticleEditor（元信息 + 题目） */}
          <button
            type="button"
            className="link-btn reader-edit"
            data-article-edit
            data-article-id={content.article.id}
            onClick={() => setEditorOpen(true)}
          >
            编辑
          </button>
        </header>

        {/* M5c D5：编辑面板（元信息 + 题目），保存后只覆盖标题与题目，不重拉整篇 */}
        {editorOpen && (
          <ArticleEditor
            articleId={content.article.id}
            initialTitle={titleOverride ?? detail.title}
            initialExamYear={detail.examYear ?? null}
            initialSectionLabel={detail.sectionLabel ?? null}
            onClose={() => setEditorOpen(false)}
            onSaved={({ title }) => setTitleOverride(title)}
          />
        )}

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
                    highlighted={
                      highlight !== null && highlight.sentenceId === paragraph.sentences[part.sentenceIndex].id
                    }
                    highlightTokenId={highlight === null ? null : highlight.tokenId}
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

        {/* 底部动作区（D4/D5）：**同一位置二选一，不并存**——复习模式给「完成复习 / 还需再看」，
            普通模式给「完成本篇」。不自动触发（必须显式点击，避免滚动到底就误判完成）。 */}
        {reviewMode ? (
          <div className="review-actions" data-review-actions>
            <p className="review-actions-hint">复习模式已隐藏笔记标记与生词收藏按钮。</p>
            {savedPlan && (
              <p className="review-actions-step">
                当前档位：第 {Math.min(savedPlan.intervalIndex + 1, 4)}/4 次
              </p>
            )}
            <div className="review-actions-buttons">
              <button
                type="button"
                className="btn btn-primary"
                data-review-action="done"
                disabled={reviewSaving !== null}
                onClick={() => handleReviewResult("done")}
              >
                {reviewSaving === "done" ? "记录中…" : "完成复习"}
              </button>
              <button
                type="button"
                className="btn"
                data-review-action="need_more"
                disabled={reviewSaving !== null}
                onClick={() => handleReviewResult("need_more")}
              >
                {reviewSaving === "need_more" ? "记录中…" : "还需再看"}
              </button>
            </div>
            {reviewError && (
              <p className="review-actions-error" role="alert">
                {reviewError}
              </p>
            )}
          </div>
        ) : (
          <div className="mark-complete" data-mark-complete-area>
            <button type="button" className="btn btn-primary" data-mark-complete onClick={handleCompleteArticle}>
              完成本篇
            </button>
            {completedHint && (
              <p className="mark-complete-hint" data-mark-complete-hint>
                {completedHint}
              </p>
            )}
          </div>
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
