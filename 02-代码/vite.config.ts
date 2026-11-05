import { defineConfig } from 'vite';

// Tauri 开发服务器：端口固定 1420（tauri.conf.json 的 devUrl 与之对应）。
// 必须忽略 src-tauri（含 target/）：否则 cargo 编译时 Vite 的 fs watcher 会撞上 .exe 文件锁（EBUSY）并退出。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
