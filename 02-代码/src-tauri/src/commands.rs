//! 命令层：M0 的 `ping` / `get_settings` / `set_setting`，
//! M1 追加 `list_articles` / `get_article_content` / `list_article_filter_options` /
//! `import_content_pack` / `get_startup_error`（共 8 个）。
//! 命令名与入参必须与契约逐字一致：`get_settings` 是**复数**且返回全量键值。

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::analysis;
use crate::db::Db;
use crate::import::{self, ImportReport};
use crate::import_user;
use crate::pack::{self, PackLabels, PackPath, StartupErrorInfo, StartupState};
use crate::review;
use crate::vocab;

/// 统一错误结构（docs D1 §7.2）：`code` / `message` / `path`，camelCase 边界。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl CommandError {
    /// 库读写错误：message 只给用户可读提示，**不带 SQL 细节**（docs D1 §11.9）；
    /// 细节打到 stderr 供开发期诊断（dev 日志可见，不进 IPC 返回）。
    pub fn db(context: &str, err: rusqlite::Error) -> Self {
        eprintln!("[judou][db] {context}: {err}");
        Self {
            code: "db_error".to_string(),
            message: format!("本地库{context}失败，请重试；若持续失败请备份后重启应用。"),
            path: None,
        }
    }

    /// 文件系统类错误（建目录/打开文件）：同样不在 message 里暴露绝对路径
    pub fn db_io(context: &str, detail: impl std::fmt::Display) -> Self {
        eprintln!("[judou][db] {context}: {detail}");
        Self {
            code: "db_error".to_string(),
            message: format!("本地库{context}失败，请检查磁盘权限或剩余空间后重启应用。"),
            path: None,
        }
    }

    pub fn db_busy() -> Self {
        Self {
            code: "db_error".to_string(),
            message: "本地库正忙，请重试。".to_string(),
            path: None,
        }
    }

    /// docs C3 §5.8：只允许已知键
    pub fn invalid_setting_key(key: &str) -> Self {
        Self {
            code: "invalid_setting_key".to_string(),
            message: format!("不支持的设置键：{key}"),
            path: None,
        }
    }

    /// 值非法。C3 §5.8 只登记了 `invalid_setting_key`（键级），
    /// 值级错误用更精确的独立码，避免把「值非法」误报成「键不支持」。
    pub fn invalid_setting_value(key: &str, reason: &str) -> Self {
        Self {
            code: "invalid_setting_value".to_string(),
            message: format!("设置项 {key} 的取值非法：{reason}"),
            path: None,
        }
    }

    /// 内容包类错误（手动导入时用；启动期不经过这里，直接走 `StartupState`）
    pub fn pack(err: pack::StartupError) -> Self {
        let info = err.info();
        Self {
            code: info.kind,
            message: info.message,
            path: info.file,
        }
    }

    /// 启动期错误信息 → 命令错误（只用于 `import_content_pack` 这类手动触发路径）
    pub fn startup(info: StartupErrorInfo) -> Self {
        Self {
            code: info.kind,
            message: info.message,
            path: info.file,
        }
    }

    /// 找不到篇目（列出/精读都用得上）：不回 SQL 细节
    pub fn article_not_found(article_id: i64) -> Self {
        Self {
            code: "article_not_found".to_string(),
            message: format!("找不到编号为 {article_id} 的文章。"),
            path: None,
        }
    }

    /// 不变量被破坏（本不该发生，例如「刚 `INSERT` 成功的行回读不到」）：
    /// 与 `db` 同样的对用户口径（重试/备份），细节仍只打 stderr。
    pub fn db_invariant(context: &str) -> Self {
        eprintln!("[judou][db] {context}: 不变量被破坏（写入后回读不到）");
        Self {
            code: "db_error".to_string(),
            message: format!("本地库{context}失败，请重试；若持续失败请备份后重启应用。"),
            path: None,
        }
    }

    /// 找不到词节点（M3 收藏：词卡持有的 tokenId 已随文章更新消失）
    pub fn token_not_found(token_id: i64) -> Self {
        Self {
            code: "token_not_found".to_string(),
            message: format!("找不到编号为 {token_id} 的词，可能所属文章已被替换，请重新打开该篇。"),
            path: None,
        }
    }

    /// 找不到生词条目（M3 编辑/改标签/删除：列表已过期或另一窗口已移出）
    pub fn vocab_not_found(vocab_id: i64) -> Self {
        Self {
            code: "vocab_not_found".to_string(),
            message: format!("生词本里已找不到编号为 {vocab_id} 的词，可能已被移出，请刷新后重试。"),
            path: None,
        }
    }

    /// 掌握状态非法（DB 还有 `CHECK` 兜底，这里先给可读提示：`new`/`fuzzy`/`known` 三档）
    pub fn invalid_mastery(value: &str) -> Self {
        Self {
            code: "invalid_mastery".to_string(),
            message: format!("掌握状态只能是 new、fuzzy、known 三档，收到「{value}」。"),
            path: None,
        }
    }

    /// 空补丁（四个可编辑字段一个都没给）：属于调用方 bug，不静默当成功
    pub fn invalid_vocab_patch() -> Self {
        Self {
            code: "invalid_vocab_patch".to_string(),
            message: "没有可更新的字段（只能改语境义/音标/词性/掌握状态）。".to_string(),
            path: None,
        }
    }

    /// 复习计划不存在（M4 `complete_review` 契约错误码 `REVIEW_PLAN_MISSING`，02 D0 逐字）
    ///
    /// ponytail: 这个码是**上游任务包写死的契约**（大写），与既有小写码风格不一致；
    /// 以后端契约为准，不改大小写——前端按 `code === "REVIEW_PLAN_MISSING"` 分支。
    pub fn review_plan_missing(article_id: i64) -> Self {
        Self {
            code: "REVIEW_PLAN_MISSING".to_string(),
            message: format!("这篇文章（编号 {article_id}）还没有复习计划，请先在精读页点「完成本篇」。"),
            path: None,
        }
    }

    /// 复习结果非法（只接受 `done` / `need_more`，与 DB CHECK 同口径，但先给可读提示）
    pub fn invalid_review_result(value: &str) -> Self {
        Self {
            code: "invalid_review_result".to_string(),
            message: format!("复习结果只能是 done（完成复习）或 need_more（还需再看），收到「{value}」。"),
            path: None,
        }
    }

    /// 日期非法（M4：`today` 必须由前端按本地日期 `YYYY-MM-DD` 传，02 D0 日期来源禁令）
    pub fn invalid_date(value: &str) -> Self {
        Self {
            code: "invalid_date".to_string(),
            message: format!("日期格式应为 YYYY-MM-DD（例如 2026-11-06），收到「{value}」。"),
            path: None,
        }
    }

    /// 命令错误 → 启动期错误信息（导入引擎内部只用这一种错误形态，避免两套错误在 lib.rs 里互相转）
    pub fn startup_info(&self) -> StartupErrorInfo {
        StartupErrorInfo::new(self.code.clone(), self.message.clone(), self.path.clone())
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// `ping` 返回体（前端 `PingResult`，camelCase）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub pong: bool,
    pub app_version: String,
}

