# D1 AGENTS.md — 项目级开发约束

> 版本：v1.0  
> 状态：定稿  
> 适用对象：AI 编码代理、人类开发者  
> 上游文档：`docs/A1-项目定义卡.md`、`docs/A2-PRD.md`、`docs/C1-技术方案总览.md`、`docs/C2-数据模型设计.md`、`docs/C3-Command接口清单.md`、`docs/C4-导入模块设计规格.md`、`docs/C5-自动更新与发布方案.md`  
> 本文档是仓库级约束入口。写任何代码前先读本文件；与本文件冲突的生成结果，视为错误，必须修正。详细规格以 `docs/` 下对应文档为准。

---

## 1. 文档说明

### 1.1 目的

把散落在 `docs/` 各文档中的**硬约束、禁止事项、实现边界**收拢成一份 AI 和人类每次开工前都能快速读完的约束文件，减少“AI 写得很顺但偏离架构”的返工。

### 1.2 范围

覆盖技术栈、架构原则、数据层、导入层、接口层、前端、测试、发布、禁止事项和 Vibe Coding 提示词模板。**不重复** `docs/` 中的完整业务规则和字段定义，只固化“违反即返工”的约束。

### 1.3 读者

- **AI 编码代理**：每次任务前必读，作为系统级约束。
- **人类开发者**：作为代码评审和自查的检查清单。
- **未来的自己**：三个月后回顾时，快速恢复“为什么这么定”。

### 1.4 维护规则

- 新增硬约束或修改红线时，同步更新本文件和对应 `docs/` 文档。
- 关键取舍变更需在 `docs/F3-决策记录.md` 中留痕。
- 本文件不与 `docs/` 冲突；若发现冲突，以 `docs/` 为准并修正本文件。

---

## 2. 项目概述

### 2.1 产品定位

**四级阅读精读工作台（本地优先）。**

- **核心闭环**：选/导文章 → 读原文 → 点句点词写笔记 → 收藏生词 → 按篇复习 → 看记录。
- **形态**：Tauri v2 桌面应用（Windows/macOS/Linux）+ Android APK，纯本地，无服务端，无账号。
- **数据**：全部存本机 SQLite，更新不丢数据。

### 2.2 明确不做

账号体系、云同步、在线 Web 服务、做题判分、AI 解析生成、社交分享、支付、小程序。

### 2.3 文档索引

| 文档 | 内容 |
|---|---|
| `docs/A1-项目定义卡.md` | 定位、用户、闭环、范围、风险 |
| `docs/A2-PRD.md` | 功能规格、页面、交互、验收标准 |
| `docs/C1-技术方案总览.md` | 技术栈、架构、模块、数据流、部署 |
| `docs/C2-数据模型设计.md` | 表结构、字段、索引、迁移、种子 |
| `docs/C3-Command接口清单.md` | 命令签名、入参、返回、错误码 |
| `docs/C4-导入模块设计规格.md` | 清洗、切句、分词、校验、事务 |
| `docs/C5-自动更新与发布方案.md` | updater、Actions、签名、验证 |

---

## 3. 技术栈（锁定，不要替换）

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面容器 | Tauri v2 | 不用 Electron |
| 移动端 | Tauri v2 Android | 与桌面共用 Rust 核心和前端代码 |
| 前端 | **React 18 + TypeScript 5 + Vite** | **不用 Taro、不用 uni-app**；小程序路线已放弃 |
| 状态 | Zustand（全局 UI）+ TanStack Query（持久化状态） | 组件内临时状态用 useState |
| 后端 | Rust + rusqlite | **不用 ORM，不用 sqlx，不用 diesel** |
| 数据库 | SQLite（单文件，`app_data_dir/app.db`） | 开启 `PRAGMA foreign_keys = ON` |
| 构建/发布 | GitHub Actions + GitHub Releases + tauri-action | 公开仓库免费 |
| 自动更新 | Tauri updater（桌面）；`tauri-plugin-android-update`（Android） | 签名密钥必须配置 |

**版本锁定**：Tauri v2、rusqlite 0.3x、React 18+、TypeScript 5+。升级主版本前先评估并记录到 `docs/F3-决策记录.md`。

---

## 4. 架构原则（违反即返工）

