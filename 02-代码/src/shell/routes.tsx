/**
 * 自写 hash 路由（不引 react-router）：
 * - 扁平路由表（#/today … #/settings）+ **参数化路径** `#/article/:id`（M1 新增）
 * - 查询串（`#/library?vis=system&exam=cet4`）不参与路由匹配，交给页面自己读（文章库筛选保持）
 * - `useReturn()`：精读页返回，修掉原型「点了没反应」的缺陷（AC7）
 *
 * ponytail: 仍不引 react-router —— 7 条路由 + 一条 `:id` 参数用 3 个函数解决；
 * 等出现嵌套路由/路由守卫/懒加载再评估引入。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Library } from "../pages/Library";
import { Reader } from "../pages/Reader";
import { Records } from "../pages/Records";
import { Review } from "../pages/Review";
import { Settings } from "../pages/Settings";
import { Today } from "../pages/Today";
import { Vocab } from "../pages/Vocab";

export interface RouteDef {
  /** hash 形态，含 `#/` 前缀 */
  path: string;
  /** 侧边栏显示名（精读页不在导航里，保留 label 供面包屑/调试） */
  label: string;
  title: string;
  subtitle: string;
  element: ReactNode;
}

export const ROUTES: RouteDef[] = [
  {
    path: "#/today",
    label: "今日",
    title: "今日",
    subtitle: "从上次停下的地方继续，或处理今天到期的复习。",
    element: <Today />,
  },
  {
    path: "#/library",
    label: "文章库",
    title: "文章库",
    subtitle: "12 篇内置真题，按考试类型、年份、题型筛选。",
    element: <Library />,
  },
  {
    path: "#/article",
    label: "精读页",
    title: "精读",
    subtitle: "点句看解析、点词看语境义、点空看排除项。",
    element: <Reader />,
  },
  {
    path: "#/review",
    label: "复习",
    title: "复习",
    subtitle: "按到期日排队的篇级复习，档位 1 / 3 / 7 / 14 天。",
    element: <Review />,
  },
  {
    path: "#/vocab",
    label: "生词本",
    title: "生词本",
    subtitle: "按文章、标签、掌握状态分组；点回原句看语境。",
    element: <Vocab />,
  },
  {
    path: "#/records",
    label: "记录",
    title: "记录与统计",
    subtitle: "阅读时长、笔记、生词与复习的次数与连续天数。",
    element: <Records />,
  },
  {
    path: "#/settings",
    label: "设置",
    title: "设置",
    subtitle: "主题、复习间隔、备份恢复与关于。",
    element: <Settings />,
  },
];

export const DEFAULT_ROUTE = "#/today";

/** 精读页路径前缀（`#/article/:id` 收敛成 `#/article` 参与路由匹配） */
const ARTICLE_PREFIX = "#/article/";

export interface ParsedRoute {
  /** 路由表内的 path（带参精读页收敛为 `#/article`） */
  path: string;
  /** `#/article/:id` 的 id；其余路由为 undefined */
  articleId?: number;
  /** `?` 之后的查询串（文章库筛选/返回时保持） */
  query: URLSearchParams;
}

/** 任意 hash（含空/未知/带尾斜杠）→ 归一后的路径部分（`#` 前缀补全、去尾斜杠、去查询串） */
function normalizePathPart(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  const withPrefix = cleaned.startsWith("#") ? cleaned : `#${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
  const hashMark = withPrefix.indexOf("?");
  return hashMark >= 0 ? withPrefix.slice(0, hashMark) : withPrefix;
}

/** 任意 hash（含空/未知/带尾斜杠/带查询串）→ 结构化路由 */
export function parseHash(raw: string): ParsedRoute {
  const cleaned = raw.trim().replace(/\/+$/, "");
  const withPrefix = cleaned.startsWith("#") ? cleaned : `#${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
  const hashMark = withPrefix.indexOf("?");
  const pathPart = normalizePathPart(raw);
  const query = new URLSearchParams(hashMark >= 0 ? withPrefix.slice(hashMark + 1) : "");

  if (pathPart.startsWith(ARTICLE_PREFIX)) {
    const id = Number(pathPart.slice(ARTICLE_PREFIX.length));
    return { path: "#/article", articleId: Number.isInteger(id) && id > 0 ? id : undefined, query };
  }
  const known = ROUTES.some((route) => route.path === pathPart);
  return { path: known ? pathPart : DEFAULT_ROUTE, query };
}

