//! M4 · 复习（第 1 批 D0）——只碰三处：`review_plan` / `review_log` / `reading_record.completed`。
//!
//! 分工（02 D0 / D1）：本文件是**实现**；`commands.rs` 只做薄包装（`#[tauri::command]` 在那里），
//! 注册点只在 `lib.rs` 的 `generate_handler!`。7 个命令：
//! `mark_article_completed` / `get_due_reviews` / `get_review_plan` / `complete_review` /
//! `restart_review_plan` / `list_review_logs` / `list_review_plans`。
//!
//! ## 日期来源禁令（02 D0 / 决策 #11）
//! 三个写路径命令（`mark_article_completed` / `complete_review` / `restart_review_plan`）的 `today`
//! **一律由前端传入**（本地日期 `YYYY-MM-DD`）。本文件**不出现** `date('now')`——SQL 推日期会引入
//! UTC 与本地两套口径，固定 today 的门禁就测不出顺延错误。
//! `datetime('now')` 只用于「记录时刻」列（`updated_at` / `reviewed_at` / `last_read_at`）。
//!
//! ## 红线（02 AC9 / 01 §五）
//! - 只写 `review_plan` / `review_log` / `reading_record.completed`；
//! - **不写** `reading_record.last_position` / `duration_sec`（归 M6）；
//! - 对解析四表、内容四表、`vocab_*`、笔记两表、`app_setting` **只有 SELECT（或完全不碰）**；
//! - `001_init.sql` 零改动（三表 M0 已建，不需要 003 迁移）。
//!
//! ## 顺延规则（Rust 权威，TS `src/lib/review.ts` 只做乐观预览）
//! 间隔表 `[1,3,7,14]`，`interval_index` = **已完成次数**：
//! - `done`：`newIndex = index + 1`；`newIndex >= 4` → `status='done'` 且 `next_review_at` **写死为 today**；
//!   否则 `next_review_at = today + INTERVALS[newIndex]`；
//! - `need_more`：`newIndex = index`（**不前进**）、`next_review_at = today + 1`（决策 #5）。
//!
//! ponytail: 不建 Repository 抽象——7 个命令对 3 张表，直接写 SQL 最短。到期判定走 SQL 字符串比较
//! （`YYYY-MM-DD` 定长，字典序 = 日期序），不解析成日期类型、不引 chrono 依赖。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::commands::CommandError;
use crate::db::Db;

/// 四档间隔（天）：`INTERVALS[index]` = 「已完成 index 次后，下次隔几天」。
pub const INTERVALS: [i64; 4] = [1, 3, 7, 14];

/// 四档全部走完所需的完成次数（`index=3` 再完成一次 → `status='done'`）。
pub const MAX_INTERVAL_INDEX: i64 = 3;

// ───────────────────────────── 返回体（camelCase 边界，02 §二） ─────────────────────────────

/// `review_plan` 一行（`updatedAt` 是记录时刻，不参与到期判定）。
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlan {
    pub article_id: i64,
    pub next_review_at: String,
    pub interval_index: i64,
    /// `active` / `paused` / `done`（DB CHECK 约束）
    pub status: String,
    pub updated_at: String,
}

/// `get_due_reviews` 的一行：计划 + 文章标题（复习页列表要显示标题）。
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DueReview {
    pub article_id: i64,
    pub title: String,
    pub next_review_at: String,
    pub interval_index: i64,
}

/// `review_log` 一行。`interval_index` 记的是**这次复习完成前**的档位（不是完成后）。
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLog {
    pub id: i64,
    pub article_id: i64,
    pub reviewed_at: String,
    pub interval_index: i64,
    /// `done` / `need_more`
    pub result: String,
}

// ───────────────────────────── 共用半成品 ─────────────────────────────

const PLAN_SELECT: &str =
    "SELECT article_id, next_review_at, interval_index, status, updated_at FROM review_plan";

