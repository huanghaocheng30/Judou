/**
 * 应用壳：启动态分支（错误页）+ ThemeProvider + Sidebar + Topbar + 路由页。
 *
 * **启动顺序纪律（O3）**：先查 `get_startup_error()`，**再**决定挂不挂 ThemeProvider——
 * ThemeProvider 一挂就会调 `getSettings()`（依赖 `Db`），库打不开时那条命令必然失败。
 * 错误页必须先渲染，所以这里用「未取到启动态 → 只显示加载中」的三态，而不是默认成功。
 */
import { useEffect, useState } from "react";
import { getStartupError, ping } from "./lib/api";
import type { StartupErrorInfo } from "./lib/types";
import { Guide } from "./components/Guide";
import { Sidebar } from "./shell/Sidebar";
import { ThemeProvider } from "./shell/ThemeProvider";
import { Topbar } from "./shell/Topbar";
import { findRoute, useRoute } from "./shell/routes";

/** 整页错误页（04 §6.8）：原因 + 出错文件（basename）+「请重新安装」，不进空文章库 */
function StartupErrorPage({ info }: { info: StartupErrorInfo }) {
  return (
    <div className="startup-error" data-testid="startup-error" data-error-kind={info.kind} role="alert">
      <div className="startup-error-card">
        <p className="placeholder-kicker">启动失败</p>
        <h1>句读没能加载内置内容</h1>
        <p className="startup-error-message">{info.message}</p>
        {info.file && (
          <p className="startup-error-file">
            出错文件：<code data-testid="startup-error-file">{info.file}</code>
          </p>
        )}
        <p className="startup-error-hint">请重新安装应用（或恢复安装目录下被改动的 content-pack 文件）后重试。</p>
        <p className="startup-error-code">错误代码：{info.kind}</p>
      </div>
    </div>
  );
}

export default function App() {
  // undefined = 还没问过后端（首帧）；null = 成功启动；对象 = 启动失败
  const [startupError, setStartupError] = useState<StartupErrorInfo | null | undefined>(undefined);
  const [route] = useRoute();
  const page = findRoute(route.path);

  useEffect(() => {
    let cancelled = false;
    getStartupError()
      .then((value) => {
        if (!cancelled) setStartupError(value);
      })
      .catch((err: unknown) => {
        // 连启动态都问不到（后端没装配好）：按「无启动错误」继续，让页面自己报错
        console.warn("读取启动态失败", err);
        if (!cancelled) setStartupError(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动探针：命令链路通了才会打印出 appVersion（不依赖 Db，失败也照打日志）
  useEffect(() => {
    ping()
      .then((result) => {
        console.log(`ping → ${JSON.stringify(result)}`);
      })
      .catch((err: unknown) => {
        console.error("ping 失败（后端命令未注册或数据库未初始化）", err);
      });
  }, []);

  if (startupError === undefined) {
    return (
      <p className="boot" data-testid="boot">
        正在读取启动状态…
      </p>
    );
  }

  if (startupError) {
    return <StartupErrorPage info={startupError} />;
  }

  return (
    <ThemeProvider>
      <div className="shell">
        <Sidebar active={route.path} />
        <div className="main">
          <Topbar title={page.title} subtitle={page.subtitle} />
          <main className="content">{page.element}</main>
        </div>
        {/* M6 · 首次引导（AC11）：挂在壳内，主题生效后才渲染 */}
        <Guide />
      </div>
    </ThemeProvider>
  );
}
