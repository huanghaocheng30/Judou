//! 本地库：连接（`Mutex<Connection>`）、迁移执行、`app_setting` 读写。
//! 纪律：写操作一律走事务（docs D1 §11.4）；`stmt` 在 commit 前 drop；
//! 已发布的迁移文件不得修改（§11.6），新增结构走 002_*.sql。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::commands::CommandError;

/// 迁移清单：(版本号, SQL 原文)，**严格升序**、按 `schema_meta.version` 游标逐个执行。
/// 001 已发布冻结；后续结构变更一律追加新文件（002 起），不回头改老文件。
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/001_init.sql")),
    (2, include_str!("../migrations/002_add_import_columns.sql")),
    (3, include_str!("../migrations/003_answer_source.sql")),
];

pub struct Db {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Db {
    /// 打开（必要时创建）库文件 → 开外键 → 执行未应用的迁移。
    pub fn open(path: PathBuf) -> Result<Self, CommandError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| CommandError::db_io("创建数据目录", err))?;
        }

        let conn = Connection::open(&path).map_err(|err| CommandError::db("打开本地库", err))?;
        // 外键级联必须在事务外开启（SQLite 语义）
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|err| CommandError::db("开启外键约束", err))?;

        let db = Self {
            conn: Mutex::new(conn),
            path,
        };
        db.migrate()?;
        Ok(db)
    }

    /// 测试专用：内存库（迁移照跑）。
    ///
    /// 只在 `cfg(test)` 下存在——门禁 bin / 生产代码拿不到它，避免「内存库」误入真路径。
    #[cfg(test)]
    pub fn open_in_memory_for_tests() -> Result<Self, CommandError> {
        let conn = Connection::open_in_memory().map_err(|err| CommandError::db("打开内存库", err))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|err| CommandError::db("开启外键约束", err))?;
        let db = Self {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 只读借用连接（查询用）：锁在闭包结束时释放，闭包内只应 SELECT。
    /// 抽这一层是为了让命令层/导入核对共用一把锁，不用各自摸 `Mutex`。
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T, CommandError>) -> Result<T, CommandError> {
        let conn = self.lock()?;
        f(&conn)
    }

    /// 写事务：闭包拿到 `&Transaction`（可一次 prepare 多条语句批量执行），
    /// 返回 `Ok` 才提交，`Err` 整体回滚（导入中途失败不会留下半套数据）。
    pub fn write<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|err| CommandError::db("开启写事务", err))?;
        let value = f(&tx)?;
        tx.commit().map_err(|err| CommandError::db("提交写事务", err))?;
        Ok(value)
    }

    /// 可变借用连接（rusqlite `Backup` API 需要 `&mut Connection`）。
    ///
    /// 只给 `export::restore_db` 用：调用方必须先写 `pre-restore` 备份（02 §三.3），
    /// 否则页级覆盖中途失败会留下半状态。
    pub fn with_conn_mut<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let mut conn = self.lock()?;
        f(&mut conn)
    }

    /// 连接累计写入行数（SQLite `total_changes`）。
    /// AC3 用它做辅证：同一进程内导入前后差值 = 0 ⇒ 这次没有写任何行。
    pub fn total_changes(&self) -> Result<i64, CommandError> {
        let conn = self.lock()?;
        conn.query_row("SELECT total_changes()", [], |row| row.get(0))
            .map_err(|err| CommandError::db("读取写入计数", err))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, CommandError> {
        self.conn.lock().map_err(|_| CommandError::db_busy())
    }

    /// 顺序执行 version > 当前游标的迁移，每个迁移一个事务。
    ///
    /// 注意：**不在这里预建 schema_meta**——它是 001_init.sql 定义的 19 张表之一，
    /// 由迁移本体创建（唯一来源）；否则框架与迁移各写一份定义，先建后建必然撞
    /// `table schema_meta already exists`（2026-11-05 实测错误）。
    fn migrate(&self) -> Result<(), CommandError> {
        let mut conn = self.lock()?;

        let has_meta: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta')",
                [],
                |row| row.get(0),
            )
            .map_err(|err| CommandError::db("检查版本表", err))?;

        let current: i64 = if has_meta {
            conn.query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|err| CommandError::db("读取 schema 版本", err))?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0)
        } else {
            0
        };

        for (version, sql) in MIGRATIONS {
            if *version <= current {
                continue;
            }
            let tx = conn.transaction().map_err(|err| CommandError::db("开启迁移事务", err))?;
            tx.execute_batch(sql)
                .map_err(|err| CommandError::db("执行迁移", err))?;
            tx.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [version.to_string()],
            )
            .map_err(|err| CommandError::db("写回 schema 版本", err))?;
            tx.commit().map_err(|err| CommandError::db("提交迁移", err))?;
        }
        Ok(())
    }

    /// 读 app_setting 全量（docs C3 §5.8）
    pub fn settings(&self) -> Result<HashMap<String, String>, CommandError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM app_setting ORDER BY key")
            .map_err(|err| CommandError::db("准备设置查询", err))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| CommandError::db("读取设置", err))?;

        let mut out = HashMap::new();
        for row in rows {
            let (key, value) = row.map_err(|err| CommandError::db("读取设置", err))?;
            out.insert(key, value);
        }
        Ok(out)
    }

    /// 写单个设置（upsert），事务内完成
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), CommandError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|err| CommandError::db("开启写事务", err))?;
        tx.execute(
            "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map_err(|err| CommandError::db("写入设置", err))?;
        tx.commit().map_err(|err| CommandError::db("提交设置", err))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-test-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        dir.join("judou.db")
    }

    /// 首次迁移必须建出 19 张表并写 version=3（001 建表 + 002 加 3 列 + 003 加 answer_source）。
    /// 这条用例能证明失败：迁移框架若预建 schema_meta，001 的 CREATE TABLE 会撞
    /// `table schema_meta already exists`（2026-11-05 真机 dev 启动实测该错）。
    #[test]
    fn open_creates_19_tables_and_version_3() {
        let path = temp_db_path("migrate");
        let db = Db::open(path.clone()).expect("首次迁移应成功");
        {
            let conn = db.conn.lock().expect("锁未中毒");
            let tables: Vec<String> = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .expect("查询表清单失败")
                .query_map([], |row| row.get::<_, String>(0))
                .expect("游标失败")
                .map(|row| row.expect("行读取失败"))
                .collect();
            assert_eq!(tables.len(), 19, "表数应为 19，实测 {tables:?}");
            let version: String = conn
                .query_row("SELECT value FROM schema_meta WHERE key='version'", [], |row| row.get(0))
                .expect("读 version 失败");
            assert_eq!(version, "3");
        }
        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// M5c AC12：003 迁移必须真的执行（编号复用 002 会被版本游标跳过，列永远不存在）。
    /// 这条用例能证明失败：把 MIGRATIONS 里的 3 改回 2 后本用例 FAIL（`question` 缺列）。
    #[test]
    fn migration_003_adds_answer_source_with_none_default() {
        let path = temp_db_path("answer-source");
        let db = Db::open(path.clone()).expect("迁移应成功");
        {
            let conn = db.conn.lock().expect("锁未中毒");
            let columns: Vec<(String, String, Option<String>)> = conn
                .prepare("PRAGMA table_info(question)")
                .expect("PRAGMA 失败")
                .query_map([], |row| Ok((row.get(1)?, row.get(2)?, row.get(4)?)))
                .expect("游标失败")
                .map(|row| row.expect("行读取失败"))
                .collect();
            let column = columns
                .into_iter()
                .find(|(name, _, _)| name == "answer_source")
                .unwrap_or_else(|| panic!("question 缺列 answer_source（003 未执行？）"));
            assert_eq!(column.1, "TEXT");
            assert_eq!(column.2.as_deref(), Some("'none'"));
        }
        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// 002 三列必须落地，且类型/默认值符合 02 D1（AC2 的 Rust 侧判据）。
    /// 这条用例能证明失败：只跑 001 时三列都不存在（本包改造前实测 FAIL）。
    #[test]
    fn migration_002_adds_three_columns() {
        let path = temp_db_path("cols");
        let db = Db::open(path.clone()).expect("迁移应成功");
        {
            let conn = db.conn.lock().expect("锁未中毒");
            let col = |table: &str, name: &str| -> (String, String, Option<String>) {
                let rows: Vec<(String, String, Option<String>)> = conn
                    .prepare(&format!("PRAGMA table_info({table})"))
                    .expect("PRAGMA 失败")
                    .query_map([], |row| Ok((row.get(1)?, row.get(2)?, row.get(4)?)))
                    .expect("游标失败")
                    .map(|row| row.expect("行读取失败"))
                    .collect();
                rows.into_iter()
                    .find(|(n, _, _)| n == name)
                    .unwrap_or_else(|| panic!("{table} 缺列 {name}"))
            };
            let (_, is_word_ty, is_word_default) = col("token", "is_word");
            assert_eq!(is_word_ty, "INTEGER", "token.is_word 应为 INTEGER");
            assert_eq!(is_word_default.as_deref(), Some("1"), "token.is_word 默认应为 1");
            let (_, pack_ty, pack_default) = col("article", "pack_version");
            assert_eq!(pack_ty, "TEXT", "article.pack_version 应为 TEXT");
            assert_eq!(pack_default, None, "article.pack_version 不应有默认值");
            let (_, count_ty, count_default) = col("article", "sentence_count");
            assert_eq!(count_ty, "INTEGER", "article.sentence_count 应为 INTEGER");
            assert_eq!(count_default.as_deref(), Some("0"), "sentence_count 默认应为 0");
        }
        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// 二次打开不得重跑迁移（版本游标生效），且设置读写闭环成立。
    #[test]
    fn reopen_is_idempotent_and_settings_roundtrip() {
        let path = temp_db_path("reopen");
        Db::open(path.clone()).expect("首次打开失败");
        let db = Db::open(path.clone()).expect("二次打开不应重跑迁移");
        db.set_setting("theme", "dark").expect("写设置失败");
        let settings = db.settings().expect("读设置失败");
        assert_eq!(settings.get("theme").map(String::as_str), Some("dark"));
        assert_eq!(settings.get("guide_shown").map(String::as_str), Some("0"));
        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }
}
