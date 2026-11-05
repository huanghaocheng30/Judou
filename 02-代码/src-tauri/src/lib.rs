// 应用库入口：装配 Tauri Builder 与命令注册（D1 骨架）。
// 业务实现分模块：db（连接/建表/损坏重建）、import（内容导入）、articles（目录与正文读取）。

pub mod articles;
pub mod db;
pub mod import;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

/// 应用级状态：单个 SQLite 连接（命令串行访问）+ 启动期数据库重建信息。
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub db_rebuilt: Option<String>,
    pub pack_dir: PathBuf,
}

#[tauri::command]
fn import_content(
    state: tauri::State<'_, AppState>,
    pack_dir: Option<String>,
) -> Result<import::ImportReport, db::StartupError> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| db::StartupError::Db { message: "数据库连接状态异常（锁中毒）".to_string() })?;
    let dir = pack_dir.map(PathBuf::from).unwrap_or_else(|| state.pack_dir.clone());
    let mut report = import::run_import(&mut conn, &dir)?;
    report.db_rebuilt = state.db_rebuilt.clone();
    Ok(report)
}

#[tauri::command]
fn list_articles(state: tauri::State<'_, AppState>) -> Result<Vec<articles::ArticleSummary>, db::StartupError> {
    let conn = state
        .db
        .lock()
        .map_err(|_| db::StartupError::Db { message: "数据库连接状态异常（锁中毒）".to_string() })?;
    articles::list_articles(&conn)
}

#[tauri::command]
fn get_article_content(
    state: tauri::State<'_, AppState>,
    source_key: String,
) -> Result<articles::ArticleContent, db::StartupError> {
    let conn = state
        .db
        .lock()
        .map_err(|_| db::StartupError::Db { message: "数据库连接状态异常（锁中毒）".to_string() })?;
    articles::get_article_content(&conn, &source_key)
}

/// 解析内容包目录（不拼安装包外绝对路径）：资源目录 → 开发态 ../content-pack → 编译期 CARGO_MANIFEST_DIR。
fn resolve_pack_dir(app: &tauri::AppHandle) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("content-pack", tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    candidates.push(PathBuf::from("../content-pack"));
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../content-pack"));
    }
    candidates
        .iter()
        .find(|p| p.join("manifest.json").exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db_path = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位应用数据目录：{e}"))?
                .join("app.db");
            let (conn, db_rebuilt) = db::open_or_recreate(&db_path).map_err(|e| format!("{e}"))?;
            let pack_dir = resolve_pack_dir(&app.handle().clone());
            app.manage(AppState { db: Mutex::new(conn), db_rebuilt, pack_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![import_content, list_articles, get_article_content])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
