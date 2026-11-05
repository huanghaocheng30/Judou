// 总目录页（02 §三 D4 / AC1 / AC8 去程）：三套分组 + 五项字段。
// 渲染拆成纯函数（可 node 断言）+ DOM 挂载两层。

import type { ArticleSummary } from '../types.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 目录页 HTML：三套分组，每篇一条 <a>（天然可 Tab 聚焦）。 */
export function renderCatalogPage(articles: ArticleSummary[], dbRebuilt: string | null): string {
  const groups = new Map<number, ArticleSummary[]>();
  for (const a of articles) {
    const list = groups.get(a.setNo) ?? [];
    list.push(a);
    groups.set(a.setNo, list);
  }
  const sets = [...groups.keys()].sort((a, b) => a - b);
  const banner =
    dbRebuilt === null
      ? ''
      : `<div class="banner" role="status">数据库已重建，原库已备份为 ${esc(dbRebuilt)}</div>`;

  const body = sets
    .map((setNo) => {
      const cards = (groups.get(setNo) ?? [])
        .map(
          (a) => `      <a class="card" href="#/article/${encodeURIComponent(a.sourceKey)}">
        <div class="name">${esc(a.title)}</div>
        <div class="meta">
          <span class="tag type">${esc(a.section)}</span>
          <span class="tag">${a.examYear} 年 ${a.examMonth} 月</span>
          <span class="tag">${a.wordCount} 词</span>
          <span class="tag">${a.sentenceCount} 句</span>
        </div>
      </a>`,
        )
        .join('\n');
      return `    <section class="set-group">
      <h2>第 ${setNo} 套</h2>
      <div class="grid">
${cards}
      </div>
    </section>`;
    })
    .join('\n');

  return `<div class="page catalog-page">
    <header class="page-head">
      <h1>CET4 阅读精读</h1>
      <p class="sub">2023 年 12 月 · 3 套题 · ${articles.length} 篇</p>
    </header>
${banner}
${body}
  </div>`;
}

export function mountCatalog(root: HTMLElement, articles: ArticleSummary[], dbRebuilt: string | null): void {
  root.innerHTML = renderCatalogPage(articles, dbRebuilt);
}
