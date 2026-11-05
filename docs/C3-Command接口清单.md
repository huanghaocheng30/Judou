# C3 Command 接口清单

> 版本：v1.0  
> 状态：定稿  
> 上游文档：`docs/C1-技术方案总览.md`、`docs/C2-数据模型设计.md`  
> 下游文档：`docs/C4-导入模块设计规格.md`、`AGENTS.md`、`src/lib/api.ts`  
> 本文档定义所有 Tauri command 的签名、入参、返回、错误码与调用场景。前后端契约以本文档为准。

---

## 1. 文档说明

### 1.1 目的

回答三个问题：

1. **有哪些命令**：模块、命令名、用途。
2. **怎么调**：入参结构、返回结构、错误码。
3. **在哪调**：页面或流程中的调用时机。

### 1.2 范围

覆盖 MVP 全部前后端交互。不包含种子导入的内部调用（由 Rust 启动流程直接执行，不经前端）。

### 1.3 读者

- 前端开发：实现 `src/lib/api.ts`。
- Rust 开发：实现 command 与领域模块。
- AI 编码代理：生成 command 或前端调用时的契约来源。

---

## 2. 通用约定

### 2.1 命名

| 侧 | 风格 | 示例 |
|---|---|---|
| Rust command 函数名 | snake_case | `list_articles` |
| 前端封装方法名 | camelCase | `listArticles` |
| 参数与返回字段 | 边界统一 camelCase | `articleId`、`startOffset` |
| 错误码 | snake_case 字符串 | `article_not_found` |

**实现方式**：Rust 结构体加 `#[serde(rename_all = "camelCase")]`，command 参数名在 `invoke` 时用 camelCase。**全项目统一，不混用。**

### 2.2 返回约定

- 所有 command 返回 `Result<T, CommandError>`。
- 成功返回业务数据，失败返回结构化错误。
- 列表接口统一返回 `{ items: T[], total: number }` 或分页结构，不返回裸数组（便于后续加分页）。
- 无返回值的写操作返回 `()` 或受影响的对象，不返回布尔值。

### 2.3 错误结构

```rust
#[derive(Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}
```

- `code`：稳定错误码，前端用于分支处理。
- `message`：用户可读提示，前端可直接展示。
- `path`：可选定位，如 `paragraphs[2].sentences[5].tokens[3]`，用于导入校验错误。

**`db_error` 的 `message` 不带 SQL 细节**，只给“保存失败，请重试”。

### 2.4 分页约定

需要分页的列表统一使用：

```rust
#[derive(Deserialize)]
pub struct PageQuery {
    pub page: Option<u32>,      // 从 1 开始，默认 1
    pub page_size: Option<u32>, // 默认 20，最大 100
}
```

返回：

```rust
#[derive(Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
}
```

MVP 只有 `list_vocab` 和 `get_reading_records` 使用分页；`list_articles` 文章量小，可先不分页，但返回 `Page<T>` 结构保持一致。

### 2.5 时间约定

- 时间字段统一 `TEXT`，格式 `YYYY-MM-DD HH:MM:SS`（SQLite `datetime('now')`）。
- 日期参数（如 `get_due_reviews`）用 `YYYY-MM-DD`。
- 前端负责格式化和时区展示，后端不处理时区。

### 2.6 调用约束

- 前端不直接 `invoke` 字符串，统一走 `src/lib/api.ts`。
- 写操作由前端防抖或显式触发，不自动轮询。
- 同一写操作在 loading 期间禁用按钮，防止重复提交。

---

## 3. 类型定义

