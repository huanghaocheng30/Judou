/**
 * 复习页（M4 D3）：到期列表 / 无到期空态 / 今日已完成态 / 已完成区（可重启）。
 *
 * 属性契约（02 §三 D3，**已冻结**）：
 * - `data-review-today`：**页面自报的 today**（本地 `YYYY-MM-DD`）。CDP 断言一律从这里读，
 *   不做跨午夜假设（02 B5）。
 * - `data-review-count`：到期篇数。
 * - `data-review-empty="none" | "done"`：两态空态。
 * - `data-review-row` / `data-review-restart`：到期行 / 「重新加入复习」按钮。
 *
 * TP-修复4（issueId M4-U1）新增属性（只加不改，上面四项冻结属性原样保留）：
 * - `data-review-upcoming`：**「接下来」段**（未来计划预告，纯展示、不可开始复习）。
 * - `data-review-upcoming-count`：段内行数。
 * - `data-review-upcoming-row`：段内每行（值 = `articleId`）。
 * - `data-next-review-at`：该行的 `next_review_at`（`YYYY-MM-DD`，升序断言读它）。
 *
 * 取数纪律（02 N8）：本页与 `Sidebar` **各自独立取数、不共享缓存**——共享缓存会引入失效时机问题，
 * 本包不引状态库。取数时点：进入页面 + 每次操作（重启）之后。
 *
 * ponytail: 两个命令并发取（`Promise.all`），不建 store、不引 react-query；
 * 等出现「多处需要同一份复习数据且要跨页共享」再抽。天花板：数据量大时改分页。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { getDueReviews, listReviewPlans, restartReviewPlan } from "../lib/api";
import { localToday } from "../lib/date";
import { formatDueLabel, formatStepLabel } from "../lib/review";
import type { DueReview, ReviewPlan } from "../lib/types";

/**
 * `localToday` 已上移到 `lib/date.ts`（TP-修复5 / M4-U3）：原先定义在本文件，但 `Reader.tsx`
 * 与 `shell/Sidebar.tsx` 都要用，形成「页面 ← 页面 / 外壳 ← 页面」的反向依赖。
 * 这里保留 re-export，既有 import 点不会断。
 */
export { localToday };

interface Data {
  due: DueReview[];
  plans: ReviewPlan[];
}