/// 连通性探针：appVersion 来自 Cargo 包版本（AC3 断言 0.1.0）
#[tauri::command]
pub fn ping() -> PingResult {
    PingResult {
        pong: true,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// 读 app_setting 全量键值；前端自取 theme，未知键忽略（docs C3 §5.8）
#[tauri::command]
pub fn get_settings(db: State<'_, Db>) -> Result<HashMap<String, String>, CommandError> {
    db.settings()
}

/// 写单个设置键。只允许 docs C3 §5.8 的三个已知键。
#[tauri::command]
pub fn set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), CommandError> {
    validate_setting(&key, &value)?;
    db.set_setting(&key, &value)
}

/// 设置键/值校验（docs C3 §5.8）：已知键白名单 +
/// `review_intervals` 必须是长度 4 的正整数 JSON 数组 + `theme` 三档。
fn validate_setting(key: &str, value: &str) -> Result<(), CommandError> {
    match key {
        "theme" => {
            if matches!(value, "light" | "dark" | "system") {
                Ok(())
            } else {
                Err(CommandError::invalid_setting_value(key, "只接受 light / dark / system"))
            }
        }
        "guide_shown" => {
            if matches!(value, "0" | "1") {
                Ok(())
            } else {
                Err(CommandError::invalid_setting_value(key, "只接受 0 / 1"))
            }
        }
        "review_intervals" => {
            let parsed: Vec<i64> = serde_json::from_str(value)
                .map_err(|_| CommandError::invalid_setting_value(key, "必须是 JSON 整数数组，例如 [1,3,7,14]"))?;
            if parsed.len() == 4 && parsed.iter().all(|days| *days > 0) {
                Ok(())
            } else {
                Err(CommandError::invalid_setting_value(key, "必须是长度 4 的正整数数组"))
            }
        }
        other => Err(CommandError::invalid_setting_key(other)),
    }
}

// ─────────────────────────── M1 · 文章库与精读 ───────────────────────────

/// `list_articles` 的过滤条件：四类筛选为 **AND**、同组多选值为 **OR**（05 §三 / AC5）。
///
/// 入参用复数数组（`examTypes` / `years` / `sectionTypes` / `sources`）而不是单值：
/// 目录要求「多选值 OR」，单值字段无法表达。前端不传的组视为「不限」。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleFilter {
    pub visibility: Option<String>,
    #[serde(default)]
    pub exam_types: Vec<String>,
    #[serde(default)]
    pub years: Vec<i64>,
    #[serde(default)]
    pub section_types: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    pub keyword: Option<String>,
}

