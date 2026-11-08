/**
 * 侧边栏：品牌标识（四线 + 高亮行 + 句点，取自原型 v2 内联 SVG）+ 7 项导航。
 * 路由用原生 `<a href="#/xxx">` —— 自写 hash 路由（见 routes.tsx）不需要 Link 组件。
 *
 * M4 D6：复习项带「今日待复习」角标（`data-review-badge`）。
 * - 取数走 `api.ts` 的 `getDueReviews`（**禁裸 invoke**，否则破 `verify:invoke` 例外 0）；
 * - 与复习页**各自独立取数、不共享缓存**（02 N8）；
 * - 启动 + 路由变化时刷新，**不做轮询/定时器**。
 */
import { useEffect, useState, type ReactElement } from "react";
import { getDueReviews } from "../lib/api";
import { localToday } from "../lib/date";

export interface NavItem {
  path: string;
  label: string;
  icon: ReactElement;
}

function icon(children: ReactElement) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const NAV_ITEMS: NavItem[] = [
  {
    path: "#/today",
    label: "今日",
    icon: icon(
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M8 3.5v3M16 3.5v3M3.5 10h17" />
      </>,
    ),
  },
  {
    path: "#/library",
    label: "文章库",
    icon: icon(
      <>
        <path d="M4 4.5h6.5A2.5 2.5 0 0 1 13 7v13H6a2 2 0 0 1-2-2z" />
        <path d="M20 4.5h-4.5A2.5 2.5 0 0 0 13 7v13h5a2 2 0 0 0 2-2z" />
      </>,
    ),
  },
  {
    path: "#/review",
    label: "复习",
    icon: icon(
      <>
        <path d="M20 12a8 8 0 1 1-2.6-5.9" />
        <path d="M20 4.5V10h-5.5" />
      </>,
    ),
  },
  {
    path: "#/vocab",
    label: "生词本",
    icon: icon(
      <>
        <path d="M5 5.5A2 2 0 0 1 7 3.5h11v17H7a2 2 0 0 1-2-2z" />
        <path d="M9 8h6M9 11.5h6" />
      </>,
    ),
  },
  {
    path: "#/import",
    label: "导入",
    icon: icon(
      <>
        <path d="M12 15.5V4.5M8 8.5 12 4.5l4 4" />
        <path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />
      </>,
    ),
  },
  {
    path: "#/records",
    label: "记录",
    icon: icon(
      <>
        <path d="M4.5 19.5h15" />
        <path d="M7.5 19.5v-6M12 19.5V7M16.5 19.5v-9" />
      </>,
    ),
  },
  {
    path: "#/settings",
    label: "设置",
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.5v2M12 18.5v2M4.6 7.8l1.7 1M17.7 15.2l1.7 1M4.6 16.2l1.7-1M17.7 8.8l1.7-1" />
      </>,
    ),
  },
];

export interface SidebarProps {
  /** 当前激活路由（形如 `#/today`） */
  active: string;
}

export function Sidebar({ active }: SidebarProps) {
  /**
   * 今日待复习篇数（D6）。`0` 与取数失败都**不显示角标**——不显示比显示错的数字好。
   * 依赖 `active`：路由一变就重新取（完成复习/重新加入后回到列表，角标立刻跟上）。
   */
  const [dueCount, setDueCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getDueReviews(localToday())
      .then((rows) => {
        if (!cancelled) setDueCount(rows.length);
      })
      .catch((err: unknown) => {
        // 角标是辅助信息：失败只降级为「不显示」，不弹错、不阻塞导航
        if (!cancelled) {
          console.warn("[judou] 读取今日待复习数失败，角标降级隐藏：", err);
          setDueCount(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 27 27" aria-hidden="true" focusable="false">
          <rect className="ln" x="4" y="6" width="15" height="2.4" rx="1.2" />
          <rect className="ln" x="4" y="11" width="18" height="2.4" rx="1.2" />
          <rect className="hl" x="4" y="16" width="11" height="2.4" rx="1.2" />
          <circle className="dot" cx="19" cy="17.2" r="2" />
          <rect className="ln" x="4" y="21" width="9" height="2.4" rx="1.2" />
        </svg>
        <span className="brand-text">
          <b>句读</b>
          <span className="brand-latin">Judou</span>
        </span>
      </div>

      <nav className="nav-list" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const isActive = item.path === active;
          const isReview = item.path === "#/review";
          return (
            <a
              key={item.path}
              className={isActive ? "nav on" : "nav"}
              href={item.path}
              aria-current={isActive ? "page" : undefined}
            >
              {item.icon}
              {/* M9 D1：挂 `nav-label` 只为给 CSS 一个抓手——图标栏档（640~1099）视觉隐藏本行文字、
                  hover/聚焦时浮出为 tooltip；文字节点本身留在 DOM/无障碍树里，导航项不失可访问名。 */}
              <span className="nav-label">{item.label}</span>
              {/* 角标：**文字可读**（数字），不是纯色块；`aria-label` 给屏幕阅读器完整语义（AC8） */}
              {isReview && dueCount > 0 && (
                <span className="nav-badge" data-review-badge={dueCount} aria-label={`今日待复习 ${dueCount} 篇`}>
                  {dueCount}
                </span>
              )}
            </a>
          );
        })}
      </nav>

      <p className="side-foot">M0 · 骨架</p>
    </aside>
  );
}
