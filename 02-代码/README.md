# 句读 Judou · M5 用户导入

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
**M5 让自己找的文章也能读进来**：粘贴纯文本 → 预览（段/句/词数、可剔段、可改标题）→ 四层校验入库；
导入篇没有预置解析，精读页走「该篇无预置解析，可写笔记」的降级形态。
**仍不做**导出（M6）、PDF/DOCX/文件选择器。

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
npm run verify:import-user # 用户导入：清洗/分段/切句/分词 + parse 零写入 + 四层校验六错误码 + commit 两篇/剔段
npm run verify:ai-import   # AI 解析导入：三题型 fixture 逐格比对 + 16 组反例/边界 + 偏移自算 + 补解析不动结构
npm run verify:render      # renderTokens 纯函数：6699 token 切片零例外 + 空格 30·62 + 长文 < 50ms（M2 回归基线）
npm run verify:analysis    # parseMarkup 守恒 274/274 + fail-closed 恰 7 句 + 六段序 + 词卡三态 + 30 空两形态
npm run verify:note        # 001+002 建临时库：updated_at NOT NULL 无 DEFAULT + upsert/读回/刷新/清空删行
npm run verify:vocab       # 001+002 建临时库：同词聚合只一条 + 首次来源不变 + 标签全量替换 + 删词连带 + 分组排序（180 判据）
npm run verify:review      # 001+002 建临时库：7 命令 + 首调建计划/幂等 + 到期过滤排序 + 四档顺延/终态 + need_more + restart 两分支 + log 记完成前 index + 三表零外写（128 判据）
npm run verify:pending     # 未落库草稿的两条判定：条件删除（D-M2-11）/ 200 上限与活跃 key 保护（D-M2-12）
npm run verify:invoke      # 除 src/lib/api.ts 外不许出现 invoke(
npm run verify:contrast    # tokens.css/app.css 的 WCAG 对比度（38 项，含 5 种符号标记、掌握状态三档、回原句高亮）
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

篇级复习按 **1 / 3 / 7 / 14 天** 四档排队（eview_plan.interval_index 0→3，四档走完置 status='done' 不再提醒）。

- **完成本篇**：精读页正文末尾（题目区之后）的「完成本篇」按钮 → mark_article_completed(articleId, today)。
  **必须显式点**（不滚动到底就完成）；**幂等**——已有计划时原样返回，文案变成「已在复习计划中（X 到期）」。
  成功同时写 eading_record.completed=1（只写这一列 + last_read_at，last_position/duration_sec 归 M6）。
- **复习页**（`#/review`）四态：无到期（`data-review-empty="none"`）/ 有到期（`data-review-row`，按到期日升序）/
  今日已完成（`data-review-empty="done"`）/ 读取中。另有「已完成」区列出 `status='done'` 的文章，可「重新加入复习」。
  页面自报的 today 在 `data-review-today` 上——**跨午夜断言一律读它**，不做时钟假设。
- **复习模式**（`#/article/<id>?mode=review`）：复用精读页，**只隐藏**笔记提示（句「析」角标 / 词圆点 / 生词收藏按钮），
  不删 DOM（`data-review-mode="1"` + 三条 CSS）。底部换成「完成复习 / 还需再看」；
  复习模式下 `?sentence=` / `?token=` 高亮照常生效。
- **侧边栏角标**：「复习」项显示今日到期数（`data-review-badge` + `aria-label`），为 0 不显示；启动与路由变化时刷新，不轮询。
- **日期口径**：一切 `today` 都是**本地日期 `YYYY-MM-DD` 字符串**，由前端算好传给命令；
  命令层**不用** `date('now')` 推日期（`datetime('now')` 只用于记录时刻列）。
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

## 用户导入（M5）

`#/import`：**粘贴纯文本 → 解析预览 → 剔段/改标题/选题型年份 → 确认导入**，成功后跳 `#/article/<id>`。

- **两阶段**：`parse_import_preview(text, title?)` **只算不写库**（AC1 用 `db.total_changes()` 前后差值 = 0 验），
  `commit_import(preview, meta)` 是**单事务**入库；frontend 把 preview 整对象回传，
  **不在前端重算偏移或 stats**（唯一例外见下条「剔段」）。
- **预览页**（`src/pages/Import.tsx`）：`data-import-preview` / `data-import-stats`（`data-paragraph-count` /
  `data-sentence-count` / `data-word-count`）/ `data-import-paragraph`（每段一个勾选框 `data-import-paragraph-toggle`）/
  `data-import-commit`。剔段用「段落 idx 集合」而不是从数组里删，取消勾选天然可逆。
