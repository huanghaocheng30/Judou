// 阅读页骨架（02 §三 D5 / AC4 / AC5 / AC8 回程）。
// 正文由纯函数 renderTokens 产节点，DOM 层只负责转元素 —— 不在此重新实现切片逻辑。

import type { ArticleContent, SentenceDto, TokenDto } from '../types.ts';
import { renderTokens } from '../render/tokens.ts';
import { backAction } from '../router.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 把 token 按「段|句」归组，页面渲染时按句子取用。 */
export function groupTokens(tokens: TokenDto[]): Map<string, TokenDto[]> {
  const map = new Map<string, TokenDto[]>();
  for (const t of tokens) {
    const key = `${t.paraIdx}|${t.sentIdx}`;
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return map;
}

/** 页头：返回链接（‹）+ 标题 + 五项中的年份/题型/词数/句数。 */
export function renderArticleHead(content: ArticleContent): string {
  const a = content.article;
  return `<header class="page-head">
      <a class="back" href="#/" aria-label="返回目录">‹</a>
      <div class="head-main">
        <h1>${esc(a.title)}</h1>
        <p class="sub">
          <span class="tag type">${esc(a.section)}</span>
          <span class="tag">${a.examYear} 年 ${a.examMonth} 月</span>
          <span class="tag">${a.wordCount} 词</span>
          <span class="tag">${a.sentenceCount} 句</span>
        </p>
      </div>
    </header>`;
}

/**
 * 返回导航：history.state.fromCatalog 为真走 history.back()，否则跳 #/；
 * 两种路径都有 80ms 兜底 —— 若仍停在原文章路由则强制跳 #/（「点了必有反应」）。
 */
export function bindBack(link: HTMLAnchorElement): void {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const current = location.hash;
    if (backAction(history.state as { fromCatalog?: boolean } | null) === 'history-back') {
      history.back();
      window.setTimeout(() => {
        if (location.hash === current) location.hash = '#/';
      }, 80);
    } else {
      location.hash = '#/';
    }
  });
}

function tokenElement(node: ReturnType<typeof renderTokens>[number]): Node {
  if (node.type === 'text') return document.createTextNode(node.text);
  const el = document.createElement('span');
  el.tabIndex = 0; // 节点可 Tab 聚焦（AC5）
  if (node.type === 'word') {
    el.className = 'w';
    el.dataset.n = node.n ?? '';
    el.dataset.start = String(node.start ?? 0);
  } else {
    el.className = 'blank';
    el.dataset.blankNo = String(node.blankNo ?? '');
    el.dataset.start = String(node.start ?? 0);
    el.setAttribute('aria-label', `第 ${node.blankNo ?? ''} 空`);
  }
  el.textContent = node.text;
  return el;
}

export function mountArticle(root: HTMLElement, content: ArticleContent): void {
  const bySentence = groupTokens(content.tokens);
  const sentencesByPara = new Map<number, SentenceDto[]>();
  for (const s of content.sentences) {
    const list = sentencesByPara.get(s.paraIdx) ?? [];
    list.push(s);
    sentencesByPara.set(s.paraIdx, list);
  }

  const page = document.createElement('div');
  page.className = 'page article-page';
  page.innerHTML = renderArticleHead(content);

  const body = document.createElement('div');
  body.className = 'article-body';
  for (const para of content.paragraphs) {
    const p = document.createElement('p');
    p.className = 'para';
    const sentences = (sentencesByPara.get(para.idx) ?? []).sort((a, b) => a.idx - b.idx);
    for (const s of sentences) {
      const sent = document.createElement('span');
      sent.className = 'sent';
      const nodes = renderTokens(s.text, bySentence.get(`${s.paraIdx}|${s.idx}`) ?? [], content.blankNos);
      for (const node of nodes) sent.appendChild(tokenElement(node));

      const analysis = document.createElement('button');
      analysis.type = 'button';
      analysis.className = 'analysis';
      analysis.setAttribute('aria-label', `查看第 ${s.idx + 1} 句解析`);
      analysis.textContent = '析';
      sent.appendChild(analysis);
      p.appendChild(sent);
    }
    body.appendChild(p);
  }
  page.appendChild(body);
  root.replaceChildren(page);

  const back = page.querySelector<HTMLAnchorElement>('a.back');
  if (back) bindBack(back);
}
