# 句读 Judou · M2 精读闭环

CET4/CET6 阅读精读工作台（Tauri v2 + React 18 + Vite 6 + TypeScript + Rust/rusqlite）。

**M1 把 12 篇 CET4 真题灌进本地库（产品第一次「能读」）；M2 让精读页「能学」**：
点句出**六段式解析卡**（直译/顺译 → 主干与成分 → 从句语法点 → 重点短语 → 易错点 → 段落作用，
`struct_markup` 符号渲染）、点词出**三态词卡**（语境义 / 词义（通用）/ 暂无预置解析）、
点空格出**三段式**（答案 / 为什么 / 易错排除）、题目「显示答案」（只显字母 + 选项文字，**不判对错**）、
句子与词各 **3 栏笔记**（800ms 防抖自动保存、换句先 flush、三栏清空即删行）。
**仍不做**生词本/复习/用户导入（M3~M5）。

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
npm run verify:render      # renderTokens 纯函数：6699 token 切片零例外 + 空格 30·62 + 长文 < 50ms（M2 回归基线）
npm run verify:analysis    # parseMarkup 守恒 274/274 + fail-closed 恰 7 句 + 六段序 + 词卡三态 + 30 空两形态
npm run verify:note        # 001+002 建临时库：updated_at NOT NULL 无 DEFAULT + upsert/读回/刷新/清空删行
npm run verify:invoke      # 除 src/lib/api.ts 外不许出现 invoke(
npm run verify:contrast    # tokens.css/app.css 的 WCAG 对比度（26 项，含 5 种符号标记 ×2 主题）
npm run verify:ci          # ci.yml 结构 + 三平台 matrix
npm run test:theme         # 主题解析/应用逻辑（node --test）

# 只查运行期库（不起界面）
node scripts/check-tables.mjs   # 19 表 / version=2 / 6 索引
```

Rust 侧需要 MSVC 环境（`cl.exe` 不在全局 PATH）：

```powershell
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"" && cargo test --manifest-path src-tauri/Cargo.toml"
```

## 精读交互与笔记（M2）

- **选中态三者互斥**（`src/components/AnalysisPanel.tsx`）：点词 → 词卡（带 `normalized` 查全局词库）、
  点句 → 六段式卡（卡顶重述原句）、点空格 → 三段式卡。词/句/空节点都 `stopPropagation`，
  点词不会误触句子卡；点「词之间的空白/句尾」落回句节点。
- **两形态**（AC9）：`≥1100px` → `.reader-split` grid 双列（正文列 + 360px 右栏，点句**原地更换**、不遮正文）；
  `<1100px` → 底部抽屉（`max-height ≤55vh`、拖动条指针/键盘 ↑↓ 可调、`Esc` 关闭）。
  断点用 `matchMedia` + `useSyncExternalStore`（`AnalysisPanel` 导出 `useWideLayout`，`Reader` 复用同一份判定）。
- **面板三态**：`data-panel-status="loading|ready|none"`——**进入查询即 `loading`**（显示骨架），
  查无结果仍是 `ready`（走「本段暂无解析」降级文案）。
- **符号渲染**（AC3）：`【主语】` / `_谓语_` / `~宾语表语~` / `{从句}` / `(短语)` →
  `<mark class="mk-*" data-mark-kind="*">`；颜色**不是唯一通道**（主语轻底、谓语实线下划线、宾语波浪线、
  从句/短语保留括号）。标记符奇数（标注坏）→ 整串降级为纯文本（`failedClosed`），不抛错、不白卡。
- **笔记**（`src/components/NoteEditor.tsx` + `src/hooks/useDebouncedSave.ts`）：句子 3 栏（翻译/语法/短语）、
  词 3 栏（语境义/搭配/例句），与 `sentence_note` / `word_note` 表结构一一对应。
  停止输入 **800ms** 落库；**换句/换词先 flush 旧目标**（`targetKey` 变化是唯一 flush 入口）；
  卸载/`pagehide` 同一条 flush；**三栏清空 → DELETE 行**（UI 显「已清空」）；
  失败 → 草稿留在输入框 + 「保存失败，点此重试」+ `data-note-status="error"`（**不静默丢**）。
- **题目**：默认折叠；每题「显示答案」→ 只显答案字母 + 选项文字，**不判对错、不计分、不用对错语义色**；
  `answer IS NULL` → 「本题无预置答案」；选项是纯文本 `<li>`，**不可点选**。
- **键盘**：词/句/空节点 `tabIndex=0` + `role="button"` + `Enter`/`Space` 等价点击；`:focus-visible` 全局 2px 轮廓。

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
