/**
 * 主题 Provider：读 app_setting.theme → 应用 `<html data-theme>` → system 监听 matchMedia。
 * 只经 src/lib/api.ts（不直连 db、不裸 invoke）。
 *
 * 红线注解（02 D4 预写，避免代码审查误判）：theme 是**应用设置状态（UI 偏好）**，
 * 不是 docs D1 §11.8 禁止的「用 useState 缓存数据库业务数据」——
 * 它没有列表/实体语义，也不需要查询层缓存与失效策略。M1 引入查询层后统一口径。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSettings, setSetting as persistSetting } from "../lib/api";
import {
  applyTheme,
  isThemeSetting,
  resolveTheme,
  type ResolvedTheme,
  type ThemeSetting,
} from "../lib/theme";

interface ThemeContextValue {
  /** 用户选择的原值（含 system） */
  setting: ThemeSetting;
  /** 实际生效值（system 已解析） */
  resolved: ResolvedTheme;
  setTheme: (next: ThemeSetting) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<ThemeSetting>("system");
  const [prefersDark, setPrefersDark] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches,
  );

  // 启动读库里的设置（失败则保持 system，不阻塞首屏）
  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled && isThemeSetting(settings.theme)) setSettingState(settings.theme);
      })
      .catch((err: unknown) => {
        console.warn("读取 app_setting.theme 失败，回落跟随系统", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // system 档跟随系统切换
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = useMemo(() => resolveTheme(setting, prefersDark), [setting, prefersDark]);

  // 应用结果到 <html>（每次 setting/系统偏好变化都重写，幂等）
  useEffect(() => {
    applyTheme(document, setting, prefersDark);
  }, [setting, prefersDark]);

  const setTheme = useCallback((next: ThemeSetting) => {
    // 先本地生效（UI 偏好立即反馈），再落库；落库失败只告警，不回滚界面
    setSettingState(next);
    persistSetting("theme", next).catch((err: unknown) => {
      console.warn("写入 app_setting.theme 失败（本次会话内仍生效）", err);
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ setting, resolved, setTheme }),
    [setting, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
