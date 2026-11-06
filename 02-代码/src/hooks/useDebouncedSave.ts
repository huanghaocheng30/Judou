/**
 * 笔记保存 hook（M2 D8 / AC8）：800ms 防抖 + 换目标先 flush + 卸载/pagehide flush + 失败保留草稿。
 *
 * 三条硬要求（02 D8 / 评审 N-12 / N2-7）：
 * 1. **唯一 flush 入口**：`targetKey` 变化时由本 hook 先 flush 旧目标的草稿再切；
 *    `AnalysisPanel` 换句只改 props、组件不卸载，只靠 effect cleanup 会丢最后一段输入。
 *    `Reader` 不另调 `flushNow()`（避免双实现）。
 * 2. **卸载 / `pagehide` 同调一个 flush**（同一份逻辑，不分叉）。
 * 3. **失败不静默丢**：`error` 状态 + 草稿留在输入框 + 下次输入自动重试；`retry()` 手动重试。
 *
 * 状态机：`idle → saving → saved`（2s 后回 `idle`，成功不打扰）/ `saving → error`（草稿保留）。
 * 三栏 TRIM 后全空 → 后端走 DELETE，返回 `deleted=true` → UI 显示「已清空」。
 *
 * **按目标保存的草稿（per-key pending，2026-11-06 审查 B-1 / R-1 收口）**：
 * 未落库的草稿存在 `pendingRef: Map<targetKey, string[]>` 里，**只有保存成功才删除**。
 * 因此：
 * - 换目标时**不清旧目标的 pending**——旧目标写失败后草稿仍可在切回时恢复并由「点此重试」重试；
 * - `status` / `cleared` 都带 `key`，**错误只归属它所属的目标**（不会显示在新目标上）；
 * - `reset()`（从库读回笔记载入时调用）**优先用 pending 草稿**——库里的值可能是保存失败前的旧值；
 *   若该目标有 pending，`reset` 同时把状态置回 `error`（让「点此重试」可见）。
 *
 * ponytail: 自己写 ~120 行而不是引 `use-debounce`/`react-query`（02 禁止引入状态库）；
 * 草稿用 ref（flush 读最新值）+ state（驱动输入框）双份，pending 用一张 Map，不引外部 store。
 * 天花板：单进程内存态，切换/关闭标签页后 pending 丢失（已由 `pagehide` flush 兜住）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NoteUpsertResult } from "../lib/types";

/** `data-note-status` 四值（AC8 断言口径） */
export type NoteSaveStatus = "idle" | "saving" | "saved" | "error";

/** 默认防抖时长（02 D8：停止输入 800ms 自动落库） */
export const NOTE_DEBOUNCE_MS = 800;

export interface UseDebouncedSaveOptions {
  /** 目标标识（如 `sentence:12` / `word:345`）；变化即 flush 旧值 */
  targetKey: string;
  /**
   * 保存实现：**必须接受 targetKey 形参**——换目标时本 hook 用「旧 key + 旧草稿」调它。
   * 若 save 闭包自己捕获 id，就会把旧目标的草稿写进新目标（2026-11-06 CDP 实测的真实缺陷）。
   * 返回值里的 `deleted` 用于「已清空」提示。
   */
  save: (values: string[], targetKey: string) => Promise<NoteUpsertResult>;
  /** 防抖毫秒，默认 {@link NOTE_DEBOUNCE_MS} */
  delayMs?: number;
  /** 初始栏位数（句子 3 / 词 3），默认 3 */
  slots?: number;
}

export interface DebouncedSaveController {
  /** 当前草稿（受控输入值） */
  values: string[];
  /** 当前目标的状态（别的目标的 error 不会显示在这里） */
  status: NoteSaveStatus;
  /** 当前目标最近一次保存是否触发了「三栏全空 → 删行」 */
  cleared: boolean;
  /** 编辑某一栏：写入草稿并安排 800ms 后保存 */
  change: (index: number, value: string) => void;
  /** 覆盖草稿（从库读出的笔记载入时用；**若该目标有未落库草稿则优先用草稿**） */
  reset: (values: string[]) => void;
  /** 立即保存当前目标的未落库草稿（自动重试 / 手动重试共用） */
  flushNow: () => void;
  /** 手动重试（等价 flushNow，供「保存失败，点此重试」用） */
  retry: () => void;
}

/** 把 3 栏草稿补齐/截断到固定长度（避免稀疏数组写库） */
function fitSlots(values: string[], slots: number): string[] {
  const next = values.slice(0, slots);
  while (next.length < slots) next.push("");
  return next;
}

/**
 * **模块级未落库草稿**：`targetKey → 草稿`。放模块作用域而不是组件 ref ——
 * 关闭解析面板 / 切换卡片会让 `NoteEditor` **卸载**，若 pending 跟着组件销毁，
 * 「写失败后关面板再打开」的草稿就丢了（2026-11-06 审查 B-1 / R-1 的延伸场景）。
 * 只有保存成功才删；不同目标用 key 区分，互不覆盖。
 */