- **剔段后必须重算 stats**：`commit_import` 直接拿 `preview.stats` 写 `article.sentence_count/word_count`
  （AC7/B-3'，文章库卡片读它），L4 也用它判「句数 ≥1、词数 ≥10」——回传旧 stats 会把剔除前的数字记进库。
- **四层校验**（任一失败整体回滚、库中零写入）：L1 结构 / L2 偏移 / L3 覆盖 / L4 业务。
  六个错误码：`IMPORT_L1_STRUCTURE`、`IMPORT_L2_OFFSET`、`IMPORT_L3_COVERAGE`、`IMPORT_L4_BUSINESS`、
  `IMPORT_TOO_LARGE`（> 20,000 字符）、`IMPORT_DUPLICATE_SOURCE`。
- **错误交互**（AC11）：解析或提交失败时**预览与用户编辑全部保留**（标题、剔除选择、粘贴原文），
  错误条给**错误码 + 可操作提示**（如 `IMPORT_L2_OFFSET` → 「文本含不可见字符，请重新粘贴」；
  `IMPORT_TOO_LARGE` → 「正文超过 2 万字符，请分段导入」）。
- **入库口径**：`visibility='user'`、`source_key='user-<hex>'`（每次提交新生成 → **同一篇再导一次是两篇**）、
  `exam_type` 默认 `other`、`exam_year` 默认空。文章库「我导入的」Tab 直接可见（`list_articles` 早已带 visibility 筛选）。
- **降级精读**（AC9）：导入篇零 `sentence_analysis` 行 → `has_analysis=false` → 句子卡显
  「**该篇无预置解析，可写笔记**」，词卡显「暂无预置解析」且「加入生词本」按钮在（可收藏、可写笔记）。
  **`commands.rs` 里这个字段是真实查询**（`EXISTS(sentence_analysis JOIN sentence WHERE article_id=?)`），
  不是硬编码 `true`（硬编码会让上面那句降级文案在真机永不出现）。
- **门禁**：`npm run verify:import-user`（`scripts/verify-import-user.mjs` + `src-tauri/src/bin/import_user_cli.rs` 契约）。

## AI 解析导入（M5b）

`#/import` 现在有**两个 Tab**（`data-import-mode="quick"` / `"ai"`）：快速导入照旧只要原文；
**AI 解析导入**多拿一份语义（逐句解析 / 题目答案 / 词条），但**不调任何外部 AI、不带 key、不联网**——
模板由 App 本地生成，你复制给自己的 AI 用。

**四步**

1. **选题型**（`data-ai-section` 三选一：仔细阅读 / 长篇阅读 / 选词填空）→ 粘原文 → 点「解析原文」，
   界面显示「N 段 / M 句」与句子清单（`S编号` + 原文前 24 字符）。
2. 点「**复制提示词 + 句子清单**」（`data-ai-prompt-copy`）→ 把提示词**连同这篇原文**一起交给你的 AI。
   模板按题型只给对应片段，并明确要求：`quote` 逐字符拷贝、不要给 `start`/`end`/`offset`/`tokens`、`section` 原样回填。
