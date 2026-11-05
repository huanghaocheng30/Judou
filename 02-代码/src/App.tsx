/**
 * 应用壳：ThemeProvider（主题）+ Sidebar（7 项导航）+ Topbar + 路由页。
 * 启动时调一次 ping() 并打印结果 —— AC3 的运行期取证点（控制台可见）。
 */
import { useEffect } from "react";
import { ping } from "./lib/api";
import { Sidebar } from "./shell/Sidebar";
import { ThemeProvider } from "./shell/ThemeProvider";
import { Topbar } from "./shell/Topbar";
import { findRoute, useRoute } from "./shell/routes";

export default function App() {
  const [hash] = useRoute();
  const route = findRoute(hash);

  // 启动探针：命令链路通了才会打印出 appVersion
  useEffect(() => {
    ping()
      .then((result) => {
        console.log(`ping → ${JSON.stringify(result)}`);
      })
      .catch((err: unknown) => {
        console.error("ping 失败（后端命令未注册或数据库未初始化）", err);
      });
  }, []);

  return (
    <ThemeProvider>
      <div className="shell">
        <Sidebar active={hash} />
        <div className="main">
          <Topbar title={route.title} subtitle={route.subtitle} />
          <main className="content">{route.element}</main>
        </div>
      </div>
    </ThemeProvider>
  );
}
