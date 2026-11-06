/**
 * M4 · 复习顺延规则（D2 纯函数层）——**只有预览权，没有权威**。
 *
 * 顺延规则的**权威实现是 Rust 的 `src-tauri/src/review.rs`**（写库在那里）。本文件只服务于
 * 「乐观 UI 预览」：点「完成复习」后立刻算出下一档并渲染，等后端返回再以服务端值为准。
 *
 * 漂移防线（02 §五 风险表）：两份实现必须跑**同一组用例**——`scripts/verify-review.mjs` 的 E 段
 * 用 today=2026-11-06 走 0→1→2→3→done 四档，与 Rust 单测
 * `due_filter_order_and_four_step_advance` 逐项对照。**TS 侧不得出现 Rust 没有的分支**。
 *
 * 约束（02 D2）：**不 import React/DOM**、不用 `enum` / `namespace` / 参数属性——
 * 否则 `node --test`（Node 24 类型擦除）直 import 本文件不成立。
 *
 * ponytail: 日期只做「定长 YYYY-MM-DD 字符串」的日历加天，不引 date-fns/dayjs。
 * 天花板：出现时区/夏令时/工作日规则时换 `Temporal`（或 dayjs 插件），调用方签名不变。
 */

/** 四档间隔（天）：`INTERVALS[index]` = 「已完成 index 次后，下次隔几天」。与 Rust `review.rs::INTERVALS` 同表。 */
export const INTERVALS = [1, 3, 7, 14] as const;

/** 四档全部走完所需的完成次数（index=3 再完成一次 → status='done'）。与 Rust `MAX_INTERVAL_INDEX` 同值。 */
export const MAX_INTERVAL_INDEX = 3;

/** 计划状态（与 `types.ts` 的 `ReviewPlanStatus` 同集合；这里不 import 是为了保持纯函数文件零依赖） */
export type PlanStatus = "active" | "paused" | "done";

/** 复习结果 */
export type Result = "done" | "need_more";

/** 计划的可计算部分（不要求带 `updatedAt`：预览时它还没变） */
export interface PlanState {
  index: number;
  nextReviewAt: string;
  status: PlanStatus;
}

/** 到期判断只需这两列（`ReviewPlan` 与 `DueReview` 都满足） */
export interface DueShape {
  nextReviewAt: string;
  status: string;
}

/** 第 index 档的间隔天数；`index` 越界（<0、>=4、非整数）返回 null，**不猜一个值** */
export function nextInterval(index: number): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= INTERVALS.length) return null;
  return INTERVALS[index];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` → 毫秒（按 UTC 解析，避免本地时区把日期推过午夜；本例只用于求天数差） */
function toUtcMs(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

/** 日历加天：月末、闰年、跨年都要对（与 Rust `review.rs::add_days` 同口径） */
export function addDays(today: string, days: number): string {
  const ms = toUtcMs(today);
  if (ms === null) return today;
  const next = new Date(ms + days * DAY_MS);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const d = String(next.getUTCDate()).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${m}-${d}`;
}

/**
 * 顺延一档（**乐观预览**，权威在 Rust）。
 *
 * - `done`：`index+1`；走完四档（新 index > 3）→ `status='done'` 且 `nextReviewAt` **写死为 today**；
 *   否则 `nextReviewAt = today + INTERVALS[newIndex]`；
 * - `need_more`：`index` **不前进**、`nextReviewAt = today + 1`、保持 `active`。
 */
export function advance(state: PlanState, result: Result, today: string): PlanState {
  if (result === "need_more") {
    return { index: state.index, nextReviewAt: addDays(today, 1), status: "active" };
  }
  const index = state.index + 1;
  if (index > MAX_INTERVAL_INDEX) {
    return { index, nextReviewAt: today, status: "done" };
  }
  const step = INTERVALS[index];
  return { index, nextReviewAt: addDays(today, step), status: "active" };
}

/** 是否今天到期：只有 `active` 且 `nextReviewAt <= today`（`done`/`paused` 一律不算） */
export function isDue(plan: DueShape, today: string): boolean {
  if (plan.status !== "active") return false;
  const due = toUtcMs(plan.nextReviewAt);
  const now = toUtcMs(today);
  if (due === null || now === null) return false;
  return due <= now;
}

/**
 * 到期标签：「今天」/「明天」/「逾期 N 天」/「N 天后」。
 *
 * 用毫秒差算天数差（不是字符串比大小）：跨月时 `"2026-10-31" < "2026-11-06"` 的字典序虽然也对，
 * 但「差几天」必须真的按日历算，否则 10-31 → 11-06 会显示成「逾期 9 天」之类。
 */
export function formatDueLabel(nextReviewAt: string, today: string): string {
  const due = toUtcMs(nextReviewAt);
  const now = toUtcMs(today);
  if (due === null || now === null) return nextReviewAt;
  // 正数 = 还没到期（未来）；0 = 今天；负数 = 已逾期
  const days = Math.round((due - now) / DAY_MS);
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  if (days > 1) return `${days} 天后`;
  return `逾期 ${-days} 天`;
}

/** 「第 N/4 档」文案（复习页列表与角标用；index 越界显示「已完成」） */
export function formatStepLabel(index: number): string {
  const next = nextInterval(index);
  if (next === null) return "已完成";
  return `第 ${index + 1}/4 次`;
}