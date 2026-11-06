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
 * ponytail: 自己写 ~90 行而不是引 `use-debounce`/`react-query`（02 禁止引入状态库）；
 * 草稿用 ref + state 双份（ref 给 flush 用最新值，state 驱动输入框），不引外部 store。
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
  status: NoteSaveStatus;
  /** 最近一次保存是否触发了「三栏全空 → 删行」 */
  cleared: boolean;
  /** 编辑某一栏：写入草稿并安排 800ms 后保存 */
  change: (index: number, value: string) => void;
  /** 覆盖草稿（从库读出的笔记载入时用；不触发保存） */
  reset: (values: string[]) => void;
  /** 立即保存当前草稿（自动重试 / 手动重试共用） */
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

export function useDebouncedSave({
  targetKey,
  save,
  delayMs = NOTE_DEBOUNCE_MS,
  slots = 3,
}: UseDebouncedSaveOptions): DebouncedSaveController {
  const [values, setValues] = useState<string[]>(() => new Array(slots).fill("") as string[]);
  const [status, setStatus] = useState<NoteSaveStatus>("idle");
  const [cleared, setCleared] = useState(false);

  /** 最新草稿（flush 时读它，避免闭包旧值） */
  const draftRef = useRef<string[]>(values);
  /** 草稿所属目标（换目标时先用旧 key 保存旧草稿） */
  const keyRef = useRef<string>(targetKey);
  /** 是否有未落库的编辑 */
  const dirtyRef = useRef(false);
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
      setStatus("saving");
      void (async () => {
        try {
          const result = await saveRef.current(draft, key);
          dirtyRef.current = false;
          setStatus("saved");
          setCleared(Boolean(result?.deleted));
          // 成功不打扰：2s 后回 idle（「已保存」不弹提示）
          window.setTimeout(() => {
            setStatus((current) => (current === "saved" ? "idle" : current));
          }, 2000);
        } catch {
          // 失败保留草稿（values 不动）→ 输入框里的字不丢
          setStatus("error");
        }
      })();
    },
    [clearTimer],
  );

  const change = useCallback(
    (index: number, value: string) => {
      const next = draftRef.current.slice();
      while (next.length <= index) next.push("");
      next[index] = value;
      draftRef.current = next;
      setValues(next);
      setCleared(false);
      dirtyRef.current = true;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (dirtyRef.current) saveNow(keyRef.current, draftRef.current);
      }, delayMs);
    },
    [clearTimer, delayMs, saveNow],
  );

  const reset = useCallback(
    (next: string[]) => {
      clearTimer();
      const fitted = fitSlots(next, slotsRef.current);
      draftRef.current = fitted;
      setValues(fitted);
      setStatus("idle");
      setCleared(false);
      dirtyRef.current = false;
    },
    [clearTimer],
  );

  const flushNow = useCallback(() => {
    if (!dirtyRef.current) return;
    saveNow(keyRef.current, draftRef.current);
  }, [saveNow]);

  // 换目标：**先 flush 旧 key 的草稿再切**（useLayoutEffect 早于父组件的 useEffect 载入新值）
  useLayoutEffect(() => {
    if (keyRef.current === targetKey) return;
    const previousKey = keyRef.current;
    const previousDraft = draftRef.current;
    const previousDirty = dirtyRef.current;
    keyRef.current = targetKey;
    // 新目标的草稿由调用方 reset() 载入；这里只负责把旧目标未落库的编辑送出去
    dirtyRef.current = false;
    if (previousDirty && previousKey) saveNow(previousKey, previousDraft);
  }, [targetKey, saveNow]);

  // 卸载 / pagehide：同一个 flush（决策 N2-7：只有一条路径）
  useEffect(() => {
    const onPageHide = (): void => {
      if (dirtyRef.current) saveNow(keyRef.current, draftRef.current);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (dirtyRef.current) saveNow(keyRef.current, draftRef.current);
    };
  }, [saveNow]);

  return { values, status, cleared, change, reset, flushNow, retry: flushNow };
}
