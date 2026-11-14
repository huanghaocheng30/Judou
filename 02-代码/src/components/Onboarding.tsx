/**
 * 入门任务清单（M6 第五轮重做，替代原三屏说明卡 Guide）。
 *
 * 为什么换掉说明卡：三屏卡只是「讲一遍怎么用」，用户看完仍不知道下一步做什么，
 * 用户原话「完全没有起到引导的作用」——所以改成**可勾选的入门任务清单**：
 * 两项任务各自按**真实数据**判定完成，做完自动打勾，不需要用户自己上报。
 *
 * 两项判定（全部复用既有 `get_stats`，**不新增命令、不改表**）：
 * ① 打开一篇精读并点开一句话 → `readingRecordCount`（`reading_record` 行数）≥ 1
 * ② 收藏一个生词             → `vocabCount`（`vocab_entry` 行数）≥ 1
 *
 * 落盘：两项全完成 或 用户点「不再提示」→ `app_setting.onboarding_done=1`；
 * 设置页的「重新开始」写回 `onboarding_done=0`，清单重新出现在今日页顶部。
 *
 * 属性契约（供门禁 / CDP 断言）：
 * - `data-onboarding`（清单根）、`data-onboarding-variant="today|settings"`
 * - `data-onboarding-item="read|vocab"` + `data-onboarding-state="todo|done"`
 * - `data-onboarding-dismiss`（不再提示）/ `data-onboarding-reset`（重新开始）
 */
import { useCallback, useEffect, useState } from "react";
import { getSettings, getStats, setSetting } from "../lib/api";
import { localToday } from "../lib/date";

type TaskKey = "read" | "vocab";

interface TaskDef {
  key: TaskKey;
  title: string;
  hint: string;
  href: string;
}

const TASKS: TaskDef[] = [
  {
    key: "read",
    title: "打开一篇精读，点开一句话",
    hint: "进文章库挑一篇 → 精读页点任意句子，右侧出解析",
    href: "#/library",
  },
  {
    key: "vocab",
    title: "收藏一个生词",
    hint: "精读页点一个单词 → 加进生词本",
    href: "#/library",
  },
];

/** 两项完成态：**只从真实数据算**，不读任何「用户上报」字段。 */
interface DoneMap {
  read: boolean;
  vocab: boolean;
}

const ONBOARDING_KEY = "onboarding_done";

export function Onboarding({ variant }: { variant: "today" | "settings" }) {
  const [done, setDone] = useState<DoneMap | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([getStats(localToday()), getSettings()])
      .then(([stats, settings]) => {
        if (cancelled) return;
        const next: DoneMap = {
          read: stats.articleCount >= 1,
          vocab: stats.vocabCount >= 1,
        };
        setDone(next);
        setDismissed(settings[ONBOARDING_KEY] === "1");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const allDone = done !== null && done.read && done.vocab;

  /** 全完成即自动收起（写一次 `onboarding_done=1`）；写失败不打断用户，只记日志 */
  useEffect(() => {
    if (!allDone || dismissed) return;
    void setSetting(ONBOARDING_KEY, "1").catch((err: unknown) => {
      console.warn("写 onboarding_done 失败", err);
    });
  }, [allDone, dismissed]);

  const dismiss = () => {
    setDismissed(true);
    void setSetting(ONBOARDING_KEY, "1").catch((err: unknown) => {
      console.warn("写 onboarding_done 失败", err);
    });
  };

  const reset = () => {
    setSetting(ONBOARDING_KEY, "0")
      .then(() => {
        setDismissed(false);
        setCollapsed(false);
        load();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  // 今日页：已完成（或用户点了不再提示）就整块不渲染；设置页永远可见
  if (variant === "today" && (dismissed || allDone)) return null;

  if (error) {
    return (
      <section className="onboarding" data-onboarding data-onboarding-variant={variant}>
        <p className="onboarding-error" role="status">
          入门任务读不到进度：{error}
        </p>
      </section>
    );
  }

  if (done === null) {
    return (
      <section className="onboarding" data-onboarding data-onboarding-variant={variant}>
        <p className="onboarding-loading">读取入门进度…</p>
      </section>
    );
  }

  const doneCount = [done.read, done.vocab].filter(Boolean).length;

  return (
    <section className="onboarding" data-onboarding data-onboarding-variant={variant}>
      <header className="onboarding-head">
        <h2 className="onboarding-title">
          入门任务（{doneCount}/{TASKS.length}）
        </h2>
        <div className="onboarding-head-actions">
          {variant === "today" ? (
            <button
              type="button"
              className="btn ghost small"
              data-onboarding-dismiss
              onClick={dismiss}
            >
              不再提示
            </button>
          ) : null}
          {variant === "today" ? (
            <button
              type="button"
              className="btn ghost small"
              data-onboarding-toggle
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((current) => !current)}
            >
              {collapsed ? "展开" : "收起"}
            </button>
          ) : null}
        </div>
      </header>

      {collapsed ? null : (
        <>
          <p className="onboarding-hint">
            做完会自动打勾（数据来自你的真实使用，不需要手动标记）。
          </p>
          <ol className="onboarding-list onboarding-checklist">
            {TASKS.map((task, index) => {
              const state = done[task.key] ? "done" : "todo";
              return (
                <li
                  key={task.key}
                  className={`onboarding-item ${state}`}
                  data-onboarding-item={task.key}
                  data-onboarding-state={state}
                >
                  <span className="onboarding-no">{index + 1}</span>
                  <span className="onboarding-mark" aria-hidden="true">
                    {state === "done" ? "✓" : "○"}
                  </span>
                  <span className="onboarding-text">
                    <span className="onboarding-task">{task.title}</span>
                    <span className="onboarding-task-hint">{task.hint}</span>
                  </span>
                  {state === "done" ? (
                    <span className="onboarding-status">已完成</span>
                  ) : (
                    <a className="btn small" href={task.href} data-onboarding-go={task.key}>
                      去做
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}

      {variant === "settings" ? (
        <div className="btn-row">
          <button type="button" className="btn" data-onboarding-reset onClick={reset}>
            重新开始入门任务
          </button>
        </div>
      ) : null}
    </section>
  );
}
