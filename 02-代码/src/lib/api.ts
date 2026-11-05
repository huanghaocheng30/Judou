/**
 * 唯一后端入口（docs D1 §7.4 / §8.2）：全项目只有本文件允许出现 `invoke(`。
 * 组件一律 import 这里的 camelCase 封装，禁止裸 invoke 字符串。
 *
 * 参数命名：Tauri v2 命令参数按 camelCase 传（Rust 侧 snake_case 参数会自动对上），
 * 所以 `get_article_content(articleId)` 对应 Rust 的 `article_id`。
 *
 * ponytail: 每个命令一行的薄封装，不做统一 request 包装层——
 * 8 个命令时包装层只是多余的间接；等出现统一的错误码映射再抽。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ArticleContent,
  ArticleFilter,
  ArticleSummary,
  FilterOptions,
  ImportReport,
  PingResult,
  StartupErrorInfo,
} from "./types";

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

/**
 * 启动错误通道（AC1 第 5 个命令）：成功启动返回 null。
 * **不依赖 Db**（O3）——库打不开时这条仍要能答，错误页才显示得出来。
 */
export function getStartupError(): Promise<StartupErrorInfo | null> {
  return invoke<StartupErrorInfo | null>("get_startup_error");
}

/** 文章库列表（四类筛选 AND、同组多选 OR、标题模糊搜索） */
export function listArticles(filter: ArticleFilter = {}): Promise<ArticleSummary[]> {
  return invoke<ArticleSummary[]>("list_articles", { filter });
}

/** 文章库筛选器选项（来源选项 = DISTINCT source） */
export function listArticleFilterOptions(): Promise<FilterOptions> {
  return invoke<FilterOptions>("list_article_filter_options");
}

/** 精读页载荷（段落/句子/词 + 空格号 + 题目） */
export function getArticleContent(articleId: number): Promise<ArticleContent> {
  return invoke<ArticleContent>("get_article_content", { articleId });
}

/** 手动触发一次内置内容包导入（正常路径由启动流程自动跑） */
export function importContentPack(): Promise<ImportReport> {
  return invoke<ImportReport>("import_content_pack");
}
