# 句读 Judou

CET4/CET6 阅读精读工作台（Tauri v2 + React 18 + Vite 6 + TypeScript + Rust/rusqlite）。

**M1 把 12 篇 CET4 真题灌进本地库（产品第一次「能读」）；M2 让精读页「能学」**：
点句出**六段式解析卡**（直译/顺译 → 主干与成分 → 从句语法点 → 重点短语 → 易错点 → 段落作用，
`struct_markup` 符号渲染）、点词出**三态词卡**（语境义 / 词义（通用）/ 暂无预置解析）、
点空格出**三段式**（答案 / 为什么 / 易错排除）、题目「显示答案」（只显字母 + 选项文字，**不判对错**）、
句子与词各 **3 栏笔记**（800ms 防抖自动保存、换句先 flush、三栏清空即删行）。
**M3 让学到的东西留得住**：词卡「加入生词本」（同词不同句只一条、保留首次来源）、
生词本三轴（文章/标签/掌握状态）分组 + 筛选搜索、条目编辑 4 字段与标签增删、
「回原句」跳回那一句并高亮 2 秒、文章删了生词还在。
**M4 让学过的东西回得来**：篇级复习 1/3/7/14 天四档、今日到期、完成/还需再看、复习模式。
**M6 让学到的东西出得去、也看得见**：记录与统计页、自包含 HTML 导出（笔记/生词可带出）、
设置页（主题三档 / 数据备份与恢复 / 关于）。
**M7 打通发布与更新链路**（NSIS 打包 + 签名清单 + 离线优先的检查更新）。

**用户导入功能已整体移除**（M11 裁决）：没有粘贴导入、没有 AI 解析导入，文章库也没有「我导入的」入口。
文章库只有**随包内置的 12 篇**，内容变化走内容包升级（见「内置内容包」）。

**仍不做**：PDF/DOCX 解析、文件选择器、导入外部文章、联网检查更新（归 M7 后续）。

## 常用命令

```powershell
cd 02-代码
npm install                # 首次（生成 package-lock.json；本工程不用 pnpm）
npm run build              # tsc + vite build
npm run tauri dev          # 起 Vite(1420) + Rust，弹「句读」窗口

# 门禁（秒级，可复跑）：17 项 manifest 门禁，逐项 EXIT=0 即全绿
npm run verify:invoke      # 除 src/lib/api.ts 外不许出现 invoke(
npm run verify:sql         # 空库全链 001→002：19 表 / version=2 / 三列类型与默认值 / 6 索引
npm run verify:contrast    # tokens.css/app.css 的 WCAG 对比度（38 项，含 5 种符号标记、掌握状态三档、回原句高亮）
npm run verify:ci          # ci.yml 结构 + 三平台 matrix
npm run verify:pack        # 内容包 13 文件 SHA-256 与设计区逐字节一致 + 3,529,547 B
npm run verify:render      # renderTokens 纯函数：6699 token 切片零例外 + 空格 30·62 + 长文 < 50ms（M2 回归基线）
npm run verify:analysis    # parseMarkup 守恒 274/274 + fail-closed 恰 7 句 + 六段序 + 词卡三态 + 30 空两形态
npm run verify:note        # 001+002 建临时库：updated_at NOT NULL 无 DEFAULT + upsert/读回/刷新/清空删行
npm run verify:note-marks  # 「本篇笔记标记」命令契约 + SQL 语义（analysis.rs / commands.rs / lib.rs 注册 / 前端钩子）
npm run verify:vocab       # 001+002 建临时库：同词聚合只一条 + 首次来源不变 + 标签全量替换 + 删词连带 + 分组排序（180 判据）
npm run verify:review      # 001+002 建临时库：7 命令 + 首调建计划/幂等 + 到期过滤排序 + 四档顺延/终态 + need_more + restart 两分支 + log 记完成前 index + 三表零外写（128 判据）
npm run verify:records     # M6 静态契约：命令注册 / SQL 聚合口径 / 自包含 HTML 无外链 / 主题持久键 / 版本一致
npm run verify:release     # 版本三处一致 + 工作流 YAML + 无明文密钥 + 私钥忽略 + 发布脚本（纯静态）
npm run verify:pending     # 未落库草稿的两条判定：条件删除（D-M2-11）/ 200 上限与活跃 key 保护（D-M2-12）
npm run verify:android     # Android 导出契约：platform.ts 的 isAndroid() / 零新依赖 / 无 window 时安全
npm run verify:tables      # 只读打开运行期库（不起界面）：19 表 / version=2 / 6 索引
npm run verify:icons       # 5 个桌面图标在位 + bundle.icon 逐项一致 + 无默认模板 logo 残留

# 纯逻辑测试（不在 manifest 17 项内）
npm run test:theme         # 主题解析/应用逻辑（node --test）
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

## 生词本（M3）

- **收藏（词卡）**：词卡底部「加入生词本」→ `add_vocab_from_token`；已收藏显示「已在生词本 + 移出」。
  数据流**必经 `AnalysisPanel`**（`src/components/AnalysisPanel.tsx`）：`selection.normalized` 只有它持有
  （`WordCardModel` 没有该字段），它查 `get_vocab_by_normalized` 后把 `{normalized, vocabState, onAdd, onRemove}`
  经 props 下发给 `WordCard`——**`WordCard` 不自取数**。收藏态**一律 `data-vocab-state="none|added"`**，
  **不复用 `data-has-note`**（那是 M2 的笔记标记）。`created=false`（词已在库）同样置 `added`，**不重查全量**。
- **聚合口径**：`vocab_entry.normalized` UNIQUE → 同词不同句**只一条**；重复收藏**不改**首次来源三列
  （`surface` / `source_sentence_id` / `source_article_id`），`context_meaning` 是收藏瞬间的快照，
  内容包升级不回溯。`token_analysis` 没有的词**也能收藏**（语境义为 NULL）。文章删了生词还在（`ON DELETE SET NULL`）。
- **生词本页**（`#/vocab`，`src/pages/Vocab.tsx`）：三轴切换（按文章/按标签/按掌握状态）+ 掌握状态单选 +
  标签多选（**AND**：都要有）+ 关键词搜（`normalized`/`surface` 不区分大小写）；分组与排序全在纯函数层
  `src/lib/vocab.ts`（文章轴「来源已删除」排最后、掌握轴固定 `new→fuzzy→known`、标签轴一词可属多组）。
  两种空态：`data-vocab-empty="all"`（还没有生词 + 「去文章库」）/ `"filtered"`（有但没命中 + 「清除筛选」）。