fn map_plan(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewPlan> {
    Ok(ReviewPlan {
        article_id: row.get(0)?,
        next_review_at: row.get(1)?,
        interval_index: row.get(2)?,
        status: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

/// 校验前端传来的 `today`：**必须是定长 `YYYY-MM-DD`**。
///
/// 为什么不做成「宽松日期」：到期判定是 SQL 字符串比较（`next_review_at <= ?`），
/// 一旦混进 `2026-11-6`（缺前导 0）或带时间的串，字典序就会算错且**静默**。
/// 这里显式 fail-closed，把「格式错」变成看得见的契约错误。
fn validate_today(today: &str) -> Result<&str, CommandError> {
    let bytes = today.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if shaped {
        Ok(today)
    } else {
        Err(CommandError::invalid_date(today))
    }
}

/// `result` 只接受两值（与 DB `CHECK (result IN ('done','need_more'))` 同口径，但先给可读提示）。
fn validate_result(result: &str) -> Result<&str, CommandError> {
    if REVIEW_RESULTS.contains(&result) {
        Ok(result)
    } else {
        Err(CommandError::invalid_review_result(result))
    }
}

/// `today + days`（纯日历算术，不引 chrono）。
///
/// ponytail: 手写这一步只为了不引 `chrono`/`time` 依赖——间隔表最大 14 天、today 是本地日期串，
/// 需要的只是「加若干天并跳过月末」。天花板：将来要处理时区/夏令时/跨年度的复杂日历（例如
/// 「下个工作日」）时换 `time` crate（`time::Date::checked_add(Duration::days(n))`），命令签名不变。
pub fn add_days(today: &str, days: i64) -> String {
    let year: i64 = today[0..4].parse().unwrap_or(1970);
    let month: i64 = today[5..7].parse().unwrap_or(1);
    let day: i64 = today[8..10].parse().unwrap_or(1);
    let (mut y, mut m, mut d) = (year, month, day + days);

    // 先滚日（月末 → 下月 1 日），再滚月（13 月 → 次年 1 月）
    while d > days_in_month(y, m) {
        d -= days_in_month(y, m);
        m += 1;
        if m > 12 {
            m = 1;
            y += 1;
        }
    }
    format!("{y:04}-{m:02}-{d:02}")
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 31,
    }
}

/// 读计划（无则 `None`）。事务内与事务外共用。
fn read_plan(conn: &Connection, article_id: i64) -> Result<Option<ReviewPlan>, CommandError> {
    conn.query_row(
        &format!("{PLAN_SELECT} WHERE article_id = ?1"),
        [article_id],
        map_plan,
    )
    .optional()
    .map_err(|err| CommandError::db("读取复习计划", err))
}

/// `restart` 与 `mark_article_completed` 共用的「插一行起点计划」。
fn insert_start_plan(conn: &Connection, article_id: i64, today: &str) -> Result<(), CommandError> {
    conn.execute(
        "INSERT INTO review_plan (article_id, next_review_at, interval_index, status, updated_at)
         VALUES (?1, ?2, 0, 'active', datetime('now'))
         ON CONFLICT(article_id) DO NOTHING",
        params![article_id, add_days(today, 1)],
    )
    .map_err(|err| CommandError::db("建立复习计划", err))?;
    Ok(())
}

/// 「完成过」的唯一真相：`reading_record.completed=1` + `last_read_at`。
///
/// **只写这两列**：`last_position` / `duration_sec` 归 M6（02 红线），
/// `ON CONFLICT` 分支也只 SET 这两列，所以既有行的那两列原样保留。
fn mark_reading_completed(conn: &Connection, article_id: i64) -> Result<(), CommandError> {
    conn.execute(
        "INSERT INTO reading_record (article_id, completed, last_read_at)
         VALUES (?1, 1, datetime('now'))
         ON CONFLICT(article_id) DO UPDATE
            SET completed = 1, last_read_at = datetime('now')",
        [article_id],
    )
    .map_err(|err| CommandError::db("记录阅读完成", err))?;
    Ok(())
}

// ───────────────────────────── ① mark_article_completed ─────────────────────────────

/// 标记本篇完成：建计划（若还没有）+ 写 `reading_record.completed`，返回**当前**计划。
///
/// **幂等**（AC2）：plan 已存在时**原样返回**，不改 `next_review_at`、不重建——
/// 「重复点完成本篇」不能把已经在复习中的计划打回起点。
/// `reading_record` 仍然写（重复标记「完成过」无副作用，`completed=1` 幂等）。
pub fn mark_article_completed(
    db: &Db,
    article_id: i64,
    today: &str,
) -> Result<ReviewPlan, CommandError> {
    let today = validate_today(today)?;
    db.write(|tx| {
        let existing = read_plan(tx, article_id)?;
        if existing.is_none() {
            insert_start_plan(tx, article_id, today)?;
        }
        mark_reading_completed(tx, article_id)?;
        // 读计划放在同一事务里：返回的一定是「本次写入之后」的状态（不变量回读）
        read_plan(tx, article_id)?.ok_or_else(|| CommandError::db_invariant("建立复习计划"))
    })
}

// ───────────────────────────── ② get_due_reviews ─────────────────────────────

/// 今日到期：`status='active' AND next_review_at <= today`，按 `next_review_at` 升序、`article_id` 升序。
///
/// 到期 0 篇返回**空数组**（不是错误）：复习页的空态就靠它。
/// `done` 的计划即便 `next_review_at <= today`（终态置当天）也被 `status` 过滤掉——AC4 的「不再出现」。
pub fn get_due_reviews(db: &Db, today: &str) -> Result<Vec<DueReview>, CommandError> {
    let today = validate_today(today)?;
    db.read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT p.article_id, a.title, p.next_review_at, p.interval_index
                   FROM review_plan p
                   JOIN article a ON a.id = p.article_id
                  WHERE p.status = 'active' AND p.next_review_at <= ?1
               ORDER BY p.next_review_at ASC, p.article_id ASC",
            )
            .map_err(|err| CommandError::db("准备到期复习查询", err))?;
        let rows = stmt
            .query_map([today], |row| {
                Ok(DueReview {
                    article_id: row.get(0)?,
                    title: row.get(1)?,
                    next_review_at: row.get(2)?,
                    interval_index: row.get(3)?,
                })
            })
            .map_err(|err| CommandError::db("查询到期复习", err))?;
        rows.collect::<rusqlite::Result<Vec<DueReview>>>()
            .map_err(|err| CommandError::db("读取到期复习", err))
    })
}

