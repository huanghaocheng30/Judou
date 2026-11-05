/**
 * 唯一后端入口（docs D1 §7.4 / §8.2）：全项目只有本文件允许出现 `invoke(`。
 * 组件一律 import 这里的 camelCase 封装，禁止裸 invoke 字符串。
 *
 * ponytail: 每个命令一行的薄封装，不做统一 request 包装层——
 * 3 个命令时包装层只是多余的间接；等命令上两位数且出现统一的错误码映射再抽。
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, PingResult } from "./types";

/** 连通性探针：返回 pong 与 Cargo 包版本 */
export function ping(): Promise<PingResult> {
  return invoke<PingResult>("ping");
}

/** 读 app_setting 全量键值（docs C3 §5.8） */
export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/** 写单个设置键（docs C3 §5.8：只允许 review_intervals / guide_shown / theme） */
export function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}