- **编辑**（`src/components/VocabEditor.tsx`）：**只改表结构里有的 4 列**——语境义 / 音标 / 词性 / 掌握状态，
  加标签增删（**全量替换**：传进去的名单就是最终名单）。标签输入 **Enter 添加、chip 上 × 删除、Esc 取消当前输入**；
  保存 = `update_vocab` + `set_vocab_tags` 两步幂等写，**失败保留输入并提示重试**（不静默丢）。
  保存成功后 `Vocab.tsx` **就地替换该行 + 重拉 `list_vocab`/`list_tags`**（标签变化会改分组归属）。
- **移出**：行内轻量二次确认（不弹原生 `confirm`），删条目连带清 `vocab_tag`，标签本身保留。
- **点回原句**（`src/pages/Reader.tsx`）：条目链接形态 `#/article/<articleId>?sentence=<sentenceId>`
  （**路径段给文章、query 给句子**；`#/article?id=…` 会解析出 `articleId=undefined`）。
  Reader **在 `content` 就绪之后**才消费 query → `scrollIntoView({block:'center'})` + 高亮 2 秒
  （`data-highlight="1"` + `.sentence-flash`，卸载/再跳转清定时器）。**fail-safe**：句子不属于本篇 / 节点找不到
  → **不滚动、不报错、停留原位**（`scrollTop` 前后不变）。来源已删（`sourceArticleId=null`）时按钮**不显示**（不是禁用）。
- **无障碍**（AC7）：掌握状态三档**文字就是标签**（新词/模糊/已掌握），颜色只作强化；
  列表项与按钮可 Tab、`:focus-visible` 2px 轮廓；点收藏按钮**不关面板、不触发句子卡**（`stopPropagation`）；
  **不放灰色禁用态**——「加入生词本」与「移出」都可点。
- **顺带收 M2 两债务**（`src/lib/pending.ts` + `scripts/pending.test.mjs`）：
  ① 未落库草稿的成功回调改**条件删除**（同 key 已有新草稿时旧回调不删，D-M2-11）；
  ② 模块级草稿 Map 加 **200 条上限**，超出淘汰最旧且**活跃 key 不淘汰**（D-M2-12）。两条都有先红后绿。

## 复习（M4）

篇级复习按 **1 / 3 / 7 / 14 天** 四档排队（`review_plan.interval_index` 0→3，四档走完置 `status='done'` 不再提醒）。

