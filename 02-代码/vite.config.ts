import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 约定：dev server 固定在 1420，且不清屏（tauri dev 的 Rust 编译日志要看）
export default defineConfig({
  plugins: [react()],
  // ponytail: 天花板=仅解决 Windows junction 入口根目录错位；升级路径=若将来要求「任意软链路径当项目根」再上 monorepo/preset 方案
  // 02-代码 是指向 code/ 的 junction：Vite 默认 realpath 到 code/，与从 02-代码 启动时的
  // 入口根不一致 → /src/main.tsx 命中 Pre-transform error，浏览器拿到未转译 TSX → 白屏
  resolve: { preserveSymlinks: true },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri 由 cargo 自己 watch，Vite 不用管
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Windows 用 WebView2（Chromium），macOS/Linux 用系统 WebKit
    target: ["chrome105", "safari13"],
    minify: "esbuild",
    sourcemap: false,
  },
});
