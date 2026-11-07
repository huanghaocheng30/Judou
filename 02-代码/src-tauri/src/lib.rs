//! 句读 Tauri 后端入口装配：数据库 state + 内容包导入 + 命令注册。
//! 分工（02 D1）：本文件只负责「装」，命令实现全在 commands.rs、库逻辑在 db.rs、
//! 内容包解析在 pack.rs、导入引擎在 import.rs。
//!
//! **启动纪律（N1 / O3）**：setup 内初始化失败**不得**向上返回 `Err`——本文件末尾
//! `run().expect("启动句读失败")` 会把任何 `Err` 直接变成进程 panic，窗口都开不出来，
//! 错误页永远显示不出来。正确形态是：捕获 → `manage(StartupState::Failed)` → 正常 `Ok(())`。

mod analysis;
// M5b（02 D1/R6）：`pub` 是给门禁 bin（`src/bin/ai_import_cli.rs`）用的——它要直调库层的
// `commit_ai_import` / `patch_ai_analysis`（SQL 只在 `ai_import.rs` 里，bin 不复制）。
pub mod ai_import;
pub mod commands;
// `pub` 是给门禁 bin（`src/bin/import_user_cli.rs`，D8 契约）用的：它要开临时库跑真事务。
// 默认可见性不变（crate 外只有同仓的这个 bin 引用）。
pub mod db;
mod import;
pub mod import_user;
mod pack;
mod review;
mod vocab;

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
            commands::get_startup_error,
            // M2 · 解析 / 词卡 / 空格 / 笔记（8 个；实现见 analysis.rs，薄包装在 commands.rs）
            commands::get_sentence_analysis,
            commands::get_token_analysis,
            commands::lookup_lexicon,
            commands::get_blank_analysis,
            commands::get_sentence_note,
            commands::get_word_note,
            commands::upsert_sentence_note,
            commands::upsert_word_note,
            // M2 · TP-修复1 F4：本篇笔记标记（一次 IPC，正文层句角标/词节点用）
            commands::get_article_note_marks,
            // M3 · 生词本（8 个；实现见 vocab.rs，薄包装在 commands.rs）
            commands::list_vocab,
            commands::add_vocab_from_token,
            commands::update_vocab,
            commands::delete_vocab,
            commands::get_vocab_by_normalized,
            commands::list_tags,
            commands::set_vocab_tags,
            commands::delete_tag,
            // M4 · 复习（7 个；实现见 review.rs，薄包装在 commands.rs）
            commands::mark_article_completed,
            commands::get_due_reviews,
            commands::get_review_plan,
            commands::complete_review,
            commands::restart_review_plan,
            commands::list_review_logs,
            commands::list_review_plans,
            // TP-修复5 · M4-U3：今日页「继续精读」栏（只读；reading_record 按 last_read_at DESC 取 1）
            commands::get_last_read_article,
            // M5 · 用户导入（2 个；实现见 import_user.rs，薄包装在 commands.rs）
            commands::parse_import_preview,
            commands::commit_import,
            // M5b · AI 解析导入（6 个；实现见 ai_import.rs，薄包装在 commands.rs）
            // 命令名与数量由 05 §十一之二 冻结：build_ai_prompt / parse_ai_payload /
            // match_ai_payload / commit_ai_import / patch_ai_analysis / get_ai_import_stats
            commands::build_ai_prompt,
            commands::parse_ai_payload,
            commands::match_ai_payload,
            commands::commit_ai_import,
            commands::patch_ai_analysis,
            commands::get_ai_import_stats
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
