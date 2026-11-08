/**
 * 记录与统计页（M6 D4 / AC1·AC2·AC12）。
 *
 * 数据全部来自后端聚合命令：时间线 `get_reading_records`、统计卡 `get_stats`
 * （六项数字都由 SQL 直读，前端不做二次累加——门禁对同一份库复算比对）。
 * 空态带「下一步做什么」入口（AC12）。
 */
import { useEffect, useState } from "react";
import { getReadingRecords, getStats } from "../lib/api";
import type { ReadingRecordView, StatsView } from "../lib/types";

/** 本地日期 `YYYY-MM-DD`（连续天数按本地日历算，与用户认知一致） */
function todayLocal(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 秒 → 「1 小时 2 分」/「35 秒」 */
function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return "0 分钟";
  if (totalSec < 60) return `${totalSec} 秒`;
  const minutes = Math.round(totalSec / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

function formatWhen(raw: string | null): string {
  if (!raw) return "未记录时间";
  // SQLite datetime('now') 是 UTC「YYYY-MM-DD HH:MM:SS」，只做展示（不解析时区）
  return raw.replace("T", " ").slice(0, 16);
}

interface StatItem {
  key: string;
  label: string;
  value: string;
}

export function Records() {
  const [records, setRecords] = useState<ReadingRecordView[] | null>(null);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([getReadingRecords(), getStats(todayLocal())])
      .then(([list, summary]) => {
        if (cancelled) return;
        setRecords(list);
        setStats(summary);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items: StatItem[] = stats
    ? [
        { key: "articles", label: "已读篇数", value: `${stats.articleCount}` },
        { key: "completed", label: "完成精读", value: `${stats.completedCount}` },
        { key: "duration", label: "总时长", value: formatDuration(stats.totalDurationSec) },
        { key: "notes", label: "笔记", value: `${stats.noteCount}` },
        { key: "vocab", label: "生词", value: `${stats.vocabCount}` },
        { key: "reviews", label: "复习次数", value: `${stats.reviewCount}` },
      ]
    : [];

  return (
    <div className="records">
      <section className="card" aria-labelledby="stats-title">
        <h2 id="stats-title">统计</h2>
        {error && <p className="card-hint" role="alert">统计读取失败：{error}</p>}
        {!stats && !error && <p className="card-hint">正在读取统计…</p>}
        {stats && (
          <div className="stats-card" data-stats-card>
            <ul className="stats-grid records-stats-grid">
              {items.map((item) => (
                <li key={item.key} data-stats-item={item.key}>
                  <span className="stats-label">{item.label}</span>
                  <strong className="stats-value">{item.value}</strong>
                </li>
              ))}
            </ul>
            <p className="stats-streak" data-stats-streak={stats.streak}>
              连续阅读 <strong>{stats.streak}</strong> 天
            </p>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="timeline-title">
        <h2 id="timeline-title">阅读时间线</h2>
        <p className="card-hint">按上次阅读时间倒序；点标题回到那一篇继续读。</p>
        {records && records.length === 0 && (
          <div className="empty-state" data-empty-records>
            <p>还没有阅读记录。打开一篇文章开始精读，这里会自动记下用时与进度。</p>
            <a className="btn" href="#/library">
              去文章库挑一篇
            </a>
          </div>
        )}
        {records && records.length > 0 && (
          <ul className="record-list records-timeline" data-records-list>
            {records.map((record) => (
              <li
                key={record.articleId}
                className={record.completed ? "record-item is-done" : "record-item"}
                data-record-id={record.articleId}
              >
                <div className="record-head">
                  <a className="record-title" href={`#/article/${record.articleId}`}>
                    {record.title}
                  </a>
                  <span className={record.completed ? "record-done" : "record-todo"}>
                    {record.completed ? "已完成" : "未完成"}
                  </span>
                </div>
                <p className="record-meta">
                  用时 {formatDuration(record.durationSec)} · 上次位置{" "}
                  {record.lastPosition ? `第 ${record.lastPosition} 屏` : "未记录"} · {formatWhen(record.lastReadAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
