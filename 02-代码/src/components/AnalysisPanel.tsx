/**
 * 解析面板容器（M2 D4 / AC7 / AC9；第 2 批补齐 D6~D8 挂载与抽屉拖动）。
 *
 * 硬要求：
 * - **选中态三者互斥**：`none` / `sentence` / `word` / `blank`（点词切换时句子卡必须消失）；
 * - `articleId` 由 `Reader` 经 props 传入（`get_blank_analysis` 需要它，选中态本身不带）；
 * - **宽屏（≥1100px）右栏**：与正文列组成 CSS `grid` 双列（`.reader-split`，见 app.css）。
 *   **不用 `position: fixed` 覆盖正文**（06 #6 边注节奏 / 决策 #17 / 评审 N-9）；
 * - **窄屏（<1100px）底部抽屉**：`max-height ≤ 55vh`、拖动条可调（键盘 ↑↓/Home/End 可用）、`Esc` 关闭；
 * - **面板状态 `data-panel-status` 三值**：`loading`（**进入查询即置**，显示骨架占位）/ `ready`
 *   （有结果**或**无结果的降级文案都算）/ `none`（未选中），承接 04 §九 骨架屏（评审 B-5 / N2-6）；
 * - 断点判定用 `matchMedia` + `useSyncExternalStore`，**不手写 resize 节流**；
 * - 三张卡各自由 `lib/analysis.ts` 的纯函数产出模型（一次判定/一次归一），本组件只负责查询与挂载。
 * - **收藏态（M3 D5）的唯一持有者就是本组件**：`selection.normalized` 只有这里拿得到
 *   （`WordCardModel` 无该字段、`WordCard` 无查库能力），所以「查是否已收藏」与「收藏/移出回调」
 *   都在这里做，经 `vocab` prop 下发给 `<WordCard>`；收藏成功用返回值就地改状态，**不重查全量**。
 *
 * 笔记 flush 的唯一路径是 `useDebouncedSave` 的 `targetKey`（换句/换词先 flush 旧值），
 * 本组件不另调 `flushNow()`（评审 N2-7）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  addVocabFromToken,
  deleteVocab,
  getBlankAnalysis,
  getSentenceAnalysis,
  getTokenAnalysis,
  getVocabByNormalized,
  lookupLexicon,
} from "../lib/api";
import { pickWordCard, toBlankCard, toSentenceCard } from "../lib/analysis";
import type { BlankCardModel, SentenceCardModel, WordCardModel } from "../lib/analysis";
import type { VocabEntry } from "../lib/types";
import { describeCommandError } from "../lib/vocab";
import { BlankCard } from "./BlankCard";
import { NoteEditor } from "./NoteEditor";
import { SentenceCard } from "./SentenceCard";
import { WordCard } from "./WordCard";

/** 选中态：**三者互斥**（词态可选带 `normalized`——`lookup_lexicon` 按它查全局词库，决策 #26） */
export type AnalysisSelection =
  | { kind: "none" }
  | { kind: "sentence"; id: number; text?: string }
  | { kind: "word"; id: number; normalized?: string }
  | { kind: "blank"; no: number };

/** `data-panel-status` 三值（AC7） */
export type PanelStatus = "none" | "loading" | "ready";

const WIDE_QUERY = "(min-width: 1100px)";

/** 抽屉高度区间（% 视口高）：上限 55vh 是 02 D4 的硬约束 */
const DRAWER_MIN_VH = 28;
const DRAWER_MAX_VH = 55;

function clampVh(value: number): number {
  return Math.min(DRAWER_MAX_VH, Math.max(DRAWER_MIN_VH, value));
}

function subscribeWide(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function readWide(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(WIDE_QUERY).matches;
}

/**
 * 断点判定（单一来源）：`matchMedia` + `useSyncExternalStore`。
 * `Reader` 也用它决定 `.reader-split` 是否双列，避免两处各判一次。
 */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribeWide, readWide, () => true);
}

