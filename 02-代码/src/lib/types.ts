/**
 * 后端返回值类型（与 Rust 结构一一对应，docs D1 §8.2：类型定义放 types.ts）。
 * M0 只有 ping + 设置；M1 起按命令逐个补，保持 camelCase 边界（D1 §7.1）。
 */

/** `ping` 命令返回体 */
export interface PingResult {
  pong: boolean;
  appVersion: string;
}

/** `get_settings` 返回体：app_setting 全量表（已知键：theme / guide_shown / review_intervals） */
export type AppSettings = Record<string, string>;