const PENDING_DRAFTS = new Map<string, string[]>();

export function useDebouncedSave({
  targetKey,
  save,
  delayMs = NOTE_DEBOUNCE_MS,
  slots = 3,
}: UseDebouncedSaveOptions): DebouncedSaveController {
  const [values, setValues] = useState<string[]>(() => new Array(slots).fill("") as string[]);
  /** 状态带 key：只显示「属于当前目标」的状态 */
  const [statusState, setStatusState] = useState<{ key: string; status: NoteSaveStatus }>({
    key: targetKey,
    status: "idle",
  });
  const [clearedState, setClearedState] = useState<{ key: string; value: boolean }>({ key: targetKey, value: false });

  /** 最新草稿（flush 时读它，避免闭包旧值） */
  const draftRef = useRef<string[]>(values);
  /** 草稿所属目标（换目标时先用旧 key 保存旧草稿） */
  const keyRef = useRef<string>(targetKey);
  const timerRef = useRef<number | null>(null);
  const saveRef = useRef(save);
  const slotsRef = useRef(slots);

  saveRef.current = save;
  slotsRef.current = slots;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const saveNow = useCallback(
    (key: string, draft: string[]) => {
      if (!key) return;
      clearTimer();
      setStatusState({ key, status: "saving" });
      void (async () => {
        try {
          const result = await saveRef.current(draft, key);
          // **只有成功才清 pending**：失败时草稿必须留给「切回旧目标 / 点此重试」
          PENDING_DRAFTS.delete(key);
          if (keyRef.current !== key) return; // 已切走：不改当前目标的状态
          setStatusState({ key, status: "saved" });
          setClearedState({ key, value: Boolean(result?.deleted) });
          // 成功不打扰：2s 后回 idle（「已保存」不弹提示）
          window.setTimeout(() => {
            setStatusState((current) =>
              current.key === key && current.status === "saved" ? { key, status: "idle" } : current,
            );
          }, 2000);
        } catch {
          // 失败：pending 保留（草稿绝不丢），错误归属这个 key
          setStatusState({ key, status: "error" });
        }
      })();
    },
    [clearTimer],
  );

  const change = useCallback(
    (index: number, value: string) => {
      const key = keyRef.current;
      const next = draftRef.current.slice();
      while (next.length <= index) next.push("");
      next[index] = value;
      draftRef.current = next;
      setValues(next);
      PENDING_DRAFTS.set(key, next); // 编辑即 pending，直到保存成功
      setClearedState({ key, value: false });
      setStatusState({ key, status: "idle" }); // 新输入 → 清掉旧的 error 展示（即将重试）
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const pendingDraft = PENDING_DRAFTS.get(key);
        if (pendingDraft) saveNow(key, pendingDraft);
      }, delayMs);
    },
    [clearTimer, delayMs, saveNow],
  );

  const reset = useCallback(
    (next: string[]) => {
      clearTimer();
      const key = keyRef.current;
      const pendingDraft = PENDING_DRAFTS.get(key);
      // **pending 优先**：库里的值可能是保存失败前的旧值，不能让 reset 把草稿覆盖掉
      const fitted = fitSlots(pendingDraft ?? next, slotsRef.current);
      draftRef.current = fitted;
      setValues(fitted);
      setClearedState({ key, value: false });
      // 有未落库草稿 → 保留 error（让「点此重试」可见）；否则回到 idle
      setStatusState({ key, status: pendingDraft ? "error" : "idle" });
    },
    [clearTimer],
  );

  const flushNow = useCallback(() => {
    const key = keyRef.current;
    const draft = PENDING_DRAFTS.get(key);
    if (!draft) return;
    saveNow(key, draft);
  }, [saveNow]);

  // 换目标：**只 flush 旧 key，绝不清它的 pending**（旧草稿要能在切回时恢复/重试）
  // useLayoutEffect 早于父组件的 useEffect（载入新目标笔记）执行，保证「先 flush 旧值再切」。
  useLayoutEffect(() => {
    if (keyRef.current === targetKey) return;
    const previousKey = keyRef.current;
    keyRef.current = targetKey;
    const previousPending = PENDING_DRAFTS.get(previousKey);
    if (previousPending) saveNow(previousKey, previousPending);
  }, [targetKey, saveNow]);

  // 卸载 / pagehide：把**所有**未落库草稿送出去（同一份逻辑，不分叉）
  useEffect(() => {
    const flushAll = (): void => {
      for (const [key, draft] of PENDING_DRAFTS) saveNow(key, draft);
    };
    const onPageHide = (): void => flushAll();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushAll();
    };
  }, [saveNow]);

  const status: NoteSaveStatus = statusState.key === targetKey ? statusState.status : "idle";
  const cleared = clearedState.key === targetKey ? clearedState.value : false;

  return { values, status, cleared, change, reset, flushNow, retry: flushNow };
}
