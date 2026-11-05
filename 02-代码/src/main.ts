// 应用入口：启动 → 导入内容包 → 目录；内容包异常时改渲染错误页（AC9①），不进入空壳目录。

import { getArticleContent, importContent, listArticles } from './lib/api.ts';
import { bindRouter, type Route } from './router.ts';
import { mountArticle } from './pages/article.ts';
import { mountCatalog } from './pages/catalog.ts';
import { mountError } from './pages/error.ts';
import { renderErrorState } from './render/error.ts';
import type { ArticleSummary } from './types.ts';

const root = document.getElementById('app');
if (!root) throw new Error('缺少挂载点 #app');

const state: { articles: ArticleSummary[]; dbRebuilt: string | null } = { articles: [], dbRebuilt: null };

async function renderRoute(route: Route): Promise<void> {
  const app = root as HTMLElement;
  if (route.name === 'catalog') {
    mountCatalog(app, state.articles, state.dbRebuilt);
    return;
  }
  if (route.name === 'article') {
    try {
      const content = await getArticleContent(route.sourceKey);
      mountArticle(app, content);
    } catch (err) {
      const message = (err as { message?: string } | null)?.message ?? String(err);
      mountError(app, { title: '文章读取失败', detail: `无法读取篇目 ${route.sourceKey}：${message}`, fileName: route.sourceKey });
    }
    return;
  }
  mountError(app, { title: '页面不存在', detail: `无法识别的路由：${route.hash}`, fileName: '' });
}

async function boot(): Promise<void> {
  try {
    const report = await importContent();
    state.dbRebuilt = report.dbRebuilt;
    console.log('[boot] import_content', JSON.stringify(report));
    state.articles = await listArticles();
    console.log('[boot] list_articles', JSON.stringify({ count: state.articles.length }));
    bindRouter(renderRoute);
  } catch (err) {
    // AC9①：内容包缺失/损坏时显示可见错误页，不进入空壳目录。
    mountError(root as HTMLElement, renderErrorState(err));
    console.error('[boot] startup error', JSON.stringify(err));
  }
}

void boot();