/// 文章库卡片的数据（D4 字段清单写死；`sectionLabel` 取 manifest 展示名）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSummary {
    /// D5 跳 `#/article/:id` 的唯一来源
    pub id: i64,
    pub source_key: String,
    pub title: String,
    pub exam_type: String,
    pub exam_year: Option<i64>,
    pub exam_set: Option<String>,
    pub section_type: Option<String>,
    pub section_label: Option<String>,
    pub word_count: Option<i64>,
    /// 取 `article.sentence_count` 冗余列（避免列表页 N+1 聚合）
    pub sentence_count: i64,
    pub source: Option<String>,
    /// 供两分组 Tab 回显（`system` / `user`）
    pub visibility: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptions {
    pub exam_types: Vec<String>,
    pub years: Vec<i64>,
    pub section_types: Vec<String>,
    /// `SELECT DISTINCT source FROM article`（B4：来源筛选的选项来源）
    pub sources: Vec<String>,
}

/// 精读页载荷
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleContent {
    pub article: ArticleDetail,
    pub paragraphs: Vec<ParagraphNode>,
    pub questions: Vec<QuestionNode>,
    /// M1 恒 `true`：内置 12 篇全有 `sentence_analysis`。
    /// ponytail: 分叉逻辑（用户导入篇无预置解析）属 M5，此处只留字段不实现——
    /// 等 M5 真的能导入无解析篇时，这里改成 `COUNT(sentence_analysis) > 0` 的一条查询即可。
    pub has_analysis: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleDetail {
    pub id: i64,
    pub title: String,
    pub source_key: String,
    pub exam_type: String,
    pub exam_year: Option<i64>,
    pub exam_set: Option<String>,
    pub section_type: Option<String>,
    pub section_label: Option<String>,
    pub passage_label: Option<String>,
    pub word_count: Option<i64>,
    pub sentence_count: i64,
    pub source: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphNode {
    pub idx: i64,
    pub text: String,
    pub sentences: Vec<SentenceNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceNode {
    /// **M2 新增**：`sentence.id`——查解析 / 存笔记的唯一句标识。
    /// M1 只下发 `idx`（篇内序号），但 `idx` 是**段内**序号、跨段会重复（实测篇 1 的 20 句只有 7 个不同 idx）。
    pub id: i64,
    pub idx: i64,
    /// 相对段落文本（ADR-008：UTF-16 code unit）
    pub start: i64,
    pub end: i64,
    pub text: String,
    pub tokens: Vec<TokenNode>,
    /// 该篇的 `blank_no` 升序数组（由后端按 `blank` 表给出，前端不猜）。
    /// 按篇广播到每句：渲染时只有句内 token 命中它才成为空格，未命中的句子不受影响。
    pub blank_nos: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenNode {
    pub id: i64,
    /// 相对句子文本
    pub start: i64,
    pub end: i64,
    pub surface: String,
    pub normalized: String,
    /// **空格判定的唯一判据**（前端写 `isWord === false`）
    pub is_word: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionNode {
    /// = 内容包 `questions[].no`（与 `blank_no` 同源）
    pub idx: i64,
    pub stem: String,
    pub options: Vec<QuestionOptionNode>,
    /// 答案随载荷下发（M2 判分要用），**M1 页面不渲染**（04 §6.7 选项不可点、不显示对错）
    pub answer: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOptionNode {
    pub key: String,
    pub text: String,
}

/// 文章库列表：四类筛选 AND、同组多选 OR、标题模糊搜索（`%`/`_` 转义）
#[tauri::command]
pub fn list_articles(
    db: State<'_, Db>,
    labels: State<'_, PackLabels>,
    filter: Option<ArticleFilter>,
) -> Result<Vec<ArticleSummary>, CommandError> {
    let filter = filter.unwrap_or_default();

    let mut sql = String::from(
        "SELECT a.id, a.source_key, a.title, a.exam_type, a.exam_year, a.exam_set, a.section_type,
                a.word_count, a.sentence_count, a.source, a.visibility
         FROM article a
         WHERE 1 = 1",
    );
    let mut args: Vec<Value> = Vec::new();

    if let Some(visibility) = filter.visibility.as_deref() {
        sql.push_str(" AND a.visibility = ?");
        args.push(Value::Text(visibility.to_string()));
    }
    if !filter.exam_types.is_empty() {
        push_in_clause(&mut sql, "a.exam_type", filter.exam_types.len());
        args.extend(filter.exam_types.into_iter().map(Value::Text));
    }
    if !filter.years.is_empty() {
        push_in_clause(&mut sql, "a.exam_year", filter.years.len());
        args.extend(filter.years.into_iter().map(Value::Integer));
    }
    if !filter.section_types.is_empty() {
        push_in_clause(&mut sql, "a.section_type", filter.section_types.len());
        args.extend(filter.section_types.into_iter().map(Value::Text));
    }
    if !filter.sources.is_empty() {
        push_in_clause(&mut sql, "a.source", filter.sources.len());
        args.extend(filter.sources.into_iter().map(Value::Text));
    }
    if let Some(keyword) = filter.keyword.as_deref() {
        let trimmed = keyword.trim();
        if !trimmed.is_empty() {
            sql.push_str(" AND a.title LIKE '%' || ? || '%' ESCAPE '\\'");
            args.push(Value::Text(escape_like(trimmed)));
        }
    }
    // `exam_set` 是 TEXT 列（R12）：不 CAST 会按字符串排，「10」排在「2」前面
    sql.push_str(" ORDER BY a.exam_year DESC, CAST(a.exam_set AS INTEGER), a.section_type, a.title");

    struct Row {
        id: i64,
        source_key: String,
        title: String,
        exam_type: String,
        exam_year: Option<i64>,
        exam_set: Option<String>,
        section_type: Option<String>,
        word_count: Option<i64>,
        sentence_count: i64,
        source: Option<String>,
        visibility: String,
    }

    let rows: Vec<Row> = db.read(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|err| CommandError::db("准备文章查询", err))?;
        let mapped = stmt
            .query_map(params_from_iter(args.iter()), |row| {
                Ok(Row {
                    id: row.get(0)?,
                    source_key: row.get(1)?,
                    title: row.get(2)?,
                    exam_type: row.get(3)?,
                    exam_year: row.get(4)?,
                    exam_set: row.get(5)?,
                    section_type: row.get(6)?,
                    word_count: row.get(7)?,
                    sentence_count: row.get(8)?,
                    source: row.get(9)?,
                    visibility: row.get(10)?,
                })
            })
            .map_err(|err| CommandError::db("查询文章", err))?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|err| CommandError::db("读取文章", err))?);
        }
        Ok(out)
    })?;

    Ok(rows
        .into_iter()
        .map(|row| ArticleSummary {
            section_label: labels.section_label(&row.source_key, row.section_type.as_deref()),
            id: row.id,
            source_key: row.source_key,
            title: row.title,
            exam_type: row.exam_type,
            exam_year: row.exam_year,
            exam_set: row.exam_set,
            section_type: row.section_type,
            word_count: row.word_count,
            sentence_count: row.sentence_count,
            source: row.source,
            visibility: row.visibility,
        })
        .collect())
}

/// 筛选器选项（来源 = `DISTINCT source`；年份降序，其余升序）
#[tauri::command]
pub fn list_article_filter_options(db: State<'_, Db>) -> Result<FilterOptions, CommandError> {
    db.read(|conn| {
        let distinct = |sql: &str| -> Result<Vec<String>, CommandError> {
            let mut stmt = conn.prepare(sql).map_err(|err| CommandError::db("准备筛选选项查询", err))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| CommandError::db("查询筛选选项", err))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| CommandError::db("读取筛选选项", err))?);
            }
            Ok(out)
        };

        let years = {
            let mut stmt = conn
                .prepare("SELECT DISTINCT exam_year FROM article WHERE exam_year IS NOT NULL ORDER BY exam_year DESC")
                .map_err(|err| CommandError::db("准备年份查询", err))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|err| CommandError::db("查询年份", err))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| CommandError::db("读取年份", err))?);
            }
            out
        };

        Ok(FilterOptions {
            exam_types: distinct("SELECT DISTINCT exam_type FROM article WHERE exam_type IS NOT NULL ORDER BY exam_type")?,
            years,
            section_types: distinct(
                "SELECT DISTINCT section_type FROM article WHERE section_type IS NOT NULL ORDER BY section_type",
            )?,
            sources: distinct("SELECT DISTINCT source FROM article WHERE source IS NOT NULL ORDER BY source")?,
        })
    })
}

