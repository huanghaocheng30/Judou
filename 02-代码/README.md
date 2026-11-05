# 句读 Judou · M1 数据层与文章库

CET4/CET6 阅读精读工作台（Tauri v2 + React 18 + Vite 6 + TypeScript + Rust/rusqlite）。

**本包（M1）把 12 篇 CET4 真题灌进本地库，并让产品第一次「能读」**：
`002` 三列迁移、内容包落位与校验、幂等导入引擎（9 张内容表）、文章库（两分组 + 四类筛选 + 搜索 + URL 保持）、
只读精读页（逐段逐句 + 空格位 + 题目折叠 + 返回）、内容包损坏时的整页错误页。
**仍不做**解析卡/词卡/笔记/生词/复习/用户导入（M2~M5）。

## 常用命令

```powershell
cd 02-代码
npm install                # 首次（生成 package-lock.json；本工程不用 pnpm）
npm run build              # tsc + vite build
npm run tauri dev          # 起 Vite(1420) + Rust，弹「句读」窗口

# 门禁（秒级，可复跑）
npm run verify:sql         # 空库全链 001→002：19 表 / version=2 / 三列类型与默认值 / 6 索引
npm run verify:pack        # 内容包 13 文件 SHA-256 与设计区逐字节一致 + 3,529,547 B
npm run verify:import      # 运行期库：九表 12/90/274/6699/274/213/1561/30/90 + 四项非空 + pack_version
npm run verify:render      # renderTokens 纯函数：6699 token 切片零例外 + 空格 30·62 + 长文 < 50ms
npm run verify:invoke      # 除 src/lib/api.ts 外不许出现 invoke(
npm run verify:contrast    # tokens.css/app.css 的 WCAG 对比度（16 项，含 .tag 配对）
npm run verify:ci          # ci.yml 结构 + 三平台 matrix
npm run test:theme         # 主题解析/应用逻辑（node --test）

# 只查运行期库（不起界面）
node scripts/check-tables.mjs   # 19 表 / version=2 / 6 索引
```

Rust 侧需要 MSVC 环境（`cl.exe` 不在全局 PATH）：

```powershell
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"" && cargo test --manifest-path src-tauri/Cargo.toml"
```

## 内容包与导入（M1）

- **内容包位置**：`content-pack/`（12 篇 `cet4-2023-12-*.json` + `manifest.json`，合计 3,529,547 B）。
  来源是设计区 `01-设计/CET4-阅读精读/内容包/`（**只读引用，逐文件 SHA-256 一致**，由 `verify:pack` 守）。
- **随包分发**：`src-tauri/tauri.conf.json` 的 `bundle.resources` 映射 `../content-pack/` → `content-pack/`。
- **运行期定位**：优先 `resource_dir()/content-pack`；`tauri dev` 下资源未拷进 target，回落
  `CARGO_MANIFEST_DIR/../content-pack`。启动日志打印 `[judou] content-pack dir = …`。
- **导入行为**（`src-tauri/src/import.rs`）：
  - `manifest.packVersion` 是**唯一版本权威**（篇内残留 `packVersion` 不入库、不参与比较）。
  - 版本不同 → 全量 upsert 12 篇；版本相同 → **先做完整性核对**（`sourceKey` 差集 + `totals` 九项计数），
    完整才零写入，缺篇只补缺失篇，子表缺行则整篇重导。**只 INSERT/UPDATE，禁止 DELETE**——
    `article` 被 5 张用户表 `ON DELETE CASCADE` 引用，删一篇会连带删掉用户笔记与复习记录。
  - 单事务；失败整体回滚，返回错误页而不是 panic。
  - `token.is_word` 落**内容包权威 `isWord`**（不推导）：推导会把选词填空的空格 token（`surface="26"`）判成词。
- **内容包坏了**：进程不崩、窗口照开，整页错误页（原因 + 文件名 basename + 「请重新安装」），
  不进入空文章库。错误只带 basename，不泄漏本地路径。

## 本地库位置

`%APPDATA%\com.judou.app\judou.db`（Tauri v2 `app_data_dir()` + `identifier`）。
应用启动时会在 stdout 打印一次 `[judou] db path = …` 与 `[judou] import report = imported N / skipped N / Nms`。
删除该文件即可回到全新库（迁移会自动重建并重新导入内容包）。

迁移纪律：`001_init.sql` 已发布**一字节不改**；后续结构变更一律追加 `002_*.sql`（只做 `ALTER TABLE ADD COLUMN`）。

## 主题

三档 `light` / `dark` / `system`，写入 `app_setting.theme`，重启保持。
表示法：`<html data-theme="light|dark">` 写**解析结果**，`<html data-theme-source="light|dark|system">` 写**用户原值**。

## 目录

```
content-pack/   内置内容包 13 文件（只读数据，SHA-256 由 verify:pack 守）
src/            React 壳（shell = 侧栏/顶栏/主题/路由；pages = 8 页；lib = api/render/theme/types）
src-tauri/      Rust 侧（commands.rs 命令、db.rs 连接与迁移、pack.rs 内容包、import.rs 导入）
                migrations/001_init.sql（冻结）、002_add_import_columns.sql
scripts/        可复跑的断言（verify-* / check-* / theme.test）
.github/        CI 骨架（**M7 收尾时移动到仓库根 .github/**）
```

## 运行期 CDP 取证（读真实 DOM，不截图）

WebView2 支持 Chromium DevTools 协议：

```powershell
# 终端 A
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
npm run tauri dev
# 终端 B
curl http://127.0.0.1:9222/json      # 取 target，再用 Page/Runtime 域断言 DOM
```

M0 的 `scripts/check-theme-runtime.mjs cycle|persisted` 仍可用（主题三档断言）。
**用完必须杀掉 dev 进程**（`Get-Process judou` + 端口 1420/9222 无残留）。

## 图标

```powershell
npx tauri icon src-tauri/icon-source-1024.png -o src-tauri/icons
```

`tauri.conf.json` 的 `bundle.icon` 只列桌面 5 项（32x32 / 128x128 / 128x128@2x / icon.ico / icon.png）；
`tauri icon` 同时生成的 Android/iOS 目录保留给 M7。
