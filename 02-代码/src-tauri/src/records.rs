//! M6 · 记录与统计（D0）——**只读聚合**：时间线 + 六项统计 + 连续天数纯函数。
//!
//! 红线（02 契约 §三.1）：
//! - 只 SELECT，不写 `reading_record` / `review_log` / `*_note` / `vocab_entry`；
//! - 「完成过」的唯一真相仍是 `reading_record.completed`（M4 写入），本模块只统计；
//! - 连续天数算法是**纯函数**（`compute_streak`），单测覆盖 AC3 四例，不引 chrono。

use std::collections::HashSet;

use serde::Serialize;

use crate::commands::CommandError;
use crate::db::Db;

/// 记录页时间线一行（AC1）：标题 / 时长 / 上次位置 / 是否完成。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingRecordView {
    pub article_id: i64,
    pub title: String,
    /// `reading_record.last_position`（M6 起由精读页埋点写入；M6 之前为 NULL）
    pub last_position: Option<String>,
    pub duration_sec: i64,
    pub completed: bool,
    /// SQLite `datetime('now')` 的 UTC 串，原样透出（前端只做展示）
    pub last_read_at: Option<String>,
}

/// 统计卡六项 + 连续天数（AC2）：每一项都能被 `node:sqlite` 直读复算。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    /// `reading_record` 行数（已读篇数）
    pub article_count: i64,
    /// `SUM(completed)`
    pub completed_count: i64,
    /// `SUM(duration_sec)`
    pub total_duration_sec: i64,
    /// `sentence_note + word_note` 条数
    pub note_count: i64,
    /// `vocab_entry` 条数
    pub vocab_count: i64,
    /// `review_log` 条数
    pub review_count: i64,
    /// 连续阅读天数（AC3）
    pub streak: u32,
}

/// 时间线：`last_read_at DESC`（空串排最后），同值时按 id 倒序保证稳定。
pub fn get_reading_records(db: &Db) -> Result<Vec<ReadingRecordView>, CommandError> {
    db.read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT r.article_id, a.title, r.last_position, r.duration_sec, r.completed, r.last_read_at
                   FROM reading_record r
                   JOIN article a ON a.id = r.article_id
               ORDER BY COALESCE(r.last_read_at, '') DESC, r.article_id DESC",
            )
            .map_err(|err| CommandError::db("准备阅读记录查询", err))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ReadingRecordView {
                    article_id: row.get(0)?,
                    title: row.get(1)?,
                    last_position: row.get(2)?,
                    duration_sec: row.get(3)?,
                    completed: row.get::<_, i64>(4)? != 0,
                    last_read_at: row.get(5)?,
                })
            })
            .map_err(|err| CommandError::db("读取阅读记录", err))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| CommandError::db("读取阅读记录", err))?);
        }
        Ok(out)
    })
}

/// 阅读进度埋点（AC4）：进入时 `position` 传空、`seconds=0`（只写 `last_read_at`）；
/// 离开时传当前位置与本次停留秒数，`duration_sec` **累加**（重复进出累加，不覆盖）。
///
/// **不动 `completed`**：那是 M4 `mark_article_completed` 的所有权（02 红线）。
pub fn touch_reading_record(
    db: &Db,
    article_id: i64,
    position: &str,
    seconds: i64,
) -> Result<(), CommandError> {
    if seconds < 0 {
        return Err(CommandError::invalid_setting_value("seconds", "停留秒数不能为负"));
    }
    db.write(|tx| {
        tx.execute(
            "INSERT INTO reading_record (article_id, last_position, duration_sec, completed, last_read_at)
             VALUES (?1, NULLIF(?2, ''), ?3, 0, datetime('now'))
             ON CONFLICT(article_id) DO UPDATE SET
               last_position = COALESCE(NULLIF(?2, ''), last_position),
               duration_sec = duration_sec + ?3,
               last_read_at  = datetime('now')",
            rusqlite::params![article_id, position, seconds],
        )
        .map_err(|err| CommandError::db("记录阅读进度", err))?;
        Ok(())
    })
}

/// 六项统计（一次读事务内取全，避免分次读出现撕裂数）+ 连续天数。
pub fn get_stats(db: &Db, today: &str) -> Result<StatsView, CommandError> {
    let today = validate_today(today)?;
    db.read(|conn| {
        let (article_count, completed_count, total_duration_sec): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(completed), 0), COALESCE(SUM(duration_sec), 0)
                   FROM reading_record",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|err| CommandError::db("统计阅读记录", err))?;

        let note_count: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM sentence_note) + (SELECT COUNT(*) FROM word_note)",
                [],
                |row| row.get(0),
            )
            .map_err(|err| CommandError::db("统计笔记", err))?;
        let vocab_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab_entry", [], |row| row.get(0))
            .map_err(|err| CommandError::db("统计生词", err))?;
        let review_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get(0))
            .map_err(|err| CommandError::db("统计复习", err))?;
        let mut stmt = conn
            .prepare("SELECT DISTINCT substr(last_read_at, 1, 10) FROM reading_record WHERE last_read_at IS NOT NULL")
            .map_err(|err| CommandError::db("准备连续天数查询", err))?;
        let dates: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| CommandError::db("读取阅读日期", err))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CommandError::db("读取阅读日期", err))?;

        Ok(StatsView {
            article_count,
            completed_count,
            total_duration_sec,
            note_count,
            vocab_count,
            review_count,
            streak: compute_streak(&dates, today),
        })
    })
}