export function Review() {
  const today = useMemo(() => localToday(), []);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback((): void => {
    setError(null);
    // 两个命令互不依赖 → 并发；任一失败都只让本页显示错误，不抛给全局
    Promise.all([getDueReviews(today), listReviewPlans()])
      .then(([due, plans]) => setData({ due, plans }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [today]);

  useEffect(() => {
    load();
  }, [load]);

  const restart = useCallback(
    (articleId: number): void => {
      setBusy(articleId);
      restartReviewPlan(articleId, today)
        .then(() => load())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(null));
    },
    [today, load],
  );

  /** `status='done'` 的计划（AC7 的「已完成」区；数据源 `list_review_plans()`，不经文章库页面） */
  const donePlans = useMemo(() => (data?.plans ?? []).filter((plan) => plan.status === "done"), [data]);

  /**
   * 「接下来」段（TP-修复4 AC-R1）：`status='active'` 且 `nextReviewAt > today` 的计划，按日期升序。
   *
   * 数据源就是已有的 `listReviewPlans()`（同一次 `Promise.all` 里取的，**零新命令**）。
   * `>` 而不是 `>=` 保证与「今日到期」互斥（AC-R2）：due 是 `<= today`，upcoming 是 `> today`。
   * 日期是定长 `YYYY-MM-DD`，字符串比较即日历比较（跨月/跨年都对，`verify-review` E-10 已证）。
   *
   * ponytail: 不分页/不折叠——用户诉求是「能看到」。天花板：未来计划 > 20 条时列表过长，
   * 届时加「展开全部」或按周分组；渲染入口就这一处，改起来不牵扯其它段。
   */
  const upcoming = useMemo(() => {
    const list = (data?.plans ?? []).filter((plan) => plan.status === "active" && plan.nextReviewAt > today);
    // 稳定排序：同一天的多篇按 articleId，避免每次刷新顺序抖动
    return list.sort((a, b) =>
      a.nextReviewAt === b.nextReviewAt ? a.articleId - b.articleId : a.nextReviewAt < b.nextReviewAt ? -1 : 1,
    );
  }, [data, today]);

  const header = (
    <div className="review-head">
      <p className="review-count" data-review-count={data?.due.length ?? 0}>
        {data ? `今日到期 ${data.due.length} 篇` : "正在读取复习计划…"}
      </p>
      {/* 页面自报的 today：CDP 断言一律读这里（02 B5，不做跨午夜假设） */}
      <p className="review-today" data-review-today={today}>
        {today}
      </p>
    </div>
  );

  if (error) {
    return (
      <section className="review" data-review-page>
        {header}
        <div className="empty" role="alert">
          <p>读不到复习计划：{error}</p>
          <button type="button" className="btn" onClick={() => load()}>
            重试
          </button>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="review" data-review-page>
        {header}
        <p className="review-loading">读取中…</p>
      </section>
    );
  }

  if (data.due.length === 0 && upcoming.length === 0 && donePlans.length === 0) {
    return (
      <section className="review" data-review-page>
        {header}
        <div className="empty" data-review-empty="none" data-empty-review>
          <p>今天没有到期的复习。</p>
          <p className="review-hint">
            在精读页读完一篇后点「完成本篇」，会按 1 / 3 / 7 / 14 天排队提醒你回头复习。
          </p>
          <a className="btn" href="#/library">
            去文章库
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="review" data-review-page>
      {header}

      {data.due.length === 0 ? (
        /**
         * AC-R4 ②：due 空但**还有未来计划**时不显示「今天没有到期的复习」/「今天的复习都做完了」——
         * 那两句会让用户以为「没有安排」，而实际明天/3 天后有。此时只留「接下来」段（下面渲染）。
         */
        upcoming.length === 0 ? (
          <div className="empty" data-review-empty="done">
            <p>今天的复习都做完了。</p>
            <p className="review-hint">下一次到期会自动出现在这里。</p>
            <a className="btn" href="#/library">
              去文章库
            </a>
          </div>
        ) : (
          <p className="review-hint" data-review-due-empty="upcoming">
            今天没有到期的复习，接下来的安排在下面。
          </p>
        )
      ) : (
        <ul className="review-list">
          {data.due.map((row) => (
            <li className="review-row" key={row.articleId} data-review-row={row.articleId}>
              <div className="review-row-main">
                <a className="review-title" href={`#/article/${row.articleId}?mode=review`}>
                  {row.title}
                </a>
                <p className="review-row-meta">
                  <span className="review-due" data-review-due={row.nextReviewAt}>
                    {formatDueLabel(row.nextReviewAt, today)}
                  </span>
                  <span className="review-step">{formatStepLabel(row.intervalIndex)}</span>
                </p>
              </div>
              <a className="btn review-start" href={`#/article/${row.articleId}?mode=review`}>
                开始复习
              </a>
            </li>
          ))}
        </ul>
      )}

      {/* TP-修复4 AC-R1：未来计划预告（纯展示，**没有**「开始复习」入口 —— AC-R3） */}
      {upcoming.length > 0 ? (
        <section className="review-upcoming" data-review-upcoming data-review-upcoming-count={upcoming.length}>
          <h2 className="review-section-title">接下来（{upcoming.length}）</h2>
          <p className="review-hint">还没到期，到期当天的「今日到期」里才能开始复习。</p>
          <ul className="review-list">
            {upcoming.map((plan) => (
              <li
                className="review-row review-row-upcoming"
                key={plan.articleId}
                data-review-upcoming-row={plan.articleId}
                data-article-id={plan.articleId}
                data-next-review-at={plan.nextReviewAt}
              >
                <div className="review-row-main">
                  <span className="review-title">{doneTitle(plan)}</span>
                  <p className="review-row-meta">
                    <span className="review-when">{formatDueLabel(plan.nextReviewAt, today)}</span>
                    <span className="review-date">{plan.nextReviewAt.slice(5)}</span>
                    <span className="review-step">{formatStepLabel(plan.intervalIndex)}</span>
                  </p>
                </div>
                {/* 文字标记而不是纯色块：颜色不是唯一区分通道 */}
                <span className="review-pending">待到期</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {donePlans.length > 0 && (
        <section className="review-done" data-review-done-section>
          <h2 className="review-section-title">已完成（{donePlans.length}）</h2>
          <p className="review-hint">四档（1 / 3 / 7 / 14 天）走完后不再提醒；想再复习可以重新加入。</p>
          <ul className="review-list">
            {donePlans.map((plan) => (
              <li className="review-row review-row-done" key={plan.articleId} data-review-done-row={plan.articleId}>
                <div className="review-row-main">
                  <a className="review-title" href={`#/article/${plan.articleId}`}>
                    {doneTitle(plan)}
                  </a>
                  <p className="review-row-meta">
                    <span className="review-step">已完成 {plan.intervalIndex} 次</span>
                  </p>
                </div>
                <button
                  type="button"
                  className="btn"
                  data-review-restart={plan.articleId}
                  disabled={busy === plan.articleId}
                  onClick={() => restart(plan.articleId)}
                >
                  {busy === plan.articleId ? "加入中…" : "重新加入复习"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * `done` 计划的标题：`list_review_plans()` 已 JOIN `article` 带上 `title`（concern 7 修复），
 * 这里直接用；`title` 为空（老数据 / 序列化丢字段）才回退「文章 #id」，不让行变空白。
 *
 * 仍是**第 7 个命令**、签名不变（`() -> ReviewPlan[]`），只是返回体多一个字段。
 */
function doneTitle(plan: ReviewPlan): string {
  const title = plan.title?.trim();
  return title ? title : `文章 #${plan.articleId}`;
}