// ───────────────────────────── ③ get_review_plan ─────────────────────────────

/// 单篇计划（无则 `None`）。
pub fn get_review_plan(db: &Db, article_id: i64) -> Result<Option<ReviewPlan>, CommandError> {
    db.read(|conn| read_plan(conn, article_id))
}

// ───────────────────────────── ④ complete_review ─────────────────────────────

/// 复习结果 → 计划与日志（写路径；`today` 由前端传）。
///
/// - plan 不存在 → 契约错误码 `REVIEW_PLAN_MISSING`（只允许对已建计划复习）；
/// - `done`：顺延一档；走完四档 → `status='done'` 且 `next_review_at` 写死为 today；
/// - `need_more`：档位**不前进**、`next_review_at = today + 1`；
/// - `review_log.interval_index` 记**完成前**的值（日志回答「这一档是第几次完成的」）。
pub fn complete_review(
    db: &Db,
    article_id: i64,
    result: &str,
    today: &str,
) -> Result<ReviewPlan, CommandError> {
    let today = validate_today(today)?;
    let result = validate_result(result)?;
    db.write(|tx| {
        let plan =
            read_plan(tx, article_id)?.ok_or_else(|| CommandError::review_plan_missing(article_id))?;
        let before_index = plan.interval_index;

        let (new_index, next_review_at, status) = if result == "done" {
            let new_index = before_index + 1;
            if new_index > MAX_INTERVAL_INDEX {
                // 四档走完：终态。next_review_at 写死为 today（02 §五 风险表口径），
                // 到期查询靠 status 过滤，不再前进也不影响。
                (new_index, today.to_string(), "done".to_string())
            } else {
                let step = INTERVALS[new_index as usize];
                (new_index, add_days(today, step), "active".to_string())
            }
        } else {
            // need_more：不前进，明天再看（决策 #5）
            (before_index, add_days(today, 1), "active".to_string())
        };

        tx.execute(
            "UPDATE review_plan
                SET next_review_at = ?2, interval_index = ?3, status = ?4, updated_at = datetime('now')
              WHERE article_id = ?1",
            params![article_id, next_review_at, new_index, status],
        )
        .map_err(|err| CommandError::db("顺延复习计划", err))?;

        tx.execute(
            "INSERT INTO review_log (article_id, reviewed_at, interval_index, result)
             VALUES (?1, datetime('now'), ?2, ?3)",
            params![article_id, before_index, result],
        )
        .map_err(|err| CommandError::db("记录复习日志", err))?;

        read_plan(tx, article_id)?.ok_or_else(|| CommandError::db_invariant("顺延复习计划"))
    })
}