export interface AnalysisPanelProps {
  /** 当前篇目（`get_blank_analysis` 需要；选中态本身不带） */
  articleId: number;
  selection: AnalysisSelection;
  onClose: () => void;
  /**
   * 笔记保存成功回调（TP-修复1 F3/F4）：`hasContent=false` 表示三栏已清空（行被删）。
   * 由 `Reader` 就地增量更新句/词标记，**不为一次标记变化再查一遍全篇**（AC-R3 一次 IPC）。
   */
  onNoteSaved?: (kind: "sentence" | "word", id: number, hasContent: boolean) => void;
  /**
   * 收藏 / 移出成功回调（M13 AC6②）：`added=false` 表示刚移出生词本。
   * 由 `Reader` 就地增量改正文层的 `data-in-vocab` 标记——
   * 用户点「加入生词本」后**不用重开文章**，词下面的线立刻出现（零额外 IPC）。
   */
  onVocabChange?: (normalized: string, added: boolean) => void;
}

/** 骨架占位：`loading` 时可见（不空白闪烁） */
function PanelSkeleton() {
  return (
    <div className="panel-skeleton" aria-hidden="true">
      <span className="skeleton-line" />
      <span className="skeleton-line skeleton-line-short" />
      <span className="skeleton-line" />
    </div>
  );
}

