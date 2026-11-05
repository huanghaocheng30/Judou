// 发布版不弹控制台窗口；调试版保留 stdout（迁移日志 / db 路径供 AC1~AC4 取证）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    judou_lib::run()
}