// ───────────────────────────── ⑤ restart_review_plan ─────────────────────────────

/// 手动重启：回到四档起点（`active` / `index=0` / 明天到期），返回复位后的计划。
///
/// **plan 不存在时走 INSERT 分支**（02 N5）：`next_review_at` / `updated_at` 是 NOT NULL 且无 DEFAULT，
/// UPDATE 空行什么也不会发生，所以必须建行——语义与 `mark_article_completed` 的首次建计划一致。
pub fn restart_review_plan(db: &Db, article_id: i64, today: &str) -> Result<ReviewPlan, CommandError> {
    let today = validate_today(today)?;
    db.write(|tx| {
        if read_plan(tx, article_id)?.is_some() {
            tx.execute(
                "UPDATE review_plan
                    SET next_review_at = ?2, interval_index = 0, status = 'active', updated_at = datetime('now')
                  WHERE article_id = ?1",
                params![article_id, add_days(today, 1)],
            )
            .map_err(|err| CommandError::db("重启复习计划", err))?;
        } else {
            insert_start_plan(tx, article_id, today)?;
        }
        read_plan(tx, article_id)?.ok_or_else(|| CommandError::db_invariant("重启复习计划"))
    })
}

// ───────────────────────────── ⑥ list_review_logs ─────────────────────────────

/// 复习日志：给 `article_id` 就只看那一篇；不给就全量。按 `reviewed_at` 降序，同刻按 id 降序（稳定序）。
pub fn list_review_logs(db: &Db, article_id: Option<i64>) -> Result<Vec<ReviewLog>, CommandError> {
    db.read(|conn| {
        let map_log = |row: &rusqlite::Row<'_>| {
            Ok(ReviewLog {
                id: row.get(0)?,
                article_id: row.get(1)?,
                reviewed_at: row.get(2)?,
                interval_index: row.get(3)?,
                result: row.get(4)?,
            })
        };
        let sql_all = "SELECT id, article_id, reviewed_at, interval_index, result \
                         FROM review_log ORDER BY reviewed_at DESC, id DESC";
        let sql_one = "SELECT id, article_id, reviewed_at, interval_index, result \
                         FROM review_log WHERE article_id = ?1 ORDER BY reviewed_at DESC, id DESC";
        let rows = match article_id {
            Some(id) => conn
                .prepare(sql_one)
                .map_err(|err| CommandError::db("准备复习日志查询", err))?
                .query_map([id], map_log)
                .map_err(|err| CommandError::db("查询复习日志", err))?
                .collect::<rusqlite::Result<Vec<ReviewLog>>>(),
            None => conn
                .prepare(sql_all)
                .map_err(|err| CommandError::db("准备复习日志查询", err))?
                .query_map([], map_log)
                .map_err(|err| CommandError::db("查询复习日志", err))?
                .collect::<rusqlite::Result<Vec<ReviewLog>>>(),
        };
        rows.map_err(|err| CommandError::db("读取复习日志", err))
    })
}

// ───────────────────────────── ⑦ list_review_plans ─────────────────────────────

/// **全部计划**（含 `status='done'`），按到期日升序。
///
/// 02 B4 的实现路径：复习页自己从这份清单里筛出 `done` 的文章（AC5「已完成今日」）
/// 并提供「重新加入复习」（AC7）——**不依赖** `Library.tsx`（不在本包范围）。
pub fn list_review_plans(db: &Db) -> Result<Vec<ReviewPlan>, CommandError> {
    db.read(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "{PLAN_SELECT} ORDER BY next_review_at ASC, article_id ASC"
            ))
            .map_err(|err| CommandError::db("准备复习计划查询", err))?;
        let rows = stmt
            .query_map([], map_plan)
            .map_err(|err| CommandError::db("查询复习计划", err))?;
        rows.collect::<rusqlite::Result<Vec<ReviewPlan>>>()
            .map_err(|err| CommandError::db("读取复习计划", err))
    })
}

