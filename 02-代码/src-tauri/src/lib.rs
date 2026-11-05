//! 句读 Tauri 后端入口装配：数据库 state + 内容包导入 + 命令注册。
//! 分工（02 D1）：本文件只负责「装」，命令实现全在 commands.rs、库逻辑在 db.rs、
//! 内容包解析在 pack.rs、导入引擎在 import.rs。
//!
//! **启动纪律（N1 / O3）**：setup 内初始化失败**不得**向上返回 `Err`——本文件末尾
//! `run().expect("启动句读失败")` 会把任何 `Err` 直接变成进程 panic，窗口都开不出来，
//! 错误页永远显示不出来。正确形态是：捕获 → `manage(StartupState::Failed)` → 正常 `Ok(())`。

mod commands;
mod db;
mod import;
mod pack;

use tauri::{AppHandle, Manager};

use db::Db;
use pack::{PackLabels, PackPath, StartupErrorInfo, StartupState};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            match setup(app.handle()) {
                Ok(()) => {
                    app.manage(StartupState::Running);
                }
                Err(info) => {
                    eprintln!("[judou] 启动失败：kind={} message={}", info.kind, info.message);
                    app.manage(StartupState::Failed(info));
                    // 错误页会先渲染、不调业务命令；这里补一份空标签表，避免命令层 state 缺失时
                    // 报出与真实原因无关的第二个错（诊断噪音）。
                    if app.try_state::<PackLabels>().is_none() {
                        app.manage(PackLabels::default());
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_settings,
            commands::set_setting,
            commands::list_articles,
            commands::get_article_content,
            commands::list_article_filter_options,
            commands::import_content_pack,
            commands::get_startup_error
        ])
        .run(tauri::generate_context!())
        .expect("启动句读失败");
}

/// 正常启动：开库 → 定位内容包 → 导入 → 注册 state。任何一步失败都转成错误页信息。
fn setup(app: &AppHandle) -> Result<(), StartupErrorInfo> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| StartupErrorInfo::new("db_error", format!("无法定位应用数据目录：{err}"), None))?;
    let db = Db::open(data_dir.join("judou.db"))
        .map_err(|err| StartupErrorInfo::new("db_error", err.message.clone(), None))?;
    // R4：启动打印库路径与版本（自测与后续包都按这一行取路径）
    println!("[judou] db path = {}", db.path().display());
    println!("[judou] app version = {}", env!("CARGO_PKG_VERSION"));
    // 先注册库：内容包坏掉时主题等 UI 偏好仍可读（O3 只有「库打不开」才拿不到 Db）
    app.manage(db);

    let resource_dir = app.path().resource_dir().ok();
    let pack_dir = pack::resolve_pack_dir(resource_dir.as_deref())?;
    let manifest = pack::load_manifest(&pack_dir)?;

    // 内置内容包导入（幂等；失败不是 panic，而是错误页）
    let report = import::run(app.state::<Db>().inner(), &pack_dir, &manifest)?;
    println!(
        "[judou] import report = imported {} / skipped {} / {}ms",
        report.imported, report.skipped, report.elapsed_ms
    );

    app.manage(PackLabels::from_manifest(&manifest));
    app.manage(PackPath(pack_dir));
    Ok(())
}
