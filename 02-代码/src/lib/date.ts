/**
 * 本地日期工具（纯函数层，无 React / 无 DOM —— 与 `lib/review.ts` 同约束）。
 *
 * **为什么单独成文件**：`localToday()` 原先定义在 `pages/Review.tsx` 里，而 `Reader.tsx` 与
 * `shell/Sidebar.tsx` 都要用它 → 形成「页面 ← 页面」与「外壳 ← 页面」的反向依赖
 * （页面一改、外壳跟着重编译，且纯函数逻辑藏在组件文件里没法被 node 直接测）。
 * TP-修复5（M4-U3）做「今日」页时第三方消费点出现，正是上移到纯函数层的时机。
 *
 * 约束：不 import React/DOM、不用 enum/namespace/参数属性——`node --test`（Node 24 类型擦除）
 * 与 `scripts/verify-review.mjs` 的 E 段要能直接 import。
 */

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * **为什么不用 `new Date().toISOString().slice(0, 10)`**：那是 UTC，东八区清晨会拿到昨天的日期，
 * 「今天到期」就整体错一天（M4 决策 #7）。这里按本地年月日拼串，与 `next_review_at` 同口径。
 */
export function localToday(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * `2026-11-06 14:45:28` / ISO 串 → 本地日期 `MM-DD`（今日页「上次读到 MM-DD」用）。
 *
 * 后端 `reading_record.last_read_at` 是 SQLite `datetime('now')` 的 **UTC** 串
 * （`YYYY-MM-DD HH:MM:SS`），不是本地时间。直接切前 5 位会差 8 小时（东八区），
 * 所以这里显式按 UTC 解析再转本地，与「本地今天」同口径。
 *
 * 非法串返回 null（调用方不显示这一段，而不是显示一个错的日期）。
 */
export function formatReadAt(ts: string | null | undefined): string | null {
  if (typeof ts !== "string" || ts.trim() === "") return null;
  // SQLite 的 `YYYY-MM-DD HH:MM:SS` 缺时区 → 显式按 UTC 解析
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(ts.trim()) ? `${ts.trim().replace(" ", "T")}Z` : ts.trim();
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${m}-${d}`;
}