1. **前端不碰 SQL**。所有数据库读写通过 Tauri command。
2. **前端不拼 `invoke` 字符串**。统一走 `src/lib/api.ts` 封装。
3. **内置内容与用户内容分离**。`article.visibility = 'system' | 'user'`。
4. **偏移量一律 UTF-16 code unit**。Rust 用 `encode_utf16().count()`，不用 `len()` 或 `chars().count()`。
5. **写操作必须用事务**。批量插入用事务内 prepare。
6. **校验在事务外完成**。校验失败不产生任何数据库操作。
7. **表结构变更走 migration 文件**。不直接改已发布的 `001_init.sql`。
8. **command 返回 `Result<T, CommandError>`**，错误结构化，不返回裸字符串。
9. **内置文章种子幂等**。用 `source_key` 识别，已存在则跳过，不覆盖用户笔记。
10. **系统文章禁止删除**。用户文章删除走 `ON DELETE CASCADE`。

---

## 5. 数据层约束

详细表结构见 `docs/C2-数据模型设计.md`。本节只列硬约束。

### 5.1 连接管理

- 连接放 `State<Mutex<Connection>>`，command 里 `state.lock()` 取锁。
- 数据库路径：`app_handle.path().app_data_dir().join("app.db")`。
- 启动时执行 migration：`PRAGMA foreign_keys = ON;` + `CREATE TABLE IF NOT EXISTS ...`。
- **不要开连接池**。单连接 + Mutex 足够，SQLite 桌面单用户场景不需要池。

### 5.2 Schema 规则

- 主键统一 `INTEGER PRIMARY KEY AUTOINCREMENT`。
- 外键统一 `ON DELETE CASCADE`（用户数据）或 `ON DELETE SET NULL`（引用关系）。
- 时间字段用 `TEXT`，存 `datetime('now')` 格式。
- JSON 字段（如 `options_json`、`app_setting.value`）存 TEXT，Rust 侧用 `serde_json` 序列化。
- 表结构变更：新增 `migrations/00N_xxx.sql`，并在 `schema_meta` 记录版本。

### 5.3 生词聚合

- 生词按 `token.normalized`（小写、去首尾非字母数字、保留撇号和连字符）聚合。
- `lemma` 字段 MVP 留空，不做词形还原。
- `vocab_entry.normalized` 唯一。`add_vocab_from_token` 已存在则更新来源和释义，不重复插入。

---

## 6. 导入层约束

详细规格见 `docs/C4-导入模块设计规格.md`。本节只列最关键的硬约束。

### 6.1 两阶段

- **`parse_import_preview(text)`**：清洗 → 分段 → 段内切句 → 句内分词，返回预览。**不写数据库。**
- **`commit_import(payload)`**：校验前端确认后的结构，原子入库。**不重新切句、不重新分词。**

### 6.2 偏移口径（最容易出错）

- 所有 `start_offset` / `end_offset` 是 **UTF-16 code unit** 计数。
- 句子偏移相对段落文本，token 偏移相对句子文本。
- Rust 侧切片必须用辅助函数 `utf16_slice(text, start, end)`，把 UTF-16 偏移转成字节偏移后切片。**禁止 `&text[a..b]` 直接切。**
- `utf16_slice` 必须有单元测试，覆盖 ASCII、中文、emoji、代理对、边界值。

### 6.3 commit 校验四层

1. **L1 结构**：title 非空、paragraphs 非空、三层 idx 从 0 连续、`start < end`、强制 `visibility='user'`。
2. **L2 偏移**：`end_offset <= 父文本 UTF-16 长度`；同层按 start 排序后不重叠。
3. **L3 覆盖**：句子 gap 只允许空白；token gap 只允许空白或标点；`surface` 必须等于 `utf16_slice(text, start, end)`。
4. **L4 业务**：difficulty 归一、exam_year 范围、`word_count` 由后端统计 `is_word=true` 的 token 数。

校验全部在事务外完成。错误返回 `CommandError { code, message, path }`，`path` 格式 `paragraphs[i].sentences[j].tokens[k]`。

### 6.4 事务入库

- `conn.transaction()` 开事务，按 article → paragraph → sentence → token 顺序插入。
- token 插入用循环外 prepare 的 statement，`stmt` 在 `tx.commit()` 前 `drop`。
- `source_key` 用 `uuid::Uuid::new_v4()` 生成 `user-{uuid}`。
- `text_hash` 用 SHA-256 前 16 位十六进制。
- 任何 `?` 提前返回，事务自动 rollback。
- **MVP 不做导入去重**，重复导入生成新 article。

---

## 7. 接口层约束

详细签名与错误码见 `docs/C3-Command接口清单.md`。本节只列通用规则。

### 7.1 命名与返回

- 函数名 snake_case，前端封装名 camelCase。
- 返回 `Result<T, CommandError>`，`CommandError` 实现 `Serialize`。
- 参数与返回字段用 `#[serde(rename_all = "camelCase")]`，**全项目统一 camelCase 边界**，不混用。