3. 把 AI 返回的 JSON **粘回**（`data-ai-payload`）→「解析并匹配」→ 看覆盖率与未匹配清单。
   带 ``` 围栏或前后说明文字也没关系：App 只取最外层 `{ … }`，其余丢弃并显示「已忽略 N 字说明文字」（`data-ai-ignored-chars`）。
4. 看覆盖率（`data-ai-coverage`：解析 x/M · 题目 n · 词条 n；选词填空另显示 `data-ai-blank-coverage` 逐空 k/10）
   →「导入这篇文章」（`data-ai-commit`）→ 跳精读页。

**题型怎么选**：选错了会被拒收（`AI_TYPE_MISMATCH`，`path="section"`）。三种题型的形态要求：

| 题型 | `section` | 题目形态 | 分批建议 |
|---|---|---|---|
| 仔细阅读 | `careful` | 每题 **4 个 options** + `answer` 是其中一个 key | 20 句左右，一次给完 |
| 长篇阅读 | `long` | 每题 `options: []` + `answer` 是**段落字母** | 47 句 → 按段落拆 2~4 批 |
| 选词填空 | `cloze` | 每题 **15 项词库**；`questions[].no` 必须正好等于正文空号；`blankAnalyses` 可只给一部分空 | 13 句，一次给完 |

**分批与累加**：15 句是**建议值不是硬上限**（句数 > 15 只在 `data-ai-batch-hint` 提示「建议分批」，
不报错、不阻断）。分几次粘回时覆盖率**累加**（同一句再给一次视为修订）。

**允许不完整**：只给一部分句解析也能入库（`解析 20/M`）；未覆盖的句子在精读页显示「该句暂无解析」。
选词填空少给几个空的解析同样入库（`逐空 6/10`）——只有**结构性错误**才拒收。

**未匹配怎么处置**（`data-ai-unmatched`，逐条给原因，**不静默丢弃**）：
- `data-ai-skip`「跳过该句」→ 该句不入解析，其余照常入库；
- `data-ai-regen`「重新生成该句」→ 复制只含该句的小模板（含 `S编号` + 原文，`data-ai-regen-text` 里也能直接复制），再喂给 AI 补一次。

**后补解析**（AC9）：文章库卡片与精读页页头都有「补解析」（`data-ai-patch`）→ `#/import?articleId=<id>`。
原文从文章库回读并**锁定**（不再粘原文），题型初值取 `article.section_type`（为空或非法时要你自己选，App 不猜）；
覆盖率初值取库里真读数。补解析**只写解析四表**（`sentence_analysis`/`question`/`lexicon`/`blank`），
`paragraph`/`sentence`/`token` 一字不动 → 笔记、生词、复习记录都不会失效。

**常见错误与自查**（错误码 + 定位 `path` 都在错误条上，`data-ai-error-path`）：

| 错误码 | 含义 | 自查什么 |
|---|---|---|
| `AI_PAYLOAD_INVALID` | 粘回来的不是合法 JSON | 是否漏了结尾的 `}`；只粘 `{ … }` 这一段 |
| `AI_TYPE_MISMATCH` | 题型/形态不符（六种，见下） | 见下面六条 |
| `AI_MARKUP_UNBALANCED` | 某句 `structMarkup` 不配平 | `_` 与 `~` 必须成对；`【】{}()` 必须配对；也可「跳过该句」 |
| `AI_NO_MATCH` | 一句都没对上 | 通常是粘了别的文章的解析；检查 `quote` 是否逐字符一致 |

**六种形态错误**（`AI_TYPE_MISMATCH` 的全部来源，其他一律不拒收）：

1. 长篇阅读的 `questions[].options` 非空（应为 `[]`）；
2. 仔细阅读任一题 `options` 不是 4 项；
3. 选词填空任一题 `options` 不是 15 项；
4. 选词填空 `questions[].no` 集合 ≠ 正文空号集合，或 `blankAnalyses[].no` 里有正文不存在的空号；
5. payload 的 `section` 与本次所选题型不一致；
6. `section` 不在 `careful` / `long` / `cloze` 内。

另外三条**不报错但会归一**的行为，供自查：`answer` 不在选项/段落字母范围内 → 该题归一为无答案
（`data-ai-missing-answer` 显示缺答案题数，**不猜不补**）；`sNo` 与 `quote` 冲突 → 以 `quote` 为准
（`data-ai-sno-fixed` 显示纠正条数）；`lexicon` 里的词若不在正文 → 不进库、列进未匹配清单。

**门禁**：`npm run verify:ai-import`（`scripts/verify-ai-import.mjs` + `src-tauri/src/bin/ai_import_cli.rs` 契约）。
fixture 由 `node scripts/fixtures/ai-import/build-fixtures.mjs` 从仓库内 2024-06 完整内容包**可复算**派生。

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
src/            React 壳（shell = 侧栏/顶栏/主题/路由；pages = 8 页；lib = api/render/theme/types/vocab/pending）
src/components/ 解析面板与卡片（AnalysisPanel/SentenceCard/WordCard/BlankCard/NoteEditor/VocabEditor）
src-tauri/      Rust 侧（commands.rs 命令、vocab.rs 生词本 8 命令、db.rs 连接与迁移、pack.rs 内容包、import.rs 导入）
                ai_import.rs 是 M5b AI 解析导入的唯一实现（4 纯函数 + 2 库层写库函数；SQL 只在它里面）
                migrations/001_init.sql（冻结）、002_add_import_columns.sql
src-tauri/src/bin/  门禁通道：import_user_cli.rs（M5）/ ai_import_cli.rs（M5b；只调 lib 层，不复制 SQL）
scripts/        可复跑的断言（verify-* / check-* / theme.test / pending.test）
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