/// 连续阅读天数（AC3，纯函数）。
///
/// 契约（02 §三.1）：取 `YYYY-MM-DD` 日期集合去重降序；**今天有记录从今天起算，
/// 今天没有则从昨天起算**；逐日递减，遇缺口停。无记录返回 0。
pub fn compute_streak(dates: &[String], today: &str) -> u32 {
    let Some(today_idx) = parse_date(today) else {
        return 0;
    };
    let set: HashSet<i64> = dates.iter().filter_map(|raw| parse_date(raw)).collect();
    if set.is_empty() {
        return 0;
    }
    let mut cursor = if set.contains(&today_idx) { today_idx } else { today_idx - 1 };
    let mut streak = 0u32;
    while set.contains(&cursor) {
        streak += 1;
        cursor -= 1;
    }
    streak
}

/// `YYYY-MM-DD` → 自 1970-01-01 起的天序号（Howard Hinnant 的 civil-from-days 逆运算）。
///
/// ponytail: 手写日历算术只为不引 `chrono`（与 review.rs `add_days` 同口径）。
/// 天花板：需要时区/夏令时/本地化日历时换 `time` crate，`compute_streak` 签名不变。
fn parse_date(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let (y, m, d) = (&raw[0..4], &raw[5..7], &raw[8..10]);
    if !bytes.iter().take(10).enumerate().all(|(i, b)| {
        if i == 4 || i == 7 {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        }
    }) {
        return None;
    }
    let (year, month, day) = (y.parse::<i64>().ok()?, m.parse::<i64>().ok()?, d.parse::<i64>().ok()?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `today` 校验（与 `review::validate_today` 同口径：只收 `YYYY-MM-DD`）。
fn validate_today(today: &str) -> Result<&str, CommandError> {
    if parse_date(today).is_some() && today.len() == 10 {
        Ok(today)
    } else {
        Err(CommandError::invalid_date(today))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dates(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// AC3-a：连续 3 天（今天在内）= 3。
    #[test]
    fn streak_counts_three_consecutive_days() {
        let d = dates(&["2026-11-07", "2026-11-06", "2026-11-05"]);
        assert_eq!(compute_streak(&d, "2026-11-07"), 3);
    }

    /// AC3-b：断档 1 天 → 从断点后重算（11-07 有、11-06 无、11-05/04 有 ⇒ 1）。
    #[test]
    fn streak_breaks_at_gap() {
        let d = dates(&["2026-11-07", "2026-11-05", "2026-11-04"]);
        assert_eq!(compute_streak(&d, "2026-11-07"), 1);
    }

    /// AC3-c：今天未读 → 算到昨天（昨天/前天/大前天连续 ⇒ 3）。
    #[test]
    fn streak_ends_yesterday_when_today_unread() {
        let d = dates(&["2026-11-06", "2026-11-05", "2026-11-04"]);
        assert_eq!(compute_streak(&d, "2026-11-07"), 3);
    }

    /// AC3-d：跨月（2026-10-31 → 11-01）连续 ⇒ 2；再加 10-30 ⇒ 3。
    #[test]
    fn streak_crosses_month_boundary() {
        let d = dates(&["2026-11-01", "2026-10-31"]);
        assert_eq!(compute_streak(&d, "2026-11-01"), 2);
        let d = dates(&["2026-11-01", "2026-10-31", "2026-10-30"]);
        assert_eq!(compute_streak(&d, "2026-11-01"), 3);
    }

    /// AC3-e：空集合 / 今天之前的孤立记录（昨天以前，今天和昨天都没读）⇒ 0。
    #[test]
    fn streak_is_zero_without_recent_days() {
        assert_eq!(compute_streak(&[], "2026-11-07"), 0);
        assert_eq!(compute_streak(&dates(&["2026-11-01"]), "2026-11-07"), 0);
    }

    /// AC3-f：跨年（2026-12-31 → 2027-01-01）+ 乱序/重复/带时刻串 ⇒ 去重后连续 3。
    #[test]
    fn streak_crosses_year_and_dedupes() {
        let d = dates(&["2027-01-01 08:00:00", "2026-12-31", "2027-01-01", "2026-12-30", "bad"]);
        assert_eq!(compute_streak(&d, "2027-01-01"), 3);
    }

    /// days_from_civil 基准：1970-01-01 = 0；2000-03-01 = 11017（外部可查）。
    #[test]
    fn civil_day_numbers_are_correct() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
        assert_eq!(days_from_civil(2026, 11, 7) - days_from_civil(2026, 11, 6), 1);
    }

    /// 统计命令只读：调用前后 `total_changes()` 不增（AC2 的 Rust 侧判据）。
    #[test]
    fn stats_and_records_do_not_write() {
        let db = crate::db::Db::open_in_memory_for_tests().expect("内存库应成功");
        db.write(|tx| {
            tx.execute(
                "INSERT INTO article (source_key, title, visibility) VALUES ('k1', 'T1', 'system')",
                [],
            )
            .map_err(|err| CommandError::db("摆 article", err))?;
            tx.execute(
                "INSERT INTO reading_record (article_id, duration_sec, completed, last_read_at)
                 VALUES (1, 120, 1, '2026-11-05 10:00:00')",
                [],
            )
            .map_err(|err| CommandError::db("摆 reading_record", err))?;
            Ok(())
        })
        .expect("摆数据");

        let before = db.total_changes().expect("读写入计数");
        let stats = get_stats(&db, "2026-11-05").expect("统计应成功");
        let list = get_reading_records(&db).expect("时间线应成功");
        let after = db.total_changes().expect("读写入计数");

        assert_eq!(before, after, "统计与时间线只读：total_changes 不增");
        assert_eq!(stats.article_count, 1);
        assert_eq!(stats.completed_count, 1);
        assert_eq!(stats.total_duration_sec, 120);
        assert_eq!(stats.streak, 1);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "T1");
        assert!(list[0].completed);
    }

}