### 7.2 错误结构

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}
```

`db_error` 的 `message` 不带 SQL 细节，只给用户可读提示。

### 7.3 分页约定

需要分页的列表统一使用 `PageQuery { page, pageSize }`，返回
`Page<T> { items, total, page, pageSize }`。不要返回裸数组。

### 7.4 调用约束

- 前端不直接 `invoke` 字符串，统一走 `src/lib/api.ts`。
- 写操作由前端防抖或显式触发，不自动轮询。
- 同一写操作在 loading 期间禁用按钮，防止重复提交。

------------------------------------------------------------------------

## 8. 前端约束

### 8.1 状态分层

- `useState`：组件内临时状态（输入框、面板开关）。
- `Zustand`：全局 UI 状态（当前文章、面板状态、主题）。
- `TanStack Query`：所有持久化状态（文章列表、笔记、生词、复习计划）。**不要用
  useState 缓存数据库数据。**

### 8.2 API 封装

- 所有 `invoke` 走 `src/lib/api.ts`。
- 类型定义放 `src/lib/types.ts`，与 Rust 返回结构一一对应。
- 组件里不出现 `invoke("...")` 字符串字面量。

### 8.3 笔记自动保存

- 前端防抖 500--800ms 调用 `upsert_*`。
- 本地草稿兜底：输入时先写 `localStorage`，保存成功后清除。
- 保存失败不丢输入，展示"保存失败，重试"按钮。

### 8.4 精读页交互

- 默认展示原文，题目区可折叠，答案折叠，选项不可选。
- 点句子：底部面板显示用户句译/语法/短语笔记，可编辑。
- 点单词：底部面板显示用户释义/搭配/例句，可"加入生词本"。
- 有笔记的句子/单词轻高亮。
- 复习模式：顶部显示"复习中"，高亮本篇笔记过的句子和单词，底部"已复习 /
  还需再看"。

------------------------------------------------------------------------

## 9. 测试要求

详细用例见 `docs/C4-导入模块设计规格.md` 第 12 节和
`docs/D3-测试计划.md`。本节只列必须有的测试。

### 9.1 必须有的单元测试

  ----------------------------------------------------------------------------------------------------------------------
  范围                                必测内容
  ----------------------------------- ----------------------------------------------------------------------------------
  `utf16_slice`                       ASCII、中文、emoji、代理对、边界值、非法区间

  解析                                缩写不切、小数不切、引号闭合后切、省略号后小写不切、无空行、全角标点、中文/emoji
                                      偏移

  提交                                正常导入、空段落、idx 不连续、偏移越界/重叠、覆盖校验、surface
                                      不匹配、事务回滚、重复导入

  数据层                              表约束、级联删除、种子幂等
  ----------------------------------------------------------------------------------------------------------------------

### 9.2 测试原则

- 数据层测试用 `Connection::open_in_memory()` + 执行 `001_init.sql`。
- 不 mock 数据库，用真实 SQLite 内存库。
- 每次测试独立建库，不共享状态。
- CI 里 `cargo test` + `npm test` 必须全绿才能合并。

------------------------------------------------------------------------

## 10. 发布约束

详细配置见 `docs/C5-自动更新与发布方案.md`。本节只列红线。

### 10.1 桌面端更新

- `tauri.conf.json`：`bundle.createUpdaterArtifacts = true`，`plugins.updater.endpoints`
  指向
  `https://github.com/{owner}/{repo}/releases/latest/download/latest.json`，`pubkey`
  填公钥，Windows `installMode: "passive"`。
