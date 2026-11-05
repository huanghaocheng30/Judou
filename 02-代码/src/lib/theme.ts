/**
 * 主题：三档取值（light/dark/system）→ 解析结果（light/dark）→ `<html data-theme>`。
 * 抽成纯函数（不碰 React、不碰 Tauri）以便 `node --test` 直接断言（AC4 组件级取证）。
 *
 * 表示法（对应计划评审 R3）：data-theme 写**解析结果**（CSS 靠它切变量），
 * data-theme-source 写**用户原值**（system 与 light 由此区分，供断言与调试）。
 * 该选择在执行自测中声明。
 */
export type ThemeSetting = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_SETTINGS: readonly ThemeSetting[] = ["light", "dark", "system"];

export const THEME_LABELS: Record<ThemeSetting, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === "light" || value === "dark" || value === "system";
}

/** system 跟随 prefersDark，其余直出 */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (setting === "system") return prefersDark ? "dark" : "light";
  return setting;
}

/** applyTheme 只需要 documentElement.dataset 这一小块，便于用假 doc 断言 */
export interface ThemeTarget {
  documentElement: { dataset: Record<string, string | undefined> };
}

export function applyTheme(doc: ThemeTarget, setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  const resolved = resolveTheme(setting, prefersDark);
  doc.documentElement.dataset.theme = resolved;
  doc.documentElement.dataset.themeSource = setting;
  return resolved;
}
