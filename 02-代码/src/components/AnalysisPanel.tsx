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
 *
 * 笔记 flush 的唯一路径是 `useDebouncedSave` 的 `targetKey`（换句/换词先 flush 旧值），
 * 本组件不另调 `flushNow()`（评审 N2-7）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { getBlankAnalysis, getSentenceAnalysis, getTokenAnalysis, lookupLexicon } from "../lib/api";
import { pickWordCard, toBlankCard, toSentenceCard } from "../lib/analysis";
import type { BlankCardModel, SentenceCardModel, WordCardModel } from "../lib/analysis";
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

export function AnalysisPanel({ articleId, selection, onClose }: AnalysisPanelProps) {
  const wide = useWideLayout();
  const [status, setStatus] = useState<PanelStatus>("none");
  const [sentenceCard, setSentenceCard] = useState<SentenceCardModel | null>(null);
  const [wordCard, setWordCard] = useState<WordCardModel | null>(null);
  const [blankCard, setBlankCard] = useState<BlankCardModel | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
      return;
    }

    let cancelled = false;
    // 进入查询即 loading（02 D4 口径：>300ms 才「真实可见」，生产路径不加定时器）
    setStatus("loading");
    setSentenceCard(null);
    setWordCard(null);
    setBlankCard(null);
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
        setWordCard(pickWordCard(tokenAnalysis, lexicon));
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

  // 窄屏抽屉：Esc 关闭（宽屏右栏常驻，不劫持 Esc）
  useEffect(() => {
    if (wide || status === "none") return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, status, onClose]);

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
              {sentenceId !== null ? <NoteEditor targetKind="sentence" targetId={sentenceId} /> : null}
            </>
          ) : null}

          {wordCard ? (
            <>
              <WordCard card={wordCard} />
              {wordId !== null ? <NoteEditor targetKind="word" targetId={wordId} /> : null}
            </>
          ) : null}

          {blankCard ? <BlankCard card={blankCard} /> : null}
        </div>
      )}
    </aside>
  );
}
