// 集成测试：直接复用产品代码路径（db::open_or_recreate / import::run_import / articles::*），
// 覆盖 AC2 / AC3 / AC6 / AC9② 与 AC9①（Rust 侧内容包异常分支）。
// 运行：cd src-tauri && cargo test -- --test-threads=1 --nocapture
//
// 主流程库固定落在 <项目根>/.tmp/TP1/verify/app.db，供 node scripts/verify-render.mjs 只读查询取证。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use cet4_reading_lib::{articles, db, import};
use rusqlite::Connection;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("02-代码 目录").to_path_buf()
}

fn project_root() -> PathBuf {
    repo_root().parent().expect("项目根").to_path_buf()
}

fn pack_dir() -> PathBuf {
    repo_root().join("content-pack")
}

fn verify_dir() -> PathBuf {
    project_root().join(".tmp").join("TP1").join("verify")
}

fn clean_db_files(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("app.db") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).expect("count")
}

fn rowids(conn: &Connection) -> Vec<i64> {
    let mut stmt = conn.prepare("SELECT rowid FROM article ORDER BY rowid").expect("prepare rowid");
    let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).expect("query rowid");
    rows.map(|r| r.expect("rowid")).collect()
}

fn file_stat(path: &Path) -> (u64, SystemTime, Vec<u8>) {
    let meta = fs::metadata(path).expect("metadata");
    let mtime = meta.modified().expect("mtime");
    let bytes = fs::read(path).expect("read bytes");
    (meta.len(), mtime, bytes)
}

fn value_of(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| r.get::<_, String>(0)).ok()
}

