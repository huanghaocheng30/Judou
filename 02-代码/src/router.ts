// hash 路由（04 §9.1 / 05 §三 M2）：纯匹配函数 + DOM 绑定分层，纯函数部分可被 node 直接断言（AC8）。
// 本文件顶层不得访问 window/document/history —— 只有 bindRouter 内部才碰 DOM。

export type Route =
  | { name: 'catalog' }
  | { name: 'article'; sourceKey: string }
  | { name: 'notFound'; hash: string };

/** 路由表（AC8 断言「含两条记录」）。 */
export const ROUTES = ['catalog', 'article'] as const;

/** 把 location.hash 解析成路由对象。 */
export function matchRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw === '/') return { name: 'catalog' };
  const m = /^\/article\/([^/?#]+)$/.exec(raw);
  if (m) {
    const key = decodeURIComponent(m[1]);
    if (key.length > 0) return { name: 'article', sourceKey: key };
  }
  return { name: 'notFound', hash };
}

/**
 * 返回导航决策（02 §三 D5）：history.state.fromCatalog 为真 → 走 history.back()，
 * 否则直接跳 #/ —— 保证「点了必有反应」（原型已知缺陷的正式修复）。
 */
export function backAction(state: { fromCatalog?: boolean } | null | undefined): 'history-back' | 'navigate-catalog' {
  return state && state.fromCatalog === true ? 'history-back' : 'navigate-catalog';
}

export type RenderRoute = (route: Route) => void | Promise<void>;

/** 绑定 hashchange 并立即渲染当前路由；进入文章前给该条目打 fromCatalog 标记。 */
export function bindRouter(render: RenderRoute): void {
  let last: Route | null = null;
  const apply = (): void => {
    const route = matchRoute(location.hash);
    if (route.name === 'article' && last?.name === 'catalog') {
      history.replaceState({ ...(history.state || {}), fromCatalog: true }, '');
    }
    last = route;
    void render(route);
  };
  window.addEventListener('hashchange', apply);
  apply();
}
