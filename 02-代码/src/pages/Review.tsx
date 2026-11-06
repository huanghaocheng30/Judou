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
 * 取数纪律（02 N8）：本页与 `Sidebar` **各自独立取数、不共享缓存**——共享缓存会引入失效时机问题，
 * 本包不引状态库。取数时点：进入页面 + 每次操作（重启）之后。
 *
 * ponytail: 两个命令并发取（`Promise.all`），不建 store、不引 react-query；
 * 等出现「多处需要同一份复习数据且要跨页共享」再抽。天花板：数据量大时改分页。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { getDueReviews, listReviewPlans, restartReviewPlan } from "../lib/api";
import { formatDueLabel, formatStepLabel } from "../lib/review";
import type { DueReview, ReviewPlan } from "../lib/types";

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * **为什么不用 `new Date().toISOString().slice(0, 10)`**：那是 UTC，东八区清晨会拿到昨天的日期，
 * 「今天到期」就整体错一天（02 决策 #7）。这里按本地年月日拼串，与 `next_review_at` 同口径。
 */
export function localToday(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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

  if (data.due.length === 0 && donePlans.length === 0) {
    return (
      <section className="review" data-review-page>
        {header}
        <div className="empty" data-review-empty="none">
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
        <div className="empty" data-review-empty="done">
          <p>今天的复习都做完了。</p>
          <p className="review-hint">下一次到期会自动出现在这里。</p>
          <a className="btn" href="#/library">
            去文章库
          </a>
        </div>
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