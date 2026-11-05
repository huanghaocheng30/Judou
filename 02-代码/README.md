# 句读 Judou · M0 骨架与环境

CET4/CET6 阅读精读工作台（Tauri v2 + React 18 + Vite 6 + TypeScript + Rust/rusqlite）。
**M0 只交付可启动的骨架**：19 张物理表的本地库、`ping`/设置命令链路、三档主题、句读图标、CI 骨架。
不导入文章、不解析、不复习（M1 起逐个接入）。

## 常用命令

```powershell
cd 02-代码
npm install                # 首次（生成 package-lock.json；本工程不用 pnpm）
npm run build              # tsc + vite build（AC1）
npm run tauri dev          # 起 Vite(1420) + Rust，弹「句读」窗口
npm run verify:invoke      # AC3：除 src/lib/api.ts 外不许出现 invoke(
npm run verify:sql         # D2：node:sqlite 空跑 001_init.sql，验 19 表/索引/默认值
npm run verify:contrast    # AC4：tokens.css 深浅两套变量的 WCAG 对比度
npm run verify:ci          # AC6：ci.yml 结构 + 三平台 matrix + android 占位
npm run test:theme         # AC4：主题解析/应用逻辑（node --test）
node scripts/check-tables.mjs  # AC2：只读打开运行期库，核对 19 表/version/索引
node scripts/check-icons.mjs   # AC5：图标 5 项非空 + bundle.icon 逐项匹配 + 窗口标题
```

### AC4 运行期取证（读真实 DOM，不截图）

WebView2 支持 Chromium DevTools 协议。带远程调试端口启动 dev，再用脚本读 `documentElement.dataset`
并点三次主题按钮：

```powershell
# 终端 A
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
npm run tauri dev
# 终端 B（等窗口出现后）
node scripts/check-theme-runtime.mjs cycle     # 三档各断言一次 + 抓控制台的 ping 输出（AC3）
# 杀掉 dev 再重启，然后
node scripts/check-theme-runtime.mjs persisted # 重启后仍为上次选择
```

`cycle` 结束会把主题停在「深色」，供 `persisted` 断言。

Rust 侧需要 MSVC 环境（`cl.exe` 不在全局 PATH）：

```powershell
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"" && cargo check --manifest-path src-tauri/Cargo.toml"
```

## 本地库位置

`%APPDATA%\com.judou.app\judou.db`（Tauri v2 `app_data_dir()` + `identifier`）。
应用启动时会在 stdout 打印一次 `[judou] db path = …`，自测与后续包都按这行取路径。
删除该文件即可回到全新库（迁移会自动重建）。

## 主题

三档 `light` / `dark` / `system`，写入 `app_setting.theme`，重启保持。
表示法：`<html data-theme="light|dark">` 写**解析结果**（CSS 靠它切变量），
`<html data-theme-source="light|dark|system">` 写**用户原值**（区分 system 与 light，供断言与调试）。

## 目录

```
src/            React 壳（shell = 侧栏/顶栏/主题/路由；pages = 8 页；lib = api/theme/types）
src-tauri/      Rust 侧（commands.rs 命令、db.rs 连接与迁移、migrations/001_init.sql）
scripts/        可复跑的断言（verify-invoke / verify-sql / check-contrast / check-ci / check-tables / theme.test）
.github/        CI 骨架（**M7 收尾时移动到仓库根 .github/**）
src-tauri/icon-source-1024.png   图标源图（由 01-设计 定稿件拷入，供 `npx tauri icon` 重生成）
```

## 图标

```powershell
npx tauri icon src-tauri/icon-source-1024.png -o src-tauri/icons
```

`tauri.conf.json` 的 `bundle.icon` 只列桌面 5 项（32x32 / 128x128 / 128x128@2x / icon.ico / icon.png）；
`tauri icon` 同时生成的 Android/iOS 目录保留给 M7。