#[test]
fn ac2_ac3_ac6_ac9b_import_flow() {
    let dir = verify_dir();
    fs::create_dir_all(&dir).expect("create verify dir");
    clean_db_files(&dir);
    let db_path = dir.join("app.db");

    // ---------- AC2：首次导入 ----------
    let (mut conn, rebuilt) = db::open_or_recreate(&db_path).expect("open fresh db");
    assert!(rebuilt.is_none(), "新库不应触发重建");
    let report1 = import::run_import(&mut conn, &pack_dir()).expect("first import");
    println!("[AC2] report1 = {}", serde_json::to_string(&report1).unwrap());
    println!(
        "[AC2] counts article={} paragraph={} sentence={} token={} lexicon={} question={} blank={} token_analysis={} sentence_analysis={}",
        count(&conn, "article"),
        count(&conn, "paragraph"),
        count(&conn, "sentence"),
        count(&conn, "token"),
        count(&conn, "lexicon"),
        count(&conn, "question"),
        count(&conn, "blank"),
        count(&conn, "token_analysis"),
        count(&conn, "sentence_analysis"),
    );
    let forbidden: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note','vocab','progress')")
            .expect("prepare forbidden");
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).expect("query forbidden");
        rows.map(|r| r.expect("forbidden")).collect()
    };
    println!("[AC2] forbidden_tables = {forbidden:?}");
    println!("[AC2] packVersion = {:?}", value_of(&conn, "packVersion"));

    assert_eq!(report1.imported, 12, "AC2 imported");
    assert_eq!(report1.updated, 0, "AC2 updated");
    assert_eq!(report1.skipped, 0, "AC2 skipped");
    assert_eq!(report1.pack_version, "2023-12-v1", "AC2 packVersion");
    assert!(report1.elapsed_ms < 2000, "AC2 elapsedMs<2000，实际 {}", report1.elapsed_ms);
    assert_eq!(count(&conn, "article"), 12);
    assert_eq!(count(&conn, "paragraph"), 90);
    assert_eq!(count(&conn, "sentence"), 274);
    assert_eq!(count(&conn, "token"), 6699);
    assert_eq!(count(&conn, "lexicon"), 1561);
    assert_eq!(count(&conn, "question"), 90);
    assert_eq!(count(&conn, "blank"), 30);
    assert!(forbidden.is_empty(), "本包不得建 note/vocab/progress：{forbidden:?}");
    assert_eq!(value_of(&conn, "packVersion").as_deref(), Some("2023-12-v1"));

    let first_rowids = rowids(&conn);
    drop(conn);
    let (size1, mtime1, bytes1) = file_stat(&db_path);

    // ---------- AC3：再次启动不重复导入、不写库 ----------
    let (mut conn2, rebuilt2) = db::open_or_recreate(&db_path).expect("reopen db");
    assert!(rebuilt2.is_none(), "正常库不应触发重建");
    let report2 = import::run_import(&mut conn2, &pack_dir()).expect("second import");
    let rowids2 = rowids(&conn2);
    drop(conn2);
    let (size2, mtime2, bytes2) = file_stat(&db_path);
    println!("[AC3] report2 = {}", serde_json::to_string(&report2).unwrap());
    println!(
        "[AC3] size_before={size1} size_after={size2} mtime_equal={} bytes_equal={} rowid_equal={}",
        mtime1 == mtime2,
        bytes1 == bytes2,
        first_rowids == rowids2
    );
    assert_eq!(report2.imported, 0, "AC3 imported=0");
    assert_eq!(report2.updated, 0, "AC3 updated=0（出现 updated:12 即失败）");
    assert_eq!(report2.skipped, 12, "AC3 skipped=12");
    assert!(report2.elapsed_ms < 2000, "AC3 elapsedMs<2000，实际 {}", report2.elapsed_ms);
    assert_eq!(size1, size2, "AC3 库文件大小未变");
    assert!(mtime1 == mtime2, "AC3 库文件 mtime 未变");
    assert!(bytes1 == bytes2, "AC3 库文件字节未变");
    assert_eq!(first_rowids, rowids2, "AC3 article rowid 清单不变");

    // ---------- AC6：删库后完整重建 ----------
    fs::remove_file(&db_path).expect("remove db");
    let (mut conn3, rebuilt3) = db::open_or_recreate(&db_path).expect("open after delete");
    assert!(rebuilt3.is_none(), "删库后是新库，不是损坏重建");
    let report3 = import::run_import(&mut conn3, &pack_dir()).expect("import after delete");
    println!("[AC6] report3 = {}", serde_json::to_string(&report3).unwrap());
    println!(
        "[AC6] article={} sentence={} packVersion={:?}",
        count(&conn3, "article"),
        count(&conn3, "sentence"),
        value_of(&conn3, "packVersion")
    );
    assert_eq!(count(&conn3, "article"), 12, "AC6 12 篇恢复");
    assert_eq!(count(&conn3, "sentence"), 274, "AC6 274 句恢复");
    assert_eq!(value_of(&conn3, "packVersion").as_deref(), Some("2023-12-v1"), "AC6 packVersion 恢复");
    drop(conn3);

    // ---------- AC9②：库文件损坏 → 备份 + 重建 + 重新导入 ----------
    let mut junk = vec![0u8; 1024];
    for (i, b) in junk.iter_mut().enumerate() {
        *b = ((i * 37 + 11) % 251) as u8;
    }
    fs::write(&db_path, &junk).expect("write junk db");
    let (mut conn4, rebuilt4) = db::open_or_recreate(&db_path).expect("recover corrupt db");
    let backup = rebuilt4.clone().expect("损坏库应产生备份文件名");
    let backup_path = dir.join(backup.strip_prefix("app.db.bak-").map(|s| format!("app.db.bak-{s}")).unwrap_or_else(|| backup.clone()));
    let bak_files: Vec<String> = fs::read_dir(&dir)
        .expect("read dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("app.db.bak-"))
        .collect();
    let report4 = import::run_import(&mut conn4, &pack_dir()).expect("import after rebuild");
    println!("[AC9-2] rebuilt = {backup}");
    println!("[AC9-2] backup_files = {bak_files:?}");
    println!("[AC9-2] report4 = {}", serde_json::to_string(&report4).unwrap());
    println!(
        "[AC9-2] article={} sentence={} packVersion={:?}",
        count(&conn4, "article"),
        count(&conn4, "sentence"),
        value_of(&conn4, "packVersion")
    );
    assert!(backup.starts_with("app.db.bak-"), "AC9② 备份名格式 app.db.bak-YYYYMMDD-HHmm：{backup}");
    assert!(backup_path.exists(), "AC9② 备份文件存在：{backup_path:?}");
    assert!(!bak_files.is_empty(), "AC9② 同目录出现 app.db.bak-*");
    assert_eq!(count(&conn4, "article"), 12, "AC9② 重建后 12 篇");
    assert_eq!(count(&conn4, "sentence"), 274, "AC9② 重建后 274 句");
    assert_eq!(value_of(&conn4, "packVersion").as_deref(), Some("2023-12-v1"), "AC9② 重建后 packVersion");
    drop(conn4);

    // 恢复成一个正常库，供 node 脚本只读取证
    clean_db_files(&dir);
    let (mut conn5, _) = db::open_or_recreate(&db_path).expect("final fresh db");
    let final_report = import::run_import(&mut conn5, &pack_dir()).expect("final import");
    println!("[FINAL] report = {}", serde_json::to_string(&final_report).unwrap());
    println!("[FINAL] db_path = {}", db_path.display());
    assert_eq!(count(&conn5, "article"), 12);
    assert_eq!(articles::list_articles(&conn5).expect("list_articles").len(), 12);
}

#[test]
fn ac9a_pack_missing_and_corrupt() {
    let dir = project_root().join(".tmp").join("TP1").join("pack-fixture");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create fixture dir");
    let db_path = dir.join("fixture.db");
    let (mut conn, _) = db::open_or_recreate(&db_path).expect("open fixture db");

    // 缺失 manifest
    let err = import::run_import(&mut conn, &dir).expect_err("空目录应报 PackMissing");
    println!("[AC9-1] missing_err = {err}");
    match &err {
        db::StartupError::PackMissing { file } => {
            assert!(file.contains("manifest.json"), "AC9① 报错含缺失文件名：{file}");
        }
        other => panic!("期望 PackMissing，实际 {other:?}"),
    }

    // 损坏 manifest
    let manifest = dir.join("manifest.json");
    fs::write(&manifest, b"{ this is not json").expect("write corrupt manifest");
    let err2 = import::run_import(&mut conn, &dir).expect_err("坏 manifest 应报 PackCorrupt");
    println!("[AC9-1] corrupt_err = {err2}");
    match &err2 {
        db::StartupError::PackCorrupt { file, detail } => {
            assert!(file.contains("manifest.json"), "AC9① 报错含损坏文件名：{file}");
            assert!(!detail.is_empty(), "AC9① 损坏详情非空");
        }
        other => panic!("期望 PackCorrupt，实际 {other:?}"),
    }

    drop(conn);
    let _ = fs::remove_dir_all(&dir);
}
