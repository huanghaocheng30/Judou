# CET4 阅读精读

Tauri v2 + Vite + TypeScript 桌面应用（原生 DOM，无前端框架）。启动时把 12 篇内容包导入本地 SQLite，展示三套总目录，点进任一篇渲染正文（单词节点 / 空格节点 / 句末「析」占位），可返回目录；内容包或本地库异常时有可见处置。

## 环境要求

| 依赖 | 版本 / 说明 |
|---|---|
| Node.js | 24（需要内置 `node:sqlite`，自测脚本用它只读查库） |
| npm / pnpm | npm 11 或 pnpm 12 均可 |
| Rust | stable，host `x86_64-pc-windows-msvc`（实测 1.99.1） |
| MSVC | Visual Studio 2022 BuildTools；`cl.exe` 不在全局 PATH，编译 Rust 前先 call `vcvars64.bat` |
| WebView2 | Windows 10/11 自带运行时 |

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
```

## 常用命令

```bash
# 安装依赖
npm install            # 或 pnpm install

# 开发（Vite 1420 端口 + Tauri 窗口）
npm run dev            # 只起前端
npm run tauri dev      # 起完整桌面应用

# 前端构建（tsc 类型检查 + vite 产物）
npm run build

# 应用打包（msi/nsis；全量打包耗时较长）
npm run tauri build

# 内容包 manifest（幂等可复跑）
npm run gen:manifest

# 应用图标（打包必需，幂等可复跑）
npm run gen:icons

# 纯函数与库数据断言（AC1/AC4/AC5/AC8/AC9①）
npm run verify:render -- --catalog
npm run verify:render -- --tokens
npm run verify:render -- --nodes
npm run verify:render            # 等价 --all
```

## 自测顺序（机器可核证据）

1. `npm run gen:manifest`：确认 `content-pack/manifest.json` 12 篇、`packVersion=2023-12-v1`。
2. `npm run verify:render -- --nodes`：纯函数断言（不需要库；Node 直接 import `src/**/*.ts`）。
3. Rust 集成测试（生成 `../.tmp/TP1/verify/app.db`，覆盖 AC2/AC3/AC6/AC9）：

   ```bat
   call "…\vcvars64.bat"
   cd src-tauri
   cargo test -- --test-threads=1 --nocapture
   ```

4. `npm run verify:render -- --catalog` / `--tokens`：只读打开上一步生成的库，逐篇打印五项字段、全量校验 6699 个 token 切片。
5. `cargo check`（同上 vcvars 环境）与 `npm run build`：编译证据。

> 说明：`pnpm install` 的构建脚本许可在 `pnpm-workspace.yaml` 的 `allowBuilds` 里声明（esbuild: false ——
> 平台二进制由 `@esbuild/win32-x64` 提供，实测 Vite 构建通过）；用 `npm` 的用户走正常 postinstall，不受影响。

## 目录结构

```
02-代码/
├─ content-pack/            # 12 篇内容包（逐字节拷贝） + manifest.json（生成）
├─ scripts/                 # gen-manifest / gen-icons / verify-render
├─ src/                     # 前端（原生 DOM + hash 路由）
│  ├─ lib/api.ts            # 前端唯一后端入口（禁止裸 invoke）
│  ├─ render/tokens.ts      # 纯函数 renderTokens（text/word/blank 节点）
│  ├─ render/error.ts       # 纯函数 renderErrorState（启动异常文案）
│  ├─ router.ts             # hash 路由（纯匹配 + DOM 绑定）
│  └─ pages/                # catalog / article / error
└─ src-tauri/
   ├─ src/db.rs             # 连接、10 表 schema、损坏检测与 app.db.bak-* 备份重建
   ├─ src/import.rs         # import_content（幂等、单事务、elapsedMs）
   ├─ src/articles.rs       # list_articles / get_article_content
   ├─ src/lib.rs            # Tauri Builder 与命令注册、资源目录解析
   └─ tests/import_flow.rs  # AC2/AC3/AC6/AC9 集成测试
```

## 运行期数据

- 本地库：`%APPDATA%\com.judou.cet4\app.db`（SQLite，10 张表；`note`/`vocab`/`progress` 属后续包，本包不建）。
- 内容包：打包后随安装包分发到资源目录 `content-pack/`；开发态回退到 `../content-pack`（`src-tauri` 的上级）。
- 全程无网络请求。
- 库损坏时自动备份为同目录 `app.db.bak-YYYYMMDD-HHmm`，重建空库并重新导入，目录页顶部提示备份名。