/// 精读页载荷：篇目元信息 + 段落/句子/词（含 `isWord`）+ 空格号 + 题目
#[tauri::command]
pub fn get_article_content(
    db: State<'_, Db>,
    labels: State<'_, PackLabels>,
    article_id: i64,
) -> Result<ArticleContent, CommandError> {
    struct DetailRow {
        id: i64,
        title: String,
        source_key: String,
        exam_type: String,
        exam_year: Option<i64>,
        exam_set: Option<String>,
        section_type: Option<String>,
        word_count: Option<i64>,
        sentence_count: i64,
        source: Option<String>,
    }
    struct ParagraphRow {
        id: i64,
        idx: i64,
        text: String,
    }
    struct SentenceRow {
        id: i64,
        paragraph_id: i64,
        idx: i64,
        start: i64,
        end: i64,
        text: String,
    }
    struct TokenRow {
        sentence_id: i64,
        id: i64,
        start: i64,
        end: i64,
        surface: String,
        normalized: String,
        is_word: bool,
    }

    let (detail, paragraph_rows, sentence_rows, token_rows, blank_nos, questions, options_warned): (
        DetailRow,
        Vec<ParagraphRow>,
        Vec<SentenceRow>,
        Vec<TokenRow>,
        Vec<i64>,
        Vec<QuestionNode>,
        bool,
    ) = db.read(|conn| {
        let detail = conn
            .query_row(
                "SELECT id, title, source_key, exam_type, exam_year, exam_set, section_type,
                        word_count, sentence_count, source
                 FROM article WHERE id = ?1",
                [article_id],
                |row| {
                    Ok(DetailRow {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        source_key: row.get(2)?,
                        exam_type: row.get(3)?,
                        exam_year: row.get(4)?,
                        exam_set: row.get(5)?,
                        section_type: row.get(6)?,
                        word_count: row.get(7)?,
                        sentence_count: row.get(8)?,
                        source: row.get(9)?,
                    })
                },
            )
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => CommandError::article_not_found(article_id),
                other => CommandError::db("查询文章", other),
            })?;

        let paragraph_rows: Vec<ParagraphRow> = {
            let mut stmt = conn
                .prepare("SELECT id, idx, text FROM paragraph WHERE article_id = ?1 ORDER BY idx")
                .map_err(|err| CommandError::db("准备段落查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| {
                    Ok(ParagraphRow {
                        id: row.get(0)?,
                        idx: row.get(1)?,
                        text: row.get(2)?,
                    })
                })
                .map_err(|err| CommandError::db("查询段落", err))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| CommandError::db("读取段落", err))?);
            }
            out
        };

        let sentence_rows: Vec<SentenceRow> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, paragraph_id, idx, start_offset, end_offset, text
                     FROM sentence WHERE article_id = ?1 ORDER BY paragraph_id, idx",
                )
                .map_err(|err| CommandError::db("准备句子查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| {
                    Ok(SentenceRow {
                        id: row.get(0)?,
                        paragraph_id: row.get(1)?,
                        idx: row.get(2)?,
                        start: row.get(3)?,
                        end: row.get(4)?,
                        text: row.get(5)?,
                    })
                })
                .map_err(|err| CommandError::db("查询句子", err))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| CommandError::db("读取句子", err))?);
            }
            out
        };

        let token_rows: Vec<TokenRow> = {
            let mut stmt = conn
                .prepare(
                    "SELECT t.sentence_id, t.id, t.start_offset, t.end_offset, t.surface, t.normalized, t.is_word
                     FROM token t JOIN sentence s ON s.id = t.sentence_id
                     WHERE s.article_id = ?1 ORDER BY t.sentence_id, t.idx",
                )
                .map_err(|err| CommandError::db("准备词查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| {
                    Ok(TokenRow {
                        sentence_id: row.get(0)?,
                        id: row.get(1)?,
                        start: row.get(2)?,
                        end: row.get(3)?,
                        surface: row.get(4)?,
                        normalized: row.get(5)?,
                        is_word: row.get::<_, i64>(6)? != 0,
                    })
                })
                .map_err(|err| CommandError::db("查询词", err))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| CommandError::db("读取词", err))?);
            }
            out
        };

        let blank_nos: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT blank_no FROM blank WHERE article_id = ?1 ORDER BY blank_no")
                .map_err(|err| CommandError::db("准备空格查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| row.get::<_, i64>(0))
                .map_err(|err| CommandError::db("查询空格", err))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| CommandError::db("读取空格", err))?);
            }
            out
        };

        // options_json 在 Rust 侧解析成数组再下发（§三.0：不把原始 JSON 串发给前端）
        let mut options_warned = false;
        let questions: Vec<QuestionNode> = {
            let mut stmt = conn
                .prepare("SELECT idx, stem, options_json, answer FROM question WHERE article_id = ?1 ORDER BY idx")
                .map_err(|err| CommandError::db("准备题目查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|err| CommandError::db("查询题目", err))?;
            let mut out = Vec::new();
            for row in rows {
                let (idx, stem, options_json, answer) = row.map_err(|err| CommandError::db("读取题目", err))?;
                let raw_options = options_json.as_deref();
                // 注意：长篇阅读篇的 options 合法地就是 `[]`（信息匹配题没有选项），
                // 只有「解析**失败**」才算异常——不能拿「结果为空」当失败判据。
                let options: Vec<QuestionOptionNode> = match raw_options {
                    Some(json) => match serde_json::from_str(json) {
                        Ok(value) => value,
                        Err(err) => {
                            eprintln!("[judou][commands] 题目 {idx} 的 options_json 解析失败：{err}");
                            options_warned = true;
                            Vec::new()
                        }
                    },
                    None => Vec::new(),
                };
                out.push(QuestionNode {
                    idx,
                    stem,
                    options,
                    answer,
                });
            }
            out
        };

        Ok((detail, paragraph_rows, sentence_rows, token_rows, blank_nos, questions, options_warned))
    })?;

    if options_warned {
        eprintln!("[judou][commands] warning: 篇目 {article_id} 有题目的 options_json 解析为空");
    }

    // 词按 sentence_id 归组，避免每句一次查询
    let mut tokens_by_sentence: HashMap<i64, Vec<TokenNode>> = HashMap::new();
    for token in token_rows {
        tokens_by_sentence.entry(token.sentence_id).or_default().push(TokenNode {
            id: token.id,
            start: token.start,
            end: token.end,
            surface: token.surface,
            normalized: token.normalized,
            is_word: token.is_word,
        });
    }

    // 句按 paragraph_id 归组；词按 sentence_id 归组（各一次查询，不做 N+1）
    let mut sentences_by_paragraph: HashMap<i64, Vec<SentenceRow>> = HashMap::new();
    for sentence in sentence_rows {
        sentences_by_paragraph.entry(sentence.paragraph_id).or_default().push(sentence);
    }

    let paragraphs = paragraph_rows
        .into_iter()
        .map(|paragraph| {
            let sentences = sentences_by_paragraph
                .remove(&paragraph.id)
                .unwrap_or_default()
                .into_iter()
                .map(|sentence| SentenceNode {
                    id: sentence.id,
                    idx: sentence.idx,
                    start: sentence.start,
                    end: sentence.end,
                    text: sentence.text,
                    tokens: tokens_by_sentence.remove(&sentence.id).unwrap_or_default(),
                    blank_nos: blank_nos.clone(),
                })
                .collect::<Vec<_>>();
            ParagraphNode {
                idx: paragraph.idx,
                text: paragraph.text,
                sentences,
            }
        })
        .collect::<Vec<_>>();

    Ok(ArticleContent {
        article: ArticleDetail {
            section_label: labels.section_label(&detail.source_key, detail.section_type.as_deref()),
            passage_label: labels.passage_label(&detail.source_key),
            id: detail.id,
            title: detail.title,
            source_key: detail.source_key,
            exam_type: detail.exam_type,
            exam_year: detail.exam_year,
            exam_set: detail.exam_set,
            section_type: detail.section_type,
            word_count: detail.word_count,
            sentence_count: detail.sentence_count,
            source: detail.source,
        },
        paragraphs,
        questions,
        has_analysis: true,
    })
}

