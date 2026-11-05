// 桌面端入口：所有逻辑在 lib.rs（便于集成测试直接复用例程）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cet4_reading_lib::run()
}