- `capabilities/default.json` 加 `"updater:default"`。
- GitHub
  Secrets：`TAURI_SIGNING_PRIVATE_KEY`（必填），`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（可选）。
- GitHub
  Actions：`tauri-apps/tauri-action@v0`，`includeUpdaterJson: true`，三平台矩阵构建。

### 10.2 Android 更新

- **不走静默更新**：Tauri updater 不支持 Android。
- 用 `tauri-plugin-android-update`，检查版本后引导用户到 Release 下载
  APK。
- `capabilities` 加 `"android-update:default"`。
- Android APK 签名使用独立的 keystore，与桌面 updater 密钥分开管理。

### 10.3 密钥与验证

- **私钥丢失 = 永久无法向已安装用户推送更新。** 离线备份，不提交仓库。
- **首次发布必须实际验证**：装 v1.0.0 → 发 v1.0.1 →
  旧版本能检测并更新。桌面和 Android 分别验证。
- **发布前版本号三处一致**：`tauri.conf.json`、`Cargo.toml`、Git Tag。

------------------------------------------------------------------------

## 11. 禁止事项（红线）

1.  **禁止前端直接写 SQL 或拼 `invoke` 字符串。**
2.  **禁止用字节偏移或 `chars().count()` 代替 UTF-16 偏移。**
3.  **禁止在 command 里重新切句或分词。** commit 只校验和入库。
4.  **禁止在事务外做写操作，或忘记 `tx.commit()`。**
5.  **禁止 `stmt` 未 drop 就 commit。**
6.  **禁止修改已发布的 migration 文件。** 新增 migration。
7.  **禁止引入 ORM、连接池、NLP
    crate、服务端框架**（除非明确评估并记录理由）。
8.  **禁止用 `useState` 缓存数据库数据。** 持久化状态走 TanStack Query。
9.  **禁止在 `db_error` 里暴露 SQL 细节给用户。**
10. **禁止跳过首次自动更新的实际验证就宣布链路完成。**
11. **禁止引入 Taro、uni-app、Electron 或任何小程序框架。**
    技术栈已锁定。
12. **禁止删除 Release 或手改 `latest.json` 来回滚**。发更高版本修复。

------------------------------------------------------------------------

## 12. Vibe Coding 提示词模板

每次让 AI 实现功能时，附带以下前缀：

> 先读 `AGENTS.md` 和对应 `docs/` 规格。本次任务：{任务描述}。
> 约束：React + Vite + TypeScript；Rust + rusqlite 不用 ORM；连接从
> `State<Mutex<Connection>>` 取；写操作走事务；偏移量 UTF-16；前端不碰
> SQL；返回 `Result<T, CommandError>`；错误带
> `code/message/path`；为新增逻辑补单元测试。 不要修改
> schema、不要重新切句、不要引入新依赖（如需，先说明理由）。

### 12.1 典型任务提示词

  ---------------------------------------------------------------------------------
  任务                                提示词要点
  ----------------------------------- ---------------------------------------------
  前端 API 封装                       实现 `src/lib/api.ts` 中
                                      `listArticles`、`getArticleContent`，类型从
                                      `types.ts` 导入，不内联类型

  解析实现                            实现 `parse_import_preview`，严格遵守 C4 第
                                      4---7 节，偏移量 UTF-16，不引入 NLP crate

  提交实现                            实现 `commit_import`，先做 L1---L4
                                      校验，事务内按 article → paragraph → sentence
                                      → token 插入，`stmt` 在 commit 前 drop

  切片测试                            为 `utf16_slice` 写单元测试，覆盖 C4 第 12.3
                                      节用例

  表结构                              只新增 migration，不改
                                      `001_init.sql`，字段类型和约束与 C2 一致
  ---------------------------------------------------------------------------------

------------------------------------------------------------------------

## 13. 当前实施顺序

  ---------------------------------------------------------------------------------
  步骤                    交付物                   验收标准
  ----------------------- ------------------------ --------------------------------
  1                       migration + 种子导入 +   文章能展示
                          `list_articles` /        
                          `get_article_content`    

  2                       `upsert_sentence_note` / 精读闭环可写、可回显、重启不丢
                          `upsert_word_note`       

  3                       `add_vocab_from_token` / 生词本可增删改查
                          `list_vocab`             

  4                       `get_due_reviews` /      复习提醒与推进可用
                          `complete_review`        

  5                       `parse_import_preview` / 导入预览与入库可用
                          `commit_import`          

  6                       `export_vocab_html`      导出打印文件可用

  7                       自动更新链路验证 +       桌面与 Android 分别验证通过
                          首次发布                 
  ---------------------------------------------------------------------------------

**每步完成必须有可验证页面 + 单元测试，不跳步。**

------------------------------------------------------------------------

## 14. 与其它文档的关系

  文档   关系
  ------ -------------------------------------------------
  `A1`   定义做什么、不做什么；本文件不重复范围决策
  `A2`   定义功能规则与验收；本文件第 8 节引用其交互规则
  `C1`   定义技术栈与架构；本文件第 3、4 节是其执行版本
  `C2`   定义表结构；本文件第 5 节是其硬约束摘录
  `C3`   定义接口契约；本文件第 7 节是其通用规则摘录
  `C4`   定义导入规格；本文件第 6 节是其硬约束摘录
  `C5`   定义发布方案；本文件第 10 节是其红线摘录
  `F3`   记录关键取舍；本文件的约束变更需在此留痕

------------------------------------------------------------------------

*本文件是约束入口，不重复 `docs/`
的完整规格。新增硬约束或修改红线时，同步更新本文件和对应 `docs/`
文档，并在 `docs/F3-决策记录.md` 中留痕。* \`\`\`

------------------------------------------------------------------------