export function AnalysisPanel({ articleId, selection, onClose, onNoteSaved, onVocabChange }: AnalysisPanelProps) {
  const wide = useWideLayout();
  const [status, setStatus] = useState<PanelStatus>("none");
  const [sentenceCard, setSentenceCard] = useState<SentenceCardModel | null>(null);
  const [wordCard, setWordCard] = useState<WordCardModel | null>(null);
  const [blankCard, setBlankCard] = useState<BlankCardModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 收藏态（M3 D5）：**唯一持有者是本组件**——`WordCardModel` 没有 `normalized` 字段
   * （`analysis.ts` 的 `pickWordCard` 不产出它，`none` 态 `headword` 还是 null），
   * `WordCard` 也没有查库的能力，`selection.normalized` 只有这里拿得到。
   * `null` = 未收藏；非 null = 已收藏（同时持有 `id` 供「移出」用）。
   */
  const [vocabEntry, setVocabEntry] = useState<VocabEntry | null>(null);
  const [vocabBusy, setVocabBusy] = useState(false);
  const [vocabError, setVocabError] = useState<string | null>(null);
  const [drawerVh, setDrawerVh] = useState(DRAWER_MAX_VH);
  const dragRef = useRef<{ startY: number; startVh: number } | null>(null);

  // 原始值依赖：避免每次 render 的新对象（selection）把 effect 打成无限循环
  const sentenceId = selection.kind === "sentence" ? selection.id : null;
  const sentenceText = selection.kind === "sentence" ? selection.text ?? null : null;
  const wordId = selection.kind === "word" ? selection.id : null;
  const wordNormalized = selection.kind === "word" ? selection.normalized ?? null : null;
  const blankNo = selection.kind === "blank" ? selection.no : null;

  useEffect(() => {
    if (sentenceId === null && wordId === null && blankNo === null) {
      setStatus("none");
      setSentenceCard(null);
      setWordCard(null);
      setBlankCard(null);
      setVocabEntry(null);
      setVocabError(null);
      setError(null);
      return;
    }

    let cancelled = false;
    // 进入查询即 loading（02 D4 口径：>300ms 才「真实可见」，生产路径不加定时器）
    setStatus("loading");
    setSentenceCard(null);
    setWordCard(null);
    setBlankCard(null);
    // 换选中态即重置收藏态：别把上一个词的「已在生词本」带到新词上
    setVocabEntry(null);
    setVocabError(null);
    setError(null);

    const load = async (): Promise<void> => {
      if (sentenceId !== null) {
        const row = await getSentenceAnalysis(sentenceId);
        if (cancelled) return;
        setSentenceCard(toSentenceCard(row));
      } else if (wordId !== null) {
        const tokenAnalysis = await getTokenAnalysis(wordId);
        if (cancelled) return;
        // 决策 #26：词态可带 normalized（`token_analysis` 表无此列），缺它则词库查不到 → 降级 none
        const lexicon = wordNormalized ? await lookupLexicon(wordNormalized) : null;
        if (cancelled) return;
        // 收藏态（D5）：只查这一次（主键索引、毫秒级），**收藏后不再全量重查**。
        // 查询失败**降级成「未收藏」而不是让整张词卡报错**——词卡的主要职责是「读懂这个词」，
        // 收藏态是附加信息；退化成未收藏也不会写坏库（`add_vocab_from_token` 本身幂等）。
        const vocab = wordNormalized
          ? await getVocabByNormalized(wordNormalized).catch(() => null)
          : null;
        if (cancelled) return;
        setWordCard(pickWordCard(tokenAnalysis, lexicon));
        setVocabEntry(vocab);
      } else if (blankNo !== null) {
        const row = await getBlankAnalysis(articleId, blankNo);
        if (cancelled) return;
        setBlankCard(toBlankCard(row, blankNo));
      }
      if (!cancelled) setStatus("ready"); // 查无结果也是 ready（走降级文案）
    };

    load().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus("ready");
    });

    return () => {
      cancelled = true;
    };
  }, [articleId, sentenceId, wordId, wordNormalized, blankNo]);

  /**
   * Esc 统一出口（TP-修复1 F1 / AC-R1）：**只要面板有选中态就绑**——宽屏也绑。
   *
   * F0 实测（真实键 `Input.dispatchKeyEvent`，见 TP-修复1 自测 §一）：原先 `if (wide) return` 在宽屏根本不绑
   * listener，而宽屏是默认布局 → 用户按 Esc 毫无反应，这正是「Esc 关不掉解析」的根因；
   * 窄屏（含焦点停在笔记 textarea）真实键可达 window，**不需要** NoteEditor 再兜一层。
   *
   * 三个细节：
   * - `capture`：绕开输入框/弹层可能 `stopPropagation()` 的拦截，保证 Esc 一定能到；
   * - `isComposing`：中文输入法组合中按 Esc 是「撤销候选」，不该顺手把面板关掉；
   * - 关前不另写 flush：`onClose()` → `NoteEditor` 卸载 → `useDebouncedSave` 清理时 `flushAll()`（既有链路）。
   */
  useEffect(() => {
    if (status === "none") return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [status, onClose]);

  /**
   * 收藏（M3 D5）：`created` 真假**都置 added**——`created=false` 表示这个词已经在生词本里，
   * 对用户而言同样是「已在生词本」。**不重查库**（省一次 IPC，状态已由返回值给出，评审 N-6）。
   */
  const handleVocabAdd = useCallback((): void => {
    if (wordId === null || vocabBusy) return;
    setVocabBusy(true);
    setVocabError(null);
    void addVocabFromToken(wordId)
      .then((result) => {
        setVocabEntry(result.entry);
        // 正文层标记即时生效（M13 AC6②）：用返回值里的 normalized（聚合键），不是本次点击的 surface
        onVocabChange?.(result.entry.normalized, true);
      })
      .catch((err: unknown) => setVocabError(describeCommandError(err)))
      .finally(() => setVocabBusy(false));
  }, [wordId, vocabBusy, onVocabChange]);

  /** 移出（D5）：成功后置回 `none`（按钮变回「加入生词本」），失败保留 `added` 并提示可再试 */
  const handleVocabRemove = useCallback((): void => {
    const id = vocabEntry === null ? null : vocabEntry.id;
    // 先留住 normalized：delete 成功后 vocabEntry 会被置 null，之后就拿不到聚合键了
    const removedNorm = vocabEntry === null ? null : vocabEntry.normalized;
    if (id === null || vocabBusy) return;
    setVocabBusy(true);
    setVocabError(null);
    void deleteVocab(id)
      .then(() => {
        setVocabEntry(null);
        if (removedNorm !== null) onVocabChange?.(removedNorm, false);
      })
      .catch((err: unknown) => setVocabError(describeCommandError(err)))
      .finally(() => setVocabBusy(false));
  }, [vocabEntry, vocabBusy, onVocabChange]);

  // 窄屏未选中：不渲染抽屉（不占位、不挡正文）
  if (!wide && status === "none") return null;

  const hasSelection = status !== "none";

  // 拖动条：指针拖拽（±% 视口高）+ 键盘 ↑↓/Home/End（D10「拖动条 + 键盘可用」）
  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = { startY: event.clientY, startVh: drawerVh };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || !window.innerHeight) return;
    const deltaVh = ((drag.startY - event.clientY) / window.innerHeight) * 100;
    setDrawerVh(clampVh(drag.startVh + deltaVh));
  };
  const onHandlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowUp" ? 5 : event.key === "ArrowDown" ? -5 : 0;
    if (step) {
      event.preventDefault();
      setDrawerVh((current) => clampVh(current + step));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setDrawerVh(DRAWER_MAX_VH);
    } else if (event.key === "End") {
      event.preventDefault();
      setDrawerVh(DRAWER_MIN_VH);
    }
  };

  return (
    <aside
      className={wide ? "analysis-panel analysis-panel-wide" : "analysis-panel analysis-drawer"}
      style={wide ? undefined : { maxHeight: `${drawerVh}vh` }}
      data-panel-status={status}
      data-panel-vh={wide ? undefined : drawerVh}
      data-analysis-panel
      aria-label="解析面板"
    >
      {wide ? null : (
        <div
          className="drawer-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整解析面板高度"
          aria-valuemin={DRAWER_MIN_VH}
          aria-valuemax={DRAWER_MAX_VH}
          aria-valuenow={Math.round(drawerVh)}
          tabIndex={0}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          onKeyDown={onHandleKeyDown}
          data-drawer-handle
        >
          <span className="drawer-handle-bar" aria-hidden="true" />
        </div>
      )}

      <header className="panel-head">
        <span className="panel-title">解析</span>
        {hasSelection ? (
          <button type="button" className="btn panel-close" onClick={onClose} data-panel-close>
            关闭
          </button>
        ) : null}
      </header>

      {status === "none" ? (
        <p className="panel-hint">点句子、词或空格看解析。</p>
      ) : status === "loading" ? (
        <PanelSkeleton />
      ) : error ? (
        <p className="panel-error" role="alert">
          读不到解析：{error}
        </p>
      ) : (
        <div className="panel-body">
          {sentenceCard ? (
            <>
              <SentenceCard card={sentenceCard} text={sentenceText ?? undefined} />
              {sentenceId !== null ? (
                <NoteEditor
                  targetKind="sentence"
                  targetId={sentenceId}
                  onSaved={(hasContent) => onNoteSaved?.("sentence", sentenceId, hasContent)}
                />
              ) : null}
            </>
          ) : null}

          {wordCard ? (
            <>
              <WordCard
                card={wordCard}
                vocab={{
                  normalized: wordNormalized,
                  vocabState: vocabEntry === null ? "none" : "added",
                  busy: vocabBusy,
                  error: vocabError,
                  onAdd: handleVocabAdd,
                  onRemove: handleVocabRemove,
                }}
              />
              {wordId !== null ? (
                <NoteEditor
                  targetKind="word"
                  targetId={wordId}
                  onSaved={(hasContent) => onNoteSaved?.("word", wordId, hasContent)}
                />
              ) : null}
            </>
          ) : null}

          {blankCard ? <BlankCard card={blankCard} /> : null}
        </div>
      )}
    </aside>
  );
}
