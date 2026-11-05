// 前端唯一后端入口（04 §9.1：禁止裸 invoke 字符串散落在页面里）。

import { invoke } from '@tauri-apps/api/core';
import type { ArticleContent, ArticleSummary, ImportReport } from '../types.ts';

/** 触发内容导入（packDir 由后端解析资源目录，不从前端拼绝对路径）。 */
export function importContent(packDir: string | null = null): Promise<ImportReport> {
  return invoke<ImportReport>('import_content', { packDir });
}

export function listArticles(): Promise<ArticleSummary[]> {
  return invoke<ArticleSummary[]>('list_articles');
}

export function getArticleContent(sourceKey: string): Promise<ArticleContent> {
  return invoke<ArticleContent>('get_article_content', { sourceKey });
}
