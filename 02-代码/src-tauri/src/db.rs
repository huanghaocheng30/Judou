// SQLite 连接、10 张表 schema、损坏检测与 app.db.bak-* 备份重建（02 §三 D3/D6）。

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// 启动异常（D3 产出，D6/前端 error.ts 消费）。序列化为 `{kind, ...}`，kind 为 camelCase。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StartupError {
    PackMissing { file: String },
    PackCorrupt { file: String, detail: String },
    PackInvalid { file: String, detail: String },
    Db { message: String },
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupError::PackMissing { file } => write!(f, "内容包缺失：{file}"),
            StartupError::PackCorrupt { file, detail } => write!(f, "内容包损坏：{file}（{detail}）"),
            StartupError::PackInvalid { file, detail } => write!(f, "内容包不完整：{file}（{detail}）"),
            StartupError::Db { message } => write!(f, "本地库异常：{message}"),
        }
    }
}

impl From<rusqlite::Error> for StartupError {
    fn from(e: rusqlite::Error) -> Self {
        StartupError::Db { message: e.to_string() }
    }
}

/// 本包建 10 张表；`note`/`vocab`/`progress` 属后续包，本包不建（物理分表铁律 04 §三）。
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article (
  sourceKey     TEXT PRIMARY KEY,
  articleId     TEXT NOT NULL,
  setNo         INTEGER NOT NULL,
  section       TEXT NOT NULL,
  passageLabel  TEXT NOT NULL,
  title         TEXT NOT NULL,
  examYear      INTEGER NOT NULL,
  examMonth     INTEGER NOT NULL,
  wordCount     INTEGER NOT NULL,
  sentenceCount INTEGER NOT NULL,
  packVersion   TEXT NOT NULL,
  contentHash   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paragraph (
  articleKey TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (articleKey, idx)
);

CREATE TABLE IF NOT EXISTS sentence (
  articleKey TEXT NOT NULL,
  paraIdx    INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  start      INTEGER NOT NULL,
  "end"      INTEGER NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (articleKey, paraIdx, idx)
);

CREATE TABLE IF NOT EXISTS token (
  articleKey TEXT NOT NULL,
  paraIdx    INTEGER NOT NULL,
  sentIdx    INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  start      INTEGER NOT NULL,
  "end"      INTEGER NOT NULL,
  surface    TEXT NOT NULL,
  normalized TEXT,
  isWord     INTEGER NOT NULL,
  PRIMARY KEY (articleKey, paraIdx, sentIdx, idx)
);

CREATE TABLE IF NOT EXISTS sentence_analysis (
  articleKey         TEXT NOT NULL,
  paraIdx            INTEGER NOT NULL,
  sentIdx            INTEGER NOT NULL,
  translationLiteral TEXT,
  translationNatural TEXT,
  structMarkup       TEXT,
  structureSummary   TEXT,
  paragraphRole      TEXT,
  components         TEXT,
  clauses            TEXT,
  phrases            TEXT,
  pitfalls           TEXT,
  PRIMARY KEY (articleKey, paraIdx, sentIdx)
);

CREATE TABLE IF NOT EXISTS token_analysis (
  articleKey     TEXT NOT NULL,
  paraIdx        INTEGER NOT NULL,
  sentIdx        INTEGER NOT NULL,
  idx            INTEGER NOT NULL,
  phonetic       TEXT,
  pos            TEXT,
  senseInContext TEXT,
  collocations   TEXT,
  examples       TEXT,
  isCet4HighFreq INTEGER NOT NULL,
  more           TEXT,
  PRIMARY KEY (articleKey, paraIdx, sentIdx, idx)
);

CREATE TABLE IF NOT EXISTS lexicon (
  word           TEXT PRIMARY KEY,
  phonetic       TEXT,
  pos            TEXT,
  sense          TEXT,
  lemma          TEXT,
  collocations   TEXT,
  examples       TEXT,
  isCet4HighFreq INTEGER NOT NULL,
  more           TEXT
);

CREATE TABLE IF NOT EXISTS question (
  articleKey TEXT NOT NULL,
  no         INTEGER NOT NULL,
  stem       TEXT NOT NULL,
  options    TEXT NOT NULL,
  answer     TEXT,
  PRIMARY KEY (articleKey, no)
);

CREATE TABLE IF NOT EXISTS blank (
  articleKey TEXT NOT NULL,
  no         INTEGER NOT NULL,
  answerKey  TEXT NOT NULL,
  answerWord TEXT NOT NULL,
  reason     TEXT,
  distractors TEXT,
  PRIMARY KEY (articleKey, no)
);
"#;

fn open_and_init(path: &Path) -> Result<Connection, StartupError> {
    let conn = Connection::open(path).map_err(|e| StartupError::Db { message: format!("打开数据库失败 {}：{e}", path.display()) })?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| StartupError::Db { message: format!("初始化数据库结构失败：{e}") })?;
    Ok(conn)
}

/// 可读性探测：非 SQLite 字节会在 `PRAGMA schema_version` 处失败（D6 判定口径）。
fn probe_readable(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

/// 备份文件名 `app.db.bak-YYYYMMDD-HHmm`。
// ponytail: 时间戳用 UTC（无本地时区依赖、零额外 crate）；需要本地时间显示时再引入 time/chrono。
fn backup_name() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("app.db.bak-{y:04}{m:02}{d:02}-{:02}{:02}", rem / 3600, (rem % 3600) / 60)
}

/// Howard Hinnant 的 civil_from_days（UTC 年月日，无外部依赖）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 打开本地库；文件存在但不可读（非 SQLite 字节）时备份为 app.db.bak-* 并重建空库。
/// 返回 `(连接, 备份文件名)`；正常打开时备份名为 None。
pub fn open_or_recreate(path: &Path) -> Result<(Connection, Option<String>), StartupError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| StartupError::Db { message: format!("无法创建应用数据目录 {}：{e}", parent.display()) })?;
    }

    if !path.exists() {
        return Ok((open_and_init(path)?, None));
    }

    if probe_readable(path).is_ok() {
        return Ok((open_and_init(path)?, None));
    }

    // 损坏：先落备份，再清残留日志，最后建新库（AC9②）。
    let backup = backup_name();
    let backup_path = path.with_file_name(backup.clone());
    std::fs::rename(path, &backup_path)
        .map_err(|e| StartupError::Db { message: format!("备份损坏数据库失败 {}：{e}", backup_path.display()) })?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let _ = std::fs::remove_file(with_suffix(path, suffix));
    }
    let conn = open_and_init(path)?;
    Ok((conn, Some(backup)))
}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_722), (2023, 12, 31));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }
}
