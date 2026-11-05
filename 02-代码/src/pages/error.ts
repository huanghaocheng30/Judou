// 启动错误页（02 §三 D6 / AC9①）：文案由纯函数 renderErrorState 产出；
// renderErrorPage 只做 HTML 包装（不含任何篇目列表 / 「12 篇」占位）。

import type { ErrorState } from '../render/error.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderErrorPage(state: ErrorState): string {
  return `<div class="page error-page" role="alert">
    <h1>${esc(state.title)}</h1>
    <p class="detail">${esc(state.detail)}</p>
    <p class="hint">应用未加载任何篇目，请按上面的提示处理后重新启动。</p>
  </div>`;
}

export function mountError(root: HTMLElement, state: ErrorState): void {
  root.innerHTML = renderErrorPage(state);
}
