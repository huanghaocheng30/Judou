/**
 * 「今日」页（M1 漏账补齐 · TP-修复5 / M4-U3）。
 *
 * 两栏 + 新用户空态（04 §五 M1 行「继续精读 + 今日待复习(N)」）：
 * 1. **继续精读**：`get_last_read_article()`（`reading_record` 按 `last_read_at DESC` 取 1 条）
 *    → 标题 + 「上次读到 MM-DD」→ 点进 `#/article/<id>`。**无记录时整栏不渲染**（不占位）。
 * 2. **今日待复习（N）**：复用 `getDueReviews(today)`（**零新命令**，与复习页同源同口径）
 *    → 每行点进 `#/article/<id>?mode=review`；为空显示「今天没有到期」。
 * 3. 两栏都空（新用户）→ `data-today-empty="new"` + 「去文章库」。
 *
 * 属性契约（02 §一 AC-R6~R9，供 CDP 断言）：
 * - `data-today-page`（页面根）
 * - `data-today-continue` / `data-today-continue-id`（继续精读栏）
 * - `data-today-review` / `data-today-review-count` / `data-today-review-row`
 * - `data-today-empty="new"`
 *
 * 键盘（AC-R10）：卡片用**真 `<a>`**（href 即 hash 路由）——原生可 Tab 聚焦、Enter 即进入，
 * 不需要手工补 role/tabIndex/onKeyDown；`:focus-visible` 轮廓由 app.css 的 `.today-card:focus-visible` 给。
 * 空态按钮同理用 `<a class="btn" href="#/library">`（与复习页空态同一写法）。
 *
 * 取数纪律（沿用复习页 N8）：本页**独立取数、不与侧栏/复习页共享缓存**，进入页面取一次即止。
 *
 * ponytail: 两个命令并发取（`Promise.all`），不建 store、不引 react-query；
 * 位置恢复（`reading_record.last_position`）按 02 §三 不做，本页只回答「最近读过哪篇」。
 */
import { useEffect, useMemo, useState } from "react";
import { getDueReviews, getLastReadArticle } from "../lib/api";
import { formatReadAt, localToday } from "../lib/date";
import { formatDueLabel, formatStepLabel } from "../lib/review";
import type { DueReview, LastReadArticle } from "../lib/types";

interface TodayData {
  lastRead: LastReadArticle | null;
  due: DueReview[];
}

export function Today() {
  // 本地 today（与复习页 / 侧栏同口径：按本地年月日拼串，不用 UTC 的 toISOString）
  const today = useMemo(() => localToday(), []);
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // 两个命令互不依赖 → 并发；任一失败只让本页显示错误，不抛给全局
    Promise.all([getLastReadArticle(), getDueReviews(today)])
      .then(([lastRead, due]) => {
        if (!cancelled) setData({ lastRead, due });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [today]);

  if (error) {
    return (
      <section className="today" data-today-page data-today-today={today}>
        <div className="empty" role="alert">
          <p>读不到今日安排：{error}</p>
          <a className="btn" href="#/library">
            去文章库
          </a>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="today" data-today-page data-today-today={today}>
        <p className="today-loading" data-today-loading>
          读取中…
        </p>
      </section>
    );
  }

  const { lastRead, due } = data;

  // 新用户：两栏都空 → 只显示引导（不显示两个空的卡片）
  if (lastRead === null && due.length === 0) {
    return (
      <section className="today" data-today-page data-today-today={today}>
        <div className="empty" data-today-empty="new">
          <p>还没有开始读。</p>
          <p className="today-hint">
            去文章库挑一篇开始精读；读完点「完成本篇」，会按 1 / 3 / 7 / 14 天排进复习。
          </p>
          <a className="btn" href="#/library">
            去文章库
          </a>
        </div>
      </section>
    );
  }

  const lastReadDate = formatReadAt(lastRead?.lastReadAt ?? null);

  return (
    <section className="today" data-today-page data-today-today={today}>
      {/* ① 继续精读：**无记录时整栏不渲染**（AC-R7 的「不占位」） */}
      {lastRead !== null ? (
        <section
          className="today-section"
          data-today-continue
          data-today-continue-id={lastRead.articleId}
          aria-labelledby="today-continue-title"
        >
          <h2 className="today-section-title" id="today-continue-title">
            继续精读
          </h2>
          <a className="today-card" href={`#/article/${lastRead.articleId}`} data-today-continue-link>
            <span className="today-card-title">{lastRead.title}</span>
            <span className="today-card-meta">
              {lastReadDate ? `上次读到 ${lastReadDate}` : "上次读过"}
            </span>
          </a>
        </section>
      ) : null}

      {/* ② 今日待复习：**复用 get_due_reviews（零新命令）** */}
      <section
        className="today-section"
        data-today-review
        data-today-review-count={due.length}
        aria-labelledby="today-review-title"
      >
        <h2 className="today-section-title" id="today-review-title">
          今日待复习（{due.length}）
        </h2>
        {due.length === 0 ? (
          <p className="today-hint" data-today-review-empty="none">
            今天没有到期。
          </p>
        ) : (
          <ul className="today-list">
            {due.map((row) => (
              <li key={row.articleId}>
                <a
                  className="today-card"
                  href={`#/article/${row.articleId}?mode=review`}
                  data-today-review-row={row.articleId}
                >
                  <span className="today-card-title">{row.title}</span>
                  <span className="today-card-meta">
                    <span className="today-due">{formatDueLabel(row.nextReviewAt, today)}</span>
                    <span className="today-step">{formatStepLabel(row.intervalIndex)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}