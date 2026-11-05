//! 句读 Tauri 后端入口装配：数据库 state + 命令注册。
//! 分工（02 D1）：本文件只负责「装」，命令实现全在 commands.rs、库逻辑全在 db.rs。

mod commands;
mod db;

use tauri::Manager;

use db::Db;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 库落在 Tauri 的 app_data_dir：%APPDATA%\com.judou.app\judou.db（Windows）
            let data_dir = app.path().app_data_dir()?;
            let db = Db::open(data_dir.join("judou.db"))?;
            // R4：启动打印一次库路径与版本，供自测取证与后续包复用
            println!("[judou] db path = {}", db.path().display());
            println!("[judou] app version = {}", env!("CARGO_PKG_VERSION"));
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_settings,
            commands::set_setting
        ])
        .run(tauri::generate_context!())
        .expect("启动句读失败");
}
