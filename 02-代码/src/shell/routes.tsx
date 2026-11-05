/**
 * 自写 hash 路由：8 条扁平路由（#/today … #/settings）。
 *
 * ponytail: 不引 react-router —— 8 页扁平表 + 原生 `<a href="#/x">` 已够用，
 * 30 行解决；等出现嵌套路由/路由守卫/参数化路径（M1 的 #/article/:id）再评估引入，
 * 届时只改本文件的 ROUTES 与 normalize 一处。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Import } from "../pages/Import";
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
    subtitle: "内置篇目与我导入的篇目，按考试类型、年份、题型筛选。",
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
    path: "#/import",
    label: "导入",
    title: "导入",
    subtitle: "粘贴或选择文件，先预览再入库。",
    element: <Import />,
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

/** 把任意 hash（含空/未知/带尾斜杠）收敛成路由表内的合法值 */
export function normalizeHash(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) return DEFAULT_ROUTE;
  const withPrefix = cleaned.startsWith("#") ? cleaned : `#${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
  return ROUTES.some((route) => route.path === withPrefix) ? withPrefix : DEFAULT_ROUTE;
}

/** 当前路由 + 导航函数（导航即改 hash，触发 hashchange） */
export function useRoute(): [string, (next: string) => void] {
  const [hash, setHash] = useState<string>(() => normalizeHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setHash(normalizeHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    // 首帧无 hash 时补上默认路由，保证「刚启动」与「刷新」状态一致
    if (normalizeHash(window.location.hash) !== window.location.hash) {
      window.location.hash = normalizeHash(window.location.hash);
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: string) => {
    window.location.hash = normalizeHash(next);
  }, []);

  return [hash, navigate];
}

export function findRoute(hash: string): RouteDef {
  return ROUTES.find((route) => route.path === hash) ?? ROUTES[0];
}