/**
 * 该 hash 是否命中路由表（含任意 `#/article/:id`）。
 *
 * `parseHash` 对未知路径**回落**成今日页（保证渲染不白屏），但 URL 仍停在那个坏 hash 上；
 * `useRoute` 再用本判定把 URL 一并改写（D-M11-3：导入移除后 `#/import` 直访曾停留原地）。
 * 口径与 `parseHash` 共用 `normalizePathPart`，避免两处归一逻辑漂移。
 */
export function isKnownHash(raw: string): boolean {
  const pathPart = normalizePathPart(raw);
  if (pathPart.startsWith(ARTICLE_PREFIX)) return true;
  return ROUTES.some((route) => route.path === pathPart);
}

/** 结构化路由 → 规范 hash（保留查询串） */
export function toHash(path: string, query?: URLSearchParams | string): string {
  const text = typeof query === "string" ? query.replace(/^\?/, "") : query?.toString() ?? "";
  return text ? `${path}?${text}` : path;
}

/**
 * 把任意 hash 收敛成路由表内的合法值（`normalizeHash` 保留 M0 语义，但**不得丢掉参数与查询串**：
 * `#/article/3` 收敛成 `#/article` 会让精读页路由失效——这是 CDP 断言抓到的真 bug）。
 */
export function normalizeHash(raw: string): string {
  const parsed = parseHash(raw);
  const base = parsed.path === "#/article" && parsed.articleId ? `${parsed.path}/${parsed.articleId}` : parsed.path;
  return toHash(base, parsed.query);
}

/** 当前路由 + 导航函数（导航即改 hash，触发 hashchange） */
export function useRoute(): [ParsedRoute, (next: string) => void] {
  const [route, setRoute] = useState<ParsedRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    // 首帧「没有 hash」时才补默认路由；**已知路由（含带参精读页）一律不重写**，
    // 否则会把 `#/article/3` 抹成 `#/article`（参数丢失 → 精读页打不开）。
    const raw = window.location.hash.trim();
    if (raw === "" || raw === "#" || raw === "#/") {
      window.location.hash = DEFAULT_ROUTE;
    } else if (!isKnownHash(raw)) {
      // D-M11-3：未知路由（导入功能移除后残留的 `#/import` 等）→ 渲染落到今日页，
      // **并且把 URL 一起改写**——只换渲染不改 hash 会让刷新后仍停在坏地址。
      // 用 `location.replace`（而非给 hash 赋值）不新增历史条目，后退不会再次撞上它。
      window.location.replace(DEFAULT_ROUTE);
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: string) => {
    window.location.hash = normalizeHash(next);
  }, []);

  return [route, navigate];
}

export function findRoute(path: string): RouteDef {
  return ROUTES.find((route) => route.path === path) ?? ROUTES[0];
}

// ─────────────────────── 返回导航（AC7） ───────────────────────

/** 文章库上一次的查询串（离开列表页时写入；返回时带回） */
const LIBRARY_QUERY_KEY = "library.query";

/** 离开文章库去精读时调用：记住当前筛选（≤ 200 字符的查询串，非敏感数据） */
export function rememberLibraryQuery(search: string): void {
  try {
    sessionStorage.setItem(LIBRARY_QUERY_KEY, search.replace(/^\?/, ""));
  } catch {
    // sessionStorage 被禁用（隐私模式/策略）：静默退化，返回时不带筛选即可（AC7 三态之③）
  }
}

function readLibraryQuery(): string {
  try {
    return sessionStorage.getItem(LIBRARY_QUERY_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * 精读页的返回：**优先浏览器历史**（回到列表页时筛选天然还在，因为它就是同一份 URL），
 * 没有应用内历史（新会话冷启动直接打开 `#/article/:id`）则回落 `#/library` 并带出上次查询串。
 *
 * 三态（02 D7）：① 同会话从列表页进来 → `history.back()` 带出 query；
 * ② 冷启动直接开精读 → 无 marker、无历史 → `#/library` 无筛选且**不抛错**；
 * ③ sessionStorage 不可用 → 读不到 marker → 退化成 ②。
 */
export function useReturn(): () => void {
  return useCallback(() => {
    const hasLibraryMarker = readLibraryQuery() !== "";
    if (hasLibraryMarker && window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.hash = toHash("#/library", readLibraryQuery());
  }, []);
}