- **完成本篇**：精读页正文末尾（题目区之后）的「完成本篇」按钮 → mark_article_completed(articleId, today)。
  **必须显式点**（不滚动到底就完成）；**幂等**——已有计划时原样返回，文案变成「已在复习计划中（X 到期）」。
  成功同时写 `reading_record.completed=1`（只写这一列 + last_read_at，last_position/duration_sec 归 M6）。
- **复习页**（`#/review`）四态：无到期（`data-review-empty="none"`）/ 有到期（`data-review-row`，按到期日升序）/
  今日已完成（`data-review-empty="done"`）/ 读取中。另有「已完成」区列出 `status='done'` 的文章，可「重新加入复习」。
  页面自报的 today 在 `data-review-today` 上——**跨午夜断言一律读它**，不做时钟假设。
- **复习模式**（`#/article/<id>?mode=review`）：复用精读页，**只隐藏**笔记提示（句「析」角标 / 词圆点 / 生词收藏按钮），
  不删 DOM（`data-review-mode="1"` + 三条 CSS）。底部换成「完成复习 / 还需再看」；
  复习模式下 `?sentence=` / `?token=` 高亮照常生效。
- **侧边栏角标**：「复习」项显示今日到期数（`data-review-badge` + `aria-label`），为 0 不显示；启动与路由变化时刷新，不轮询。
- **日期口径**：一切 `today` 都是**本地日期 `YYYY-MM-DD` 字符串**，由前端算好传给命令；
  命令层**不用** `date('now')` 推日期（`datetime('now')` 只用于记录时刻列）。

## 内置内容包

> 这一节讲的是**随 App 分发的 12 篇内置文章怎么装进本地库**（不是用户导入功能——该功能已移除）。

- **内容包位置**：`content-pack/`（12 篇 `cet4-2023-12-*.json` + `manifest.json`，合计 3,529,547 B）。
  来源是设计区 `01-设计/CET4-阅读精读/内容包/`（**只读引用，逐文件 SHA-256 一致**，由 `verify:pack` 守）。
- **随包分发**：`src-tauri/tauri.conf.json` 的 `bundle.resources` 映射 `../content-pack/` → `content-pack/`。
- **运行期定位**：优先 `resource_dir()/content-pack`；`tauri dev` 下资源未拷进 target，回落
  `CARGO_MANIFEST_DIR/../content-pack`。启动日志打印 `[judou] content-pack dir = …`。
- **装载行为**（`src-tauri/src/import.rs`，解析与校验在 `pack.rs`）：
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

迁移纪律：`001_init.sql` 已发布**一字节不改**；后续结构变更一律追加 `00N_*.sql`（只做 `ALTER TABLE ADD COLUMN`；现有 002、003）。

## 主题

三档 `light` / `dark` / `system`，写入 `app_setting.theme`，重启保持。
表示法：`<html data-theme="light|dark">` 写**解析结果**，`<html data-theme-source="light|dark|system">` 写**用户原值**。

## 目录

```
content-pack/   内置内容包 13 文件（只读数据，SHA-256 由 verify:pack 守）
src/            React 壳（shell = 侧栏/顶栏/主题/路由；pages = 7 页；lib = api/render/theme/types/vocab/pending/platform/date）
src/components/ 解析面板与卡片（AnalysisPanel/SentenceCard/WordCard/BlankCard/NoteEditor/VocabEditor/Onboarding）
src-tauri/      Rust 侧（commands.rs 命令、db.rs 连接与迁移、pack.rs 内容包解析与校验、import.rs 内置内容包装载、
                analysis.rs 解析、vocab.rs 生词本、review.rs 复习、records.rs 记录统计、export.rs 导出、update.rs 检查更新）
                migrations/001_init.sql（冻结）、002_add_import_columns.sql、003_answer_source.sql
scripts/        可复跑的断言（verify-* / check-* / theme.test / pending.test）
                （CI 骨架**已搬到仓库根 `.github/workflows/`**，E-M7-2；本目录下无 .github）
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
`tauri icon` 同时生成的 Android/iOS 图标目录供移动端构建使用（M13 的 Android 真机构建）。

## 发布与更新链路（M7）

### 版本号：三处必须一致

`src-tauri/tauri.conf.json` 的 `version` = `package.json` 的 `version` = `src-tauri/Cargo.toml` 的 `[package].version`。
门禁 `npm run verify:release` 会断言（同时校验工作流 YAML、无明文密钥、`.gitignore` 覆盖私钥、发布脚本齐备）。

### 命令

```powershell
npm run verify:release              # 版本一致 + 工作流 + 私钥忽略 + 发布脚本（秒级，纯静态）
node scripts/make-update-manifest.mjs --url-base https://…/releases/download/v0.2.0
                                    # 由打包产物 + 签名生成 latest.json（无签名会明确报错退出）
powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
                                    # 人工打包：npx tauri build --bundles nsis，打印产物路径与大小
                                    # 只打包，不发布、不生成清单；CI 不自动执行本脚本
```

### 出 `.sig` 签名与 `latest.json`：两步前置（本仓库默认不开）

要生成 `latest.json`，打包产物旁边必须已有 `<安装包>.exe.sig`。**只配密钥不够**，两步都要做：

1. **开清单产物开关**：`src-tauri/tauri.conf.json` 的 `bundle` 段加 `"createUpdaterArtifacts": true`
   （Tauri 2 的 schema 默认 `false`，开关关着时 `tauri build` **不会**产出 `.exe.sig`）。
2. **配签名密钥**：环境变量 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容或文件路径）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，
   然后重新打包；私钥文件不入库（`.gitignore` 已覆盖 `*.key` / `*.pem` / `tauri-signing*` / `.tauri-keys/`）。

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\path\to\judou.key'   # 或直接给私钥内容
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '…'
powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1    # 此时 nsis/ 下会多出 .exe.sig
node scripts/make-update-manifest.mjs --url-base https://…/releases/download/v0.2.0
```

> **本仓库默认不开（E-M7-1 裁决）**：开启 `createUpdaterArtifacts` 后，`tauri build` 变成**必须有签名密钥**，
> 缺密钥直接打包失败——这会破坏「一条命令就能出安装包给人试」。所以默认保持关闭，
> **只在真要发布更新时临时开启**（并配好密钥）。脚本跑不通时给出的「怎么修」提示就指向这两步。

### CI 与发布工作流

- `.github/workflows/ci.yml`：`cargo check` / `cargo test` / `npm run build` / 发布与回归门禁；矩阵 `windows-latest` / `macos-latest` / `ubuntu-latest`
- `.github/workflows/release.yml`：`workflow_dispatch` + tag `v*` 触发，`tauri-action` 产出 Windows NSIS 并上传**草稿** Release

> **位置说明（E-M7-2 已落地）**：GitHub Actions 只认仓库根 `.github/workflows/`，而目标代码区是
> `02-代码/`。两个 workflow 已搬到**仓库根** `.github/workflows/`（`02-代码/.github/` 已不存在）；
> 搬迁后路径仍是「相对仓库根」：`defaults.run.working-directory: 02-代码`、`cache-dependency-path:
> 02-代码/package-lock.json`、rust-cache `workspaces: 02-代码/src-tauri`、`projectPath: 02-代码` 全部保持不变即正确。
> 门禁脚本 `scripts/check-ci.mjs` / `scripts/verify-release.mjs` 的 workflow 查找根已同步上跳一级（`repoRoot`）。

> **签名私钥**：只引用 `secrets.TAURI_SIGNING_PRIVATE_KEY` / `secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
> 这两个名称，仓库内不留任何密钥文件（`.gitignore` 覆盖 `*.key` / `*.pem` / `tauri-signing*` / `.tauri-keys/`）。
> Release 里的「生成 / 上传 latest.json」两步由仓库变量 `JUDOU_UPDATER_ENABLED=true` 才启用。

### 检查更新（离线优先）

设置 → 关于 → 「检查更新」调后端 `check_update`，**不引任何 HTTP 依赖**（`Cargo.toml` 里没有
`reqwest`/`ureq`/`tauri-plugin-http`，本包不新增——为一个可选功能引入 HTTP 栈会显著增大二进制与供应链面）。

行为：

- 读 manifest 文件 → 解析 `{"version","notes","platforms":{"windows-x86_64":{"signature","url"}}}` → 比版本
- manifest 路径：环境变量 `JUDOU_UPDATE_MANIFEST` 优先，否则应用数据目录下 `latest.json`（与 `judou.db` 同级）
- 文件不存在 → `reason="no-manifest"`；版本不新 → `reason="up-to-date"`；读不到/读坏了 → `reason="offline"`
- 任何失败都**不抛错、不阻塞启动**，只影响设置页那行文案（有新版 / 已是最新 / 检查失败，稍后再试）

> **联网检查归 M7 后续**：届时只需把「读本地文件」换成「拉远端 latest.json」，
> 解析与版本比较（`parse_manifest` / `is_newer`）原样复用。