/// 手动触发一次导入（自测/将来「重新导入内容包」用；正常路径是启动时自动跑）
#[tauri::command]
pub fn import_content_pack(pack_path: State<'_, PackPath>, db: State<'_, Db>) -> Result<ImportReport, CommandError> {
    let manifest = pack::load_manifest(&pack_path.0).map_err(CommandError::pack)?;
    import::run(&db, &pack_path.0, &manifest).map_err(CommandError::startup)
}

/// 启动错误通道（AC1 第 5 个命令）：**不依赖 `Db`**（O3——DB 打不开时这条仍要能答）。
/// 成功启动返回 `None`（见 `StartupState::error`）。
#[tauri::command]
pub fn get_startup_error(state: State<'_, StartupState>) -> Option<StartupErrorInfo> {
    state.error()
}

/// `AND col IN (?, ?, …)` 的占位符拼装（列名来自本文件的字面量，不接受外部输入）
fn push_in_clause(sql: &mut String, column: &str, len: usize) {
    let placeholders = std::iter::repeat("?").take(len).collect::<Vec<_>>().join(",");
    sql.push_str(&format!(" AND {column} IN ({placeholders})"));
}

/// LIKE 通配符转义：用户输入的 `%` / `_` 必须当前缀字面量（AC5 断言 `%_` 不产生全表）
fn escape_like(keyword: &str) -> String {
    keyword
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ─────────────────────── M2 · 解析 / 词卡 / 空格 / 笔记（8 个薄包装） ───────────────────────
//
// 分工：查询与写入实现在 `analysis.rs`；这里只做 `#[tauri::command]` 薄包装（02 D1 / 评审 N2-1）。
// **注册点只在 `lib.rs` 的 `generate_handler!`**——本文件不注册，漏改 lib.rs 则 8 个 invoke 全 command not found。
// 查不到一律 `Ok(None)`（不报错误码，04 §10.1）。

/// 句子六段式解析
#[tauri::command]
pub fn get_sentence_analysis(
    db: State<'_, Db>,
    sentence_id: i64,
) -> Result<Option<analysis::SentenceAnalysis>, CommandError> {
    analysis::get_sentence_analysis(&db, sentence_id)
}

/// 词的语境解析（`token_analysis` 1:1 于重点 token）
#[tauri::command]
pub fn get_token_analysis(db: State<'_, Db>, token_id: i64) -> Result<Option<analysis::TokenAnalysis>, CommandError> {
    analysis::get_token_analysis(&db, token_id)
}

/// 全局词库按 `normalized` 主键查
#[tauri::command]
pub fn lookup_lexicon(db: State<'_, Db>, normalized: String) -> Result<Option<analysis::LexiconEntry>, CommandError> {
    analysis::lookup_lexicon(&db, &normalized)
}

/// 选词填空逐空解析（返回字段钉死 `{blankNo, answerKey, answerWord, reason, distractors}`）
#[tauri::command]
pub fn get_blank_analysis(
    db: State<'_, Db>,
    article_id: i64,
    blank_no: i64,
) -> Result<Option<analysis::BlankAnalysis>, CommandError> {
    analysis::get_blank_analysis(&db, article_id, blank_no)
}

/// 句子笔记（未写过返回 `null`）
#[tauri::command]
pub fn get_sentence_note(db: State<'_, Db>, sentence_id: i64) -> Result<Option<analysis::SentenceNote>, CommandError> {
    analysis::get_sentence_note(&db, sentence_id)
}

/// 词笔记（未写过返回 `null`）
#[tauri::command]
pub fn get_word_note(db: State<'_, Db>, token_id: i64) -> Result<Option<analysis::WordNote>, CommandError> {
    analysis::get_word_note(&db, token_id)
}

/// 本篇笔记标记（TP-修复1 F4 / AC-R3）：一次 IPC 返回**本篇**有笔记的 `sentenceId` / `tokenId` 两组 id。
/// 正文层据此给句角标与词节点打 `data-has-note`；漏在此注册（`lib.rs` `generate_handler!`）会 command not found。
#[tauri::command]
pub fn get_article_note_marks(db: State<'_, Db>, article_id: i64) -> Result<analysis::NoteMarks, CommandError> {
    analysis::get_article_note_marks(&db, article_id)
}

/// 句子笔记 upsert：三栏 TRIM 后全空 → 删除该行（`deleted=true`）
#[tauri::command]
pub fn upsert_sentence_note(
    db: State<'_, Db>,
    sentence_id: i64,
    translation: Option<String>,
    grammar_note: Option<String>,
    phrase_note: Option<String>,
) -> Result<analysis::NoteUpsertResult, CommandError> {
    analysis::upsert_sentence_note(
        &db,
        sentence_id,
        translation.as_deref(),
        grammar_note.as_deref(),
        phrase_note.as_deref(),
    )
}

/// 词笔记 upsert：三栏 TRIM 后全空 → 删除该行
#[tauri::command]
pub fn upsert_word_note(
    db: State<'_, Db>,
    token_id: i64,
    context_meaning: Option<String>,
    collocation: Option<String>,
    example: Option<String>,
) -> Result<analysis::NoteUpsertResult, CommandError> {
    analysis::upsert_word_note(
        &db,
        token_id,
        context_meaning.as_deref(),
        collocation.as_deref(),
        example.as_deref(),
    )
}

// ───────────────────────── M3 生词本（8 个薄包装；实现在 vocab.rs，注册在 lib.rs） ─────────────────────────
//
// ponytail: 每个包装只做「参数 → 实现」一层转手，不在这里写 SQL、不在这里做校验——
// 校验与 SQL 在 `vocab.rs`（可单测）；注册点只在 `lib.rs`（02 D1）。

/// 生词列表：平铺行 + tagNames（分组在纯函数层 `src/lib/vocab.ts`）
#[tauri::command]
pub fn list_vocab(
    db: State<'_, Db>,
    group_by: Option<String>,
    filter: Option<vocab::VocabFilter>,
) -> Result<vocab::VocabList, CommandError> {
    vocab::list_vocab(&db, group_by, filter)
}

/// 从词节点收藏（重复收藏不改任何列，返回 `created=false`）
#[tauri::command]
pub fn add_vocab_from_token(
    db: State<'_, Db>,
    token_id: i64,
) -> Result<vocab::VocabAddResult, CommandError> {
    vocab::add_vocab_from_token(&db, token_id)
}

/// 编辑生词（只允许语境义/音标/词性/掌握状态四列）
#[tauri::command]
pub fn update_vocab(
    db: State<'_, Db>,
    vocab_id: i64,
    patch: vocab::VocabPatch,
) -> Result<vocab::VocabEntry, CommandError> {
    vocab::update_vocab(&db, vocab_id, patch)
}

/// 移出生词本（连带清标签关联）
#[tauri::command]
pub fn delete_vocab(db: State<'_, Db>, vocab_id: i64) -> Result<bool, CommandError> {
    vocab::delete_vocab(&db, vocab_id)
}

/// 按 normalized 查词（词卡判断「已在生词本」）
#[tauri::command]
pub fn get_vocab_by_normalized(
    db: State<'_, Db>,
    normalized: String,
) -> Result<Option<vocab::VocabEntry>, CommandError> {
    vocab::get_vocab_by_normalized(&db, &normalized)
}

/// 全部标签（按名升序）
#[tauri::command]
pub fn list_tags(db: State<'_, Db>) -> Result<Vec<vocab::Tag>, CommandError> {
    vocab::list_tags(&db)
}

/// 全量替换某词的标签，返回替换后的标签
#[tauri::command]
pub fn set_vocab_tags(
    db: State<'_, Db>,
    vocab_id: i64,
    tag_names: Vec<String>,
) -> Result<Vec<vocab::Tag>, CommandError> {
    vocab::set_vocab_tags(&db, vocab_id, tag_names)
}

/// 删标签（连带解除关联，生词条目保留）
#[tauri::command]
pub fn delete_tag(db: State<'_, Db>, tag_id: i64) -> Result<bool, CommandError> {
    vocab::delete_tag(&db, tag_id)
}

// ───────────────────────── M4 复习（7 个薄包装；实现在 review.rs，注册在 lib.rs） ─────────────────────────
//
// ponytail: 每个包装只做「参数 → 实现」一层转手，不在这里写 SQL、不在这里做校验——
// 校验（today 格式 / result 两值）与 SQL 在 `review.rs`（可单测）；注册点只在 `lib.rs`（02 D1）。

/// 标记本篇完成：建计划（若无）+ 写 `reading_record.completed`；**幂等**（已有计划原样返回）
#[tauri::command]
pub fn mark_article_completed(
    db: State<'_, Db>,
    article_id: i64,
    today: String,
) -> Result<review::ReviewPlan, CommandError> {
    review::mark_article_completed(&db, article_id, &today)
}

/// 今日到期（`active` 且 `next_review_at <= today`），按到期日升序
#[tauri::command]
pub fn get_due_reviews(db: State<'_, Db>, today: String) -> Result<Vec<review::DueReview>, CommandError> {
    review::get_due_reviews(&db, &today)
}

/// 单篇计划（无则 null）
#[tauri::command]
pub fn get_review_plan(
    db: State<'_, Db>,
    article_id: i64,
) -> Result<Option<review::ReviewPlan>, CommandError> {
    review::get_review_plan(&db, article_id)
}

/// 复习结果 → 计划顺延 + 日志一行（`result` ∈ {done, need_more}）
#[tauri::command]
pub fn complete_review(
    db: State<'_, Db>,
    article_id: i64,
    result: String,
    today: String,
) -> Result<review::ReviewPlan, CommandError> {
    review::complete_review(&db, article_id, &result, &today)
}

/// 手动重启计划：回到四档起点（plan 不存在时建行）
#[tauri::command]
pub fn restart_review_plan(
    db: State<'_, Db>,
    article_id: i64,
    today: String,
) -> Result<review::ReviewPlan, CommandError> {
    review::restart_review_plan(&db, article_id, &today)
}

/// 复习日志（给 articleId 只看那篇；按 reviewedAt 降序）
#[tauri::command]
pub fn list_review_logs(
    db: State<'_, Db>,
    article_id: Option<i64>,
) -> Result<Vec<review::ReviewLog>, CommandError> {
    review::list_review_logs(&db, article_id)
}

/// **全部**计划（含 `status='done'`）——复习页「已完成」区与「重新加入复习」的数据源
#[tauri::command]
pub fn list_review_plans(db: State<'_, Db>) -> Result<Vec<review::ReviewPlan>, CommandError> {
    review::list_review_plans(&db)
}

/// 最近读过的一篇（今日页「继续精读」栏的数据源；无记录返回 null）。**只读**，不碰 M6 两列。
#[tauri::command]
pub fn get_last_read_article(
    db: State<'_, Db>,
) -> Result<Option<review::LastReadArticle>, CommandError> {
    review::get_last_read_article(&db)
}

// ───────────────────────── M5 · 用户导入（D1：2 个薄包装） ─────────────────────────
// 清洗/分段/切句/分词/四层校验全在 `import_user.rs`（纯函数 + 单测），这里只做「参数 → 实现」转手。
// 两命令都是**同步 fn**：`commit_import` 是本地 SQLite 单事务（毫秒级），
// `Cargo.toml` 无 tokio/async 运行时，与既有命令同口径。

/// 两阶段①：粘贴文本 → 预览（切段/切句/分词 + stats）。**不写库**（AC1）。
/// 超过 20000 字符 → `IMPORT_TOO_LARGE`。
#[tauri::command]
pub fn parse_import_preview(
    text: String,
    title: Option<String>,
) -> Result<import_user::ImportPreview, CommandError> {
    import_user::parse_preview(&text, title)
}

/// 两阶段②：预览（用户可剔段/改标题后回传）→ 四层校验 → 单事务入库 → 新文章 id。
/// 失败码：`IMPORT_L1_STRUCTURE` / `IMPORT_L2_OFFSET` / `IMPORT_L3_COVERAGE` /
/// `IMPORT_L4_BUSINESS` / `IMPORT_TOO_LARGE` / `IMPORT_DUPLICATE_SOURCE`，任一失败库中零写入。
#[tauri::command]
pub fn commit_import(
    db: State<'_, Db>,
    preview: import_user::ImportPreview,
    meta: import_user::ImportMeta,
) -> Result<import_user::ImportCommitResult, CommandError> {
    import_user::commit_import(&db, &preview, &meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// LIKE 转义（AC5）：`%` 与 `_` 必须变成字面量，否则用户输入一个 `%` 就命中全表
    #[test]
    fn keyword_wildcards_are_escaped() {
        assert_eq!(escape_like("busy"), "busy");
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("c\\d"), "c\\\\d");
    }

    #[test]
    fn theme_accepts_three_tiers_only() {
        assert!(validate_setting("theme", "light").is_ok());
        assert!(validate_setting("theme", "dark").is_ok());
        assert!(validate_setting("theme", "system").is_ok());
        assert_eq!(
            validate_setting("theme", "Dark").unwrap_err().code,
            "invalid_setting_value"
        );
    }

    #[test]
    fn unknown_key_is_rejected_with_contract_code() {
        let err = validate_setting("nope", "1").unwrap_err();
        assert_eq!(err.code, "invalid_setting_key");
    }

    #[test]
    fn review_intervals_must_be_four_positive_ints() {
        assert!(validate_setting("review_intervals", "[1,3,7,14]").is_ok());
        assert!(validate_setting("review_intervals", "[1,3,7]").is_err());
        assert!(validate_setting("review_intervals", "[1,3,7,0]").is_err());
        assert!(validate_setting("review_intervals", "1,3,7,14").is_err());
    }
}