/// `complete_review` 只接受这两个结果值（`validate_result` 的唯一真源；与 DB CHECK 同口径）。
/// `commands.rs` 的包装层不重复写这两个字面量——Rust 校验层一份，TS 侧由 `types.ts` 的 `ReviewResult` 一份。
pub const REVIEW_RESULTS: [&str; 2] = ["done", "need_more"];

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TODAY: &str = "2026-11-06";

    fn temp_db(tag: &str) -> (Db, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-review-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("建库失败");
        (db, dir)
    }

    /// 一篇文章（复习只关联 article.id + title）。本测试模块自己造内容表数据，
    /// 与 `vocab.rs` / `analysis.rs` 测试同一先例（AC9 的写白名单只扫生产代码）。
    fn seed_article(db: &Db, key: &str, title: &str) -> i64 {
        db.write(move |tx| {
            tx.execute(
                "INSERT INTO article (source_key, title, exam_type, visibility) VALUES (?1, ?2, 'cet4', 'system')",
                params![key, title],
            )
            .map_err(|err| CommandError::db("插 article", err))?;
            Ok(tx.last_insert_rowid())
        })
        .expect("种子文章失败")
    }

    fn count_rows(db: &Db, table: &str) -> i64 {
        db.read(|conn| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .map_err(|err| CommandError::db("计数", err))
        })
        .expect("计数失败")
    }

    /// `add_days` 的月末/闰年/跨年：能证明「只加天数」的实现会在月末算错。
    #[test]
    fn add_days_handles_month_end_and_leap_year() {
        assert_eq!(add_days("2026-11-06", 1), "2026-11-07");
        assert_eq!(add_days("2026-11-30", 1), "2026-12-01", "11 月只有 30 天");
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01", "跨年");
        assert_eq!(add_days("2028-02-28", 1), "2028-02-29", "闰年 2 月");
        assert_eq!(add_days("2026-02-28", 1), "2026-03-01", "平年 2 月");
        assert_eq!(add_days("2026-11-06", 14), "2026-11-20");
    }

    /// ① 首调建计划 + `completed=1`；② 幂等（二调不改 `next_review_at`）；红线（不碰另两列）。
    #[test]
    fn mark_completed_creates_plan_then_is_idempotent() {
        let (db, dir) = temp_db("mark");
        let article_id = seed_article(&db, "a", "A 篇");

        // 先摆一行「M6 的列」，用来证明 M4 不改它们
        db.write(|tx| {
            tx.execute(
                "INSERT INTO reading_record (article_id, last_position, duration_sec, completed)
                 VALUES (?1, 42, 300, 0)",
                [article_id],
            )
            .map_err(|err| CommandError::db("摆 reading_record", err))?;
            Ok(())
        })
        .expect("摆 M6 列失败");

        let first = mark_article_completed(&db, article_id, TODAY).expect("首调");
        assert_eq!(first.interval_index, 0);
        assert_eq!(first.next_review_at, "2026-11-07", "首次到期 = 明天");
        assert_eq!(first.status, "active");

        let reading: (i64, Option<String>, i64) = db
            .read(|conn| {
                conn.query_row(
                    "SELECT completed, last_position, duration_sec FROM reading_record WHERE article_id = ?1",
                    [article_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|err| CommandError::db("读 reading_record", err))
            })
            .expect("读 reading_record");
        // last_position 是 TEXT 列（001:206），插的是 '42' 字符串——按 TEXT 读再比，别让类型不匹配伪装成失败
        assert_eq!(reading, (1, Some("42".to_string()), 300), "completed=1，但 M6 两列原样");

        // 先把计划推到第二档，再二调：幂等必须「原样返回」，不得打回起点
        complete_review(&db, article_id, "done", TODAY).expect("完成一次");
        let moved = get_review_plan(&db, article_id).expect("读计划").expect("有计划");
        assert_eq!(moved.interval_index, 1);

        let second = mark_article_completed(&db, article_id, "2026-12-25").expect("二调");
        assert_eq!(second, moved, "二调原样返回，不改 next_review_at / interval_index");
        assert_eq!(count_rows(&db, "review_plan"), 1, "不重复 insert");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// ③ 到期过滤 + 排序 + 空数组；④ done 四档顺延；⑤ index=3 → done 终态；⑧ log 记完成前 index。
    #[test]
    fn due_filter_order_and_four_step_advance() {
        let (db, dir) = temp_db("due");
        let a = seed_article(&db, "a", "A 篇");
        let b = seed_article(&db, "b", "B 篇");
        let c = seed_article(&db, "c", "C 篇");

        assert!(get_due_reviews(&db, TODAY).expect("空库").is_empty(), "到期 0 篇是空数组");

        mark_article_completed(&db, a, TODAY).expect("A");
        mark_article_completed(&db, b, TODAY).expect("B");
        mark_article_completed(&db, c, TODAY).expect("C");
        // 把 C 提前到「今天到期」，A/B 仍是明天；再让 B 逾期一天
        db.write(|tx| {
            tx.execute("UPDATE review_plan SET next_review_at = '2026-11-06' WHERE article_id = ?1", [c])
                .map_err(|err| CommandError::db("调 C", err))?;
            tx.execute("UPDATE review_plan SET next_review_at = '2026-11-05' WHERE article_id = ?1", [b])
                .map_err(|err| CommandError::db("调 B", err))?;
            Ok(())
        })
        .expect("调日期");

        let due = get_due_reviews(&db, TODAY).expect("到期查询");
        assert_eq!(
            due.iter().map(|row| row.article_id).collect::<Vec<_>>(),
            vec![b, c],
            "按 next_review_at 升序（逾期在前），未到期的 A 不出现"
        );
        assert_eq!(due[0].title, "B 篇", "带标题");
        assert_eq!(due[0].interval_index, 0, "带档位");

        // 四档顺延：done 依次 +1 → 3 → 7 → 14
        let steps: Vec<(i64, String)> = (0..4)
            .map(|_| {
                let plan = complete_review(&db, a, "done", TODAY).expect("完成");
                (plan.interval_index, plan.next_review_at)
            })
            .collect();
        assert_eq!(
            steps,
            vec![
                (1, "2026-11-09".to_string()),
                (2, "2026-11-13".to_string()),
                (3, "2026-11-20".to_string()),
                (4, "2026-11-06".to_string()),
            ],
            "四次完成依次取 INTERVALS[1..3] = +3/+7/+14；第 4 次 → 终态且 next_review_at 写死为 today"
        );
        let done_plan = get_review_plan(&db, a).expect("读").expect("有");
        assert_eq!(done_plan.status, "done");
        assert!(
            !get_due_reviews(&db, TODAY).expect("到期").iter().any(|row| row.article_id == a),
            "done 不再出现在到期列表（即便 next_review_at = today）"
        );

        // ⑧ log 记完成前 index：A 的 4 条依次 0,1,2,3
        let logs = list_review_logs(&db, Some(a)).expect("日志");
        let mut indexes: Vec<i64> = logs.iter().map(|log| log.interval_index).collect();
        indexes.sort_unstable();
        assert_eq!(indexes, vec![0, 1, 2, 3], "log 记完成前档位");
        assert!(logs.iter().all(|log| log.result == "done"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// ⑥ need_more 不前进；plan 不存在时报 `REVIEW_PLAN_MISSING`。
    #[test]
    fn need_more_does_not_advance_and_missing_plan_is_contract_error() {
        let (db, dir) = temp_db("need");
        let a = seed_article(&db, "a", "A 篇");
        mark_article_completed(&db, a, TODAY).expect("建计划");
        complete_review(&db, a, "done", TODAY).expect("先前进一档");

        let plan = complete_review(&db, a, "need_more", TODAY).expect("need_more");
        assert_eq!(plan.interval_index, 1, "不前进");
        assert_eq!(plan.next_review_at, "2026-11-07", "明天再看");
        assert_eq!(plan.status, "active");

        let log = list_review_logs(&db, Some(a)).expect("日志");
        assert_eq!(log[0].result, "need_more");
        assert_eq!(log[0].interval_index, 1, "need_more 也记完成前档位");

        let b = seed_article(&db, "b", "B 篇");
        let err = complete_review(&db, b, "done", TODAY).expect_err("无计划应报错");
        assert_eq!(err.code, "REVIEW_PLAN_MISSING");

        let bad = complete_review(&db, a, "maybe", TODAY).expect_err("非法 result");
        assert_eq!(bad.code, "invalid_review_result");
        let bad_date = complete_review(&db, a, "done", "2026-11-6").expect_err("非法日期");
        assert_eq!(bad_date.code, "invalid_date");
        assert_eq!(count_rows(&db, "review_log"), 2, "被拒的调用不写日志");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// ⑦ restart：done → active/index 0/明天；plan 不存在时走 INSERT 分支（N5）。
    #[test]
    fn restart_resets_or_inserts() {
        let (db, dir) = temp_db("restart");
        let a = seed_article(&db, "a", "A 篇");
        for _ in 0..4 {
            complete_review(&db, a, "done", TODAY).ok(); // 第一次会失败（无计划），后三次生效
        }
        mark_article_completed(&db, a, TODAY).expect("建计划");
        for _ in 0..4 {
            complete_review(&db, a, "done", TODAY).expect("走完四档");
        }
        assert_eq!(get_review_plan(&db, a).expect("读").expect("有").status, "done");

        let restarted = restart_review_plan(&db, a, TODAY).expect("重启");
        assert_eq!(restarted.status, "active");
        assert_eq!(restarted.interval_index, 0);
        assert_eq!(restarted.next_review_at, "2026-11-07");

        // INSERT 分支：没有 plan 的文章也能重启（NOT NULL 无 DEFAULT → 必须建行）
        let b = seed_article(&db, "b", "B 篇");
        assert!(get_review_plan(&db, b).expect("读").is_none());
        let created = restart_review_plan(&db, b, TODAY).expect("新建");
        assert_eq!(created.status, "active");
        assert_eq!(created.interval_index, 0);
        assert_eq!(created.next_review_at, "2026-11-07");
        assert_eq!(count_rows(&db, "review_plan"), 2);

        // list_review_plans 要拿到**全部**计划（含 done 过的 A 重启后仍 active；B 也在）
        let all = list_review_plans(&db).expect("全部计划");
        assert_eq!(all.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// AC9（Rust 侧）：复习写路径跑完，三表以外行数一格不动，且 `reading_record` 的 M6 两列原样。
    #[test]
    fn review_writes_never_touch_other_tables() {
        let (db, dir) = temp_db("red");
        let a = seed_article(&db, "a", "A 篇");

        const WATCHED: [&str; 13] = [
            "sentence_analysis",
            "token_analysis",
            "lexicon",
            "blank",
            "article",
            "paragraph",
            "sentence",
            "token",
            "vocab_entry",
            "tag",
            "vocab_tag",
            "sentence_note",
            "word_note",
        ];
        let before: Vec<i64> = WATCHED.iter().map(|table| count_rows(&db, table)).collect();
        let settings_before = count_rows(&db, "app_setting");

        mark_article_completed(&db, a, TODAY).expect("完成");
        complete_review(&db, a, "done", TODAY).expect("复习");
        complete_review(&db, a, "need_more", TODAY).expect("再看");
        restart_review_plan(&db, a, TODAY).expect("重启");
        list_review_plans(&db).expect("全部计划");
        list_review_logs(&db, None).expect("日志");

        let after: Vec<i64> = WATCHED.iter().map(|table| count_rows(&db, table)).collect();
        assert_eq!(before, after, "复习写路径不得改动其他表：{WATCHED:?}");
        assert_eq!(settings_before, count_rows(&db, "app_setting"));

        let reading: (i64, Option<String>, i64) = db
            .read(|conn| {
                conn.query_row(
                    "SELECT completed, last_position, duration_sec FROM reading_record WHERE article_id = ?1",
                    [a],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|err| CommandError::db("读 reading_record", err))
            })
            .expect("读 reading_record");
        assert_eq!(reading, (1, None, 0), "只写 completed（另两列保持初值）");

        std::fs::remove_dir_all(&dir).ok();
    }
}