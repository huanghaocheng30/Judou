/**
 * 顶部条：当前页标题 + 副标题 + 右侧主题状态（只读展示，切换在设置页）。
 * 读 useTheme().setting —— 主题口径唯一来源是 ThemeProvider。
 */
import { THEME_LABELS, type ResolvedTheme, type ThemeSetting } from "../lib/theme";
import { useTheme } from "./ThemeProvider";

export interface TopbarProps {
  title: string;
  subtitle: string;
}

const RESOLVED_LABEL: Record<ResolvedTheme, string> = { light: "浅色", dark: "深色" };

export function Topbar({ title, subtitle }: TopbarProps) {
  const { setting, resolved } = useTheme();
  const themeHint: string =
    setting === "system"
      ? `跟随系统 · 当前${RESOLVED_LABEL[resolved]}`
      : THEME_LABELS[setting as ThemeSetting];

  return (
    <header className="topbar">
      <div className="topbar-text">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <span className="topbar-theme" title="主题切换在「设置」页">
        {themeHint}
      </span>
    </header>
  );
}
