import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 约定：dev server 固定在 1420，且不清屏（tauri dev 的 Rust 编译日志要看）
export default defineConfig({
  plugins: [react()],
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