### 3.1 Rust 侧公共类型

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSummary {
    pub id: i64,
    pub source_key: String,
    pub title: String,
    pub source: Option<String>,
    pub exam_year: Option<i32>,
    pub exam_set: Option<String>,
    pub section_type: Option<String>,
    pub difficulty: Option<String>,
    pub word_count: Option<i32>,
    pub visibility: String,
    pub status_tag: String,          // unread/reading/completed/review_due
    pub progress: f32,
    pub note_count: i32,
    pub vocab_count: i32,
    pub last_read_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleDetail {
    pub id: i64,
    pub title: String,
    pub source: Option<String>,
    pub exam_year: Option<i32>,
    pub exam_set: Option<String>,
    pub section_type: Option<String>,
    pub difficulty: Option<String>,
    pub word_count: Option<i32>,
    pub visibility: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleContent {
    pub article: ArticleDetail,
    pub paragraphs: Vec<ParagraphContent>,
    pub questions: Vec<QuestionContent>,
    pub reading_record: Option<ReadingRecord>,
    pub review_plan: Option<ReviewPlan>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphContent {
    pub id: i64,
    pub idx: i32,
    pub text: String,
    pub sentences: Vec<SentenceContent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceContent {
    pub id: i64,
    pub idx: i32,
    pub text: String,
    pub start_offset: i64,
    pub end_offset: i64,
    pub tokens: Vec<TokenContent>,
    pub has_note: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenContent {
    pub id: i64,
    pub idx: i32,
    pub surface: String,
    pub normalized: String,
    pub start_offset: i64,
    pub end_offset: i64,
    pub is_word: bool,
    pub in_vocab: bool,
    pub has_note: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionContent {
    pub id: i64,
    pub idx: i32,
    pub stem: String,
    pub options: Vec<String>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceNote {
    pub sentence_id: i64,
    pub translation: Option<String>,
    pub grammar_note: Option<String>,
    pub phrase_note: Option<String>,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordNote {
    pub token_id: i64,
    pub context_meaning: Option<String>,
    pub collocation: Option<String>,
    pub example: Option<String>,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabEntry {
    pub id: i64,
    pub normalized: String,
    pub surface: String,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub context_meaning: Option<String>,
    pub source_sentence_id: Option<i64>,
    pub source_article_id: Option<i64>,
    pub source_article_title: Option<String>,
    pub source_sentence_text: Option<String>,
    pub mastery: String,
    pub review_count: i32,
    pub last_reviewed_at: Option<String>,
    pub tags: Vec<Tag>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlan {
    pub article_id: i64,
    pub next_review_at: String,
    pub interval_index: i32,
    pub status: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDueItem {
    pub article_id: i64,
    pub title: String,
    pub next_review_at: String,
    pub interval_index: i32,
    pub note_count: i32,
    pub last_reviewed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLog {
    pub id: i64,
    pub article_id: i64,
    pub article_title: String,
    pub reviewed_at: String,
    pub result: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingRecord {
    pub article_id: i64,
    pub article_title: String,
    pub progress: f32,
    pub last_read_at: Option<String>,
    pub completed_at: Option<String>,
    pub note_count: i32,
    pub review_count: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub articles_total: i32,
    pub articles_reading: i32,
    pub articles_completed: i32,
    pub review_due: i32,
    pub note_count: i32,
    pub vocab_total: i32,
    pub vocab_known: i32,
    pub vocab_new: i32,
    pub review_count: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub file_path: String,
    pub item_count: i32,
}
```

### 3.2 TypeScript 侧对应

```ts
export interface ArticleSummary {
  id: number;
  sourceKey: string;
  title: string;
  source: string | null;
  examYear: number | null;
  examSet: string | null;
  sectionType: string | null;
  difficulty: string | null;
  wordCount: number | null;
  visibility: "system" | "user";
  statusTag: "unread" | "reading" | "completed" | "review_due";
  progress: number;
  noteCount: number;
  vocabCount: number;
  lastReadAt: string | null;
}

export interface ArticleContent {
  article: ArticleDetail;
  paragraphs: ParagraphContent[];
  questions: QuestionContent[];
  readingRecord: ReadingRecord | null;
  reviewPlan: ReviewPlan | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
```

**完整类型定义以 `src/lib/types.ts` 为准**，与本文档第 3.1 节字段一一对应。

---

## 4. 命令清单总表

| 模块 | 命令 | 用途 | 读写 |
|---|---|---|---|
| 文章 | `list_articles` | 文章列表（筛选/搜索/分页） | 读 |
| 文章 | `get_article` | 文章元信息 | 读 |
| 文章 | `get_article_content` | 精读页完整数据 | 读 |
| 文章 | `delete_user_article` | 删除用户文章 | 写 |
| 文章 | `update_reading_progress` | 更新阅读进度 | 写 |
| 导入 | `parse_import_preview` | 解析预览，不写库 | 只读 |
| 导入 | `commit_import` | 确认导入，事务写库 | 写 |
| 笔记 | `get_sentence_note` | 读句笔记 | 读 |
| 笔记 | `upsert_sentence_note` | 写句笔记 | 写 |
| 笔记 | `get_word_note` | 读词笔记 | 读 |
| 笔记 | `upsert_word_note` | 写词笔记 | 写 |
| 生词 | `add_vocab_from_token` | 从 token 加入生词本 | 写 |
| 生词 | `list_vocab` | 生词列表（筛选/分页） | 读 |
| 生词 | `update_vocab` | 编辑生词 | 写 |
| 生词 | `delete_vocab` | 删除生词 | 写 |
| 标签 | `list_tags` | 标签列表 | 读 |
| 标签 | `upsert_tag` | 新建/更新标签 | 写 |
| 标签 | `delete_tag` | 删除标签 | 写 |
| 标签 | `set_vocab_tags` | 设置生词标签 | 写 |
| 复习 | `get_due_reviews` | 今日待复习 | 读 |
| 复习 | `upsert_review_plan` | 设置/调整复习计划 | 写 |
| 复习 | `complete_review` | 完成一次复习 | 写 |
| 复习 | `pause_review` | 暂停/恢复计划 | 写 |
| 记录 | `get_reading_records` | 阅读记录列表 | 读 |
| 记录 | `get_review_logs` | 复习历史 | 读 |
| 记录 | `get_stats` | 统计概览 | 读 |
| 设置 | `get_settings` | 读设置 | 读 |
| 设置 | `set_setting` | 写设置 | 写 |
| 导出 | `export_vocab_html` | 导出生词打印文件 | 写 |
| 更新 | `check_update` | 手动检查更新 | 写 |

---

## 5. 各模块详细规格

### 5.1 文章模块

#### `list_articles`

**用途**：文章库列表，支持内置/我的导入分 Tab、筛选、搜索。

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleFilter {
    pub visibility: String,              // "system" | "user"
    pub exam_year: Option<i32>,
    pub exam_set: Option<String>,
    pub section_type: Option<String>,
    pub difficulty: Option<String>,
    pub status_tag: Option<String>,      // unread/reading/completed/review_due
    pub keyword: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}
```

**返回**：`Page<ArticleSummary>`

**错误码**：`db_error`

**调用场景**：文章库页加载、筛选变化、搜索输入（防抖 300ms）。

**备注**：
- `visibility` 必填，由前端 Tab 决定。
- `keyword` 按标题模糊匹配。
- `status_tag` 由 `reading_record` 和 `review_plan` 推导，不单独存表。
- 排序：系统文章按 `exam_year` 倒序、`exam_set`、`section_type`；用户文章按 `created_at` 倒序。

---

#### `get_article`

**用途**：获取文章元信息，用于精读页顶部或分享。

**入参**：`article_id: i64`

**返回**：`ArticleDetail`

**错误码**：`article_not_found`、`db_error`

---

#### `get_article_content`

**用途**：精读页一次性拉取文章结构、句子、token、题目、阅读记录、复习计划。

**入参**：`article_id: i64`

**返回**：`ArticleContent`

**错误码**：`article_not_found`、`db_error`

**备注**：
- 一次返回整篇，避免前端逐段请求。
- `sentence.has_note`、`token.in_vocab`、`token.has_note` 由后端 join 计算，前端不额外请求。
- 题目的 `options` 由 `options_json` 解析为数组。
- 若文章有复习计划且 `next_review_at <= today`，前端进入时可提示“该篇待复习”。

---

#### `delete_user_article`

**用途**：删除用户导入的文章。

**入参**：`article_id: i64`

**返回**：`()`

**错误码**：`article_not_found`、`system_article_protected`、`db_error`

**备注**：
- 只允许删除 `visibility='user'` 的文章。
- 删除走 `ON DELETE CASCADE`，关联段落、句子、token、笔记、复习计划、复习日志、阅读记录一并删除。
- 生词的 `source_article_id`、`source_sentence_id` 置 NULL，生词保留。
- 删除前前端二次确认。

---

#### `update_reading_progress`

**用途**：更新阅读进度和最后阅读时间。

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgressInput {
    pub article_id: i64,
    pub progress: f32,          // 0~1
    pub completed: bool,        // 是否点击“完成精读”
}
```

**返回**：`ReadingRecord`

**错误码**：`article_not_found`、`db_error`

**备注**：
- 前端在滚动或点击句子后防抖 2s 调用，不频繁写。
- `completed=true` 时写 `completed_at`，若该文章无 `review_plan`，在同一事务内生成默认计划（1/3/7/14 天）。
- `progress` 夹紧到 `[0, 1]`。

---

### 5.2 导入模块

#### `parse_import_preview`

**用途**：解析用户粘贴/上传的文本，返回预览，不写库。

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseImportInput {
    pub text: String,
}
```

**返回**：`ImportPreview`（结构见 C4）

**错误码**：`empty_article`、`text_too_long`、`parse_error`

**备注**：
- 同步执行，单篇文本几 KB 到几十 KB，无需异步。
- 文本超过 100KB 返回 `text_too_long`，提示拆分。
- 预览只读，用户确认后调 `commit_import`。

---

#### `commit_import`

**用途**：校验并事务写入用户确认后的导入结构。

**入参**：`ImportCommitPayload`（结构见 C4）

**返回**：`i64`（新文章 ID）

**错误码**：`empty_article`、`missing_title`、`paragraph_index_invalid`、`sentence_index_invalid`、`token_index_invalid`、`offset_out_of_range`、`offset_order_invalid`、`sentence_coverage_invalid`、`token_coverage_invalid`、`text_mismatch`、`db_error`

**备注**：
- 校验 L1—L4 在事务外完成，失败不产生数据库操作。
- 事务写入 article → paragraph → sentence → token。
- `visibility` 强制 `user`，`source_key` 用 UUID。
- 详细规则见 `docs/C4-导入模块设计规格.md`。

---

### 5.3 笔记模块

#### `get_sentence_note`

**入参**：`sentence_id: i64`

**返回**：`Option<SentenceNote>`

**错误码**：`db_error`

**备注**：无笔记返回 `null`，前端展示空面板。

---

#### `upsert_sentence_note`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceNoteInput {
    pub sentence_id: i64,
    pub translation: Option<String>,
    pub grammar_note: Option<String>,
    pub phrase_note: Option<String>,
}
```

**返回**：`SentenceNote`

**错误码**：`sentence_not_found`、`db_error`

**备注**：
- 同一 `sentence_id` 存在则更新，不存在则插入。
- 三个字段都是自由文本，不做格式校验；空字符串按 `NULL` 处理。
- 前端防抖 500—800ms 调用。

---

#### `get_word_note`

**入参**：`token_id: i64`

**返回**：`Option<WordNote>`

**错误码**：`db_error`

---

#### `upsert_word_note`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordNoteInput {
    pub token_id: i64,
    pub context_meaning: Option<String>,
    pub collocation: Option<String>,
    pub example: Option<String>,
}
```

**返回**：`WordNote`

**错误码**：`token_not_found`、`db_error`

**备注**：词笔记绑定具体 token，不是 `normalized`。同一单词在不同句子的笔记独立。

---

### 5.4 生词模块

#### `add_vocab_from_token`

**用途**：从当前 token 加入生词本，按 `normalized` 聚合。

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddVocabInput {
    pub token_id: i64,
    pub context_meaning: Option<String>,
}
```

**返回**：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddVocabResult {
    pub entry: VocabEntry,
    pub created: bool,          // true=新建，false=已存在并更新来源
}
```

**错误码**：`token_not_found`、`db_error`

**备注**：
- 按 `token.normalized` 查 `vocab_entry`。
- 已存在：更新 `source_sentence_id`、`source_article_id`、`context_meaning`（若传入）、`updated_at`，`created=false`。
- 不存在：插入新条目，`mastery='new'`，`created=true`。
- 前端根据 `created` 提示“已加入生词本”或“已在生词本”。

---

#### `list_vocab`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFilter {
    pub mastery: Option<String>,        // new/fuzzy/known
    pub source_article_id: Option<i64>,
    pub tag_id: Option<i64>,
    pub keyword: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}
```

**返回**：`Page<VocabEntry>`

**错误码**：`db_error`

**备注**：
- 默认按 `created_at` 倒序。
- 返回时 join `tag` 表填充 `tags`，join `article/sentence` 填充来源标题和原句。
- 来源已删除时 `source_article_title`、`source_sentence_text` 为 `null`。

---

#### `update_vocab`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabUpdateInput {
    pub vocab_id: i64,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub context_meaning: Option<String>,
    pub mastery: Option<String>,        // new/fuzzy/known
}
```

**返回**：`VocabEntry`

**错误码**：`vocab_not_found`、`invalid_mastery`、`db_error`

**备注**：只更新传入的非 `None` 字段；`mastery` 非法值返回 `invalid_mastery`。

---

#### `delete_vocab`

**入参**：`vocab_id: i64`

**返回**：`()`

**错误码**：`vocab_not_found`、`db_error`

**备注**：删除生词，`vocab_tag` CASCADE。词笔记保留。

---

### 5.5 标签模块

#### `list_tags`

**返回**：`Vec<Tag>`

**错误码**：`db_error`

---

#### `upsert_tag`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub name: String,
    pub color: Option<String>,
}
```

**返回**：`Tag`

**错误码**：`empty_tag_name`、`duplicate_tag_name`、`db_error`

**备注**：按 `name` 唯一；已存在则返回已有标签，不报错（前端可据此提示“标签已存在”）。`name` trim 后为空返回 `empty_tag_name`。

---

#### `delete_tag`

**入参**：`tag_id: i64`

**返回**：`()`

**错误码**：`tag_not_found`、`db_error`

**备注**：删除标签，`vocab_tag` CASCADE。

---

#### `set_vocab_tags`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVocabTagsInput {
    pub vocab_id: i64,
    pub tag_ids: Vec<i64>,
}
```

**返回**：`Vec<Tag>`（更新后的标签列表）

**错误码**：`vocab_not_found`、`tag_not_found`、`db_error`

**备注**：先删后插，事务内完成。`tag_ids` 去重。

---

### 5.6 复习模块

#### `get_due_reviews`

**入参**：`date: String`（`YYYY-MM-DD`）

**返回**：`Vec<ReviewDueItem>`

**错误码**：`db_error`

**备注**：
- 查询 `review_plan` 中 `status='active'` 且 `next_review_at <= date` 的记录。
- join `article` 取标题，join 统计取笔记数、上次复习时间。
- 按 `next_review_at` 升序。

---

#### `upsert_review_plan`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlanInput {
    pub article_id: i64,
    pub next_review_at: String,
    pub interval_index: i32,
}
```

**返回**：`ReviewPlan`

**错误码**：`article_not_found`、`invalid_interval`、`db_error`

**备注**：
- 存在则更新，不存在则插入。
- `interval_index` 范围 0—3，超出返回 `invalid_interval`。
- 主要用于设置页调整单篇计划（P1）。

---

#### `complete_review`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteReviewInput {
    pub article_id: i64,
    pub result: String,         // "done" | "need_more"
}
```

**返回**：`ReviewPlan`

**错误码**：`article_not_found`、`review_plan_not_found`、`invalid_result`、`db_error`

**备注**：
- 事务内：写 `review_log`；更新 `review_plan`。
- `result="done"`：`interval_index += 1`；若超过 3，`status='done'`；否则 `next_review_at = today + intervals[interval_index]`。
- `result="need_more"`：`interval_index` 不变，`next_review_at = today + 1`。
- `intervals` 从 `app_setting.review_intervals` 读，默认 `[1,3,7,14]`。

---

#### `pause_review`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseReviewInput {
    pub article_id: i64,
    pub paused: bool,
}
```

**返回**：`ReviewPlan`

**错误码**：`article_not_found`、`review_plan_not_found`、`db_error`

**备注**：`paused=true` 设 `status='paused'`，`false` 恢复 `active`。`done` 状态不可暂停。

---

### 5.7 记录模块

#### `get_reading_records`

**入参**：`PageQuery`

**返回**：`Page<ReadingRecord>`

**错误码**：`db_error`

**备注**：按 `last_read_at` 倒序；join `article` 取标题，统计笔记数和复习次数。

---

#### `get_review_logs`

**入参**：`PageQuery`

**返回**：`Page<ReviewLog>`

**错误码**：`db_error`

**备注**：按 `reviewed_at` 倒序。

---

#### `get_stats`

**返回**：`Stats`

**错误码**：`db_error`

**备注**：单次查询聚合，避免前端多次请求。`review_due` 按当天日期计算。

---

### 5.8 设置模块

#### `get_settings`

**返回**：`HashMap<String, String>`

**错误码**：`db_error`

**备注**：返回 `app_setting` 全部键值；前端按已知键解析，未知键忽略。

---

#### `set_setting`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingInput {
    pub key: String,
    pub value: String,
}
```

**返回**：`()`

**错误码**：`invalid_setting_key`、`db_error`

**备注**：只允许已知键：`review_intervals`、`guide_shown`、`theme`。`review_intervals` 必须是合法 JSON 数组且长度 4、元素为正整数。

---

### 5.9 导出模块

#### `export_vocab_html`

**入参**：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportVocabInput {
    pub scope: String,                  // all/filtered/article/tag/unmastered
    pub article_id: Option<i64>,
    pub tag_id: Option<i64>,
    pub mastery: Option<String>,
    pub output_path: Option<String>,    // 不传则由后端选默认目录
}
```

**返回**：`ExportResult`

**错误码**：`empty_export`、`io_error`、`db_error`

**备注**：
- 生成打印友好 HTML，写入用户指定路径或应用数据目录下的 `exports/`。
- 返回文件路径，前端调用系统打开。
- 内容包含标题、导出时间、筛选条件、单词表（单词、音标、词性、语境释义、搭配、原句、来源）。
- 无数据返回 `empty_export`。

---

### 5.10 更新模块

#### `check_update`

**用途**：手动检查更新。

**入参**：无

**返回**：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub download_url: Option<String>,
}
```

**错误码**：`network_error`、`updater_error`

**备注**：
- 桌面端调用 Tauri updater 检查；Android 端由前端请求 GitHub Release API 或后端读取最新版本文件。
- 失败不阻塞使用，前端 toast 提示。
- 详细链路见 `docs/C5-自动更新与发布方案.md`。

---

## 6. 错误码总表

| code | 含义 | 前端处理 |
|---|---|---|
| `db_error` | 数据库操作失败 | 提示“保存失败，请重试”，不暴露细节 |
| `article_not_found` | 文章不存在 | 提示并返回列表 |
| `system_article_protected` | 系统文章不可删除 | 不展示删除入口，兜底提示 |
| `sentence_not_found` | 句子不存在 | 提示刷新页面 |
| `token_not_found` | token 不存在 | 提示刷新页面 |
| `vocab_not_found` | 生词不存在 | 提示并刷新列表 |
| `tag_not_found` | 标签不存在 | 提示并刷新 |
| `review_plan_not_found` | 复习计划不存在 | 提示并刷新 |
| `invalid_mastery` | 掌握状态非法 | 前端保证取值，兜底提示 |
| `invalid_interval` | 复习间隔序号非法 | 前端保证 0—3 |
| `invalid_result` | 复习结果非法 | 前端保证 done/need_more |
| `invalid_setting_key` | 设置键不允许 | 前端只传已知键 |
| `empty_tag_name` | 标签名为空 | 输入框校验 |
| `duplicate_tag_name` | 标签已存在 | 返回已有标签，前端提示 |
| `empty_article` | 导入内容为空 | 提示“正文不能为空” |
| `missing_title` | 导入标题为空 | 定位标题输入框 |
| `text_too_long` | 导入文本过长 | 提示拆分 |
| `parse_error` | 解析异常 | 提示“解析失败，请调整文本” |
| `paragraph_index_invalid` | 段落序号不连续 | 定位段落 |
| `sentence_index_invalid` | 句子序号不连续 | 定位句子 |
| `token_index_invalid` | token 序号不连续 | 定位 token |
| `offset_out_of_range` | 偏移越界 | 提示解析异常 |
| `offset_order_invalid` | 偏移重叠或乱序 | 提示解析异常 |
| `sentence_coverage_invalid` | 句子未覆盖段落 | 定位句子 |
| `token_coverage_invalid` | token 未覆盖句子 | 定位 token |
| `text_mismatch` | surface 与文本不一致 | 提示解析异常 |
| `empty_export` | 无可导出数据 | 提示“没有可导出的生词” |
| `io_error` | 文件写入失败 | 提示“导出失败，请检查路径权限” |
| `network_error` | 检查更新网络失败 | 提示“检查更新失败，请稍后重试” |
| `updater_error` | 更新器异常 | 提示手动到 Release 下载 |

---

## 7. 前端 API 封装示例

`src/lib/api.ts` 结构：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { ArticleFilter, ArticleSummary, ArticleContent, Page, /* ... */ } from "./types";

export const api = {
  // 文章
  listArticles: (filter: ArticleFilter) =>
    invoke<Page<ArticleSummary>>("list_articles", { filter }),
  getArticle: (articleId: number) =>
    invoke<ArticleDetail>("get_article", { articleId }),
  getArticleContent: (articleId: number) =>
    invoke<ArticleContent>("get_article_content", { articleId }),
  deleteUserArticle: (articleId: number) =>
    invoke<void>("delete_user_article", { articleId }),
  updateReadingProgress: (input: ReadingProgressInput) =>
    invoke<ReadingRecord>("update_reading_progress", { input }),

  // 导入
  parseImportPreview: (text: string) =>
    invoke<ImportPreview>("parse_import_preview", { text }),
  commitImport: (payload: ImportCommitPayload) =>
    invoke<number>("commit_import", { payload }),

  // 笔记
  getSentenceNote: (sentenceId: number) =>
    invoke<SentenceNote | null>("get_sentence_note", { sentenceId }),
  upsertSentenceNote: (input: SentenceNoteInput) =>
    invoke<SentenceNote>("upsert_sentence_note", { input }),
  getWordNote: (tokenId: number) =>
    invoke<WordNote | null>("get_word_note", { tokenId }),
  upsertWordNote: (input: WordNoteInput) =>
    invoke<WordNote>("upsert_word_note", { input }),

  // 生词、标签、复习、记录、设置、导出、更新略
};
```

**约束**：
- 所有方法名与第 4 节命令一一对应，参数用对象包裹，字段 camelCase。
- 组件里只调 `api.xxx`，不出现 `invoke("...")` 字符串。
- 返回类型从 `types.ts` 导入，不手写内联类型。

---

## 8. 与其它文档的关系

- **C1 第 4.2 节**：模块划分，本文件是其接口层具体化。
- **C2**：每个 command 操作的表与字段，本文件不重复表结构。
- **C4**：`parse_import_preview` 和 `commit_import` 的入参/返回结构与校验规则。
- **C5**：`check_update` 的更新链路细节。
- **AGENTS.md**：本文件的命名、错误结构、调用约束是硬性规则。
- **A2 PRD**：每个 command 对应页面与交互规则。

---

*本文档随接口演进更新。新增或修改 command 必须先改本文件，再改实现和前端封装。*
