//! 本地库：连接（`Mutex<Connection>`）、迁移执行、`app_setting` 读写。
//! 纪律：写操作一律走事务（docs D1 §11.4）；`stmt` 在 commit 前 drop；
//! 已发布的迁移文件不得修改（§11.6），新增结构走 002_*.sql。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::commands::CommandError;

/// 迁移清单：(版本号, SQL 原文)。M0 只有 001。
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/001_init.sql"))];

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

    pub fn path(&self) -> &Path {
        &self.path
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

    /// 首次迁移必须建出 19 张表并写 version=1。
    /// 这条用例能证明失败：迁移框架若预建 schema_meta，001 的 CREATE TABLE 会撞
    /// `table schema_meta already exists`（2026-11-05 真机 dev 启动实测该错）。
    #[test]
    fn open_creates_19_tables_and_version_1() {
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
            assert_eq!(version, "1");
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
