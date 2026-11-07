//! M5b D6 门禁契约：`ai_import_cli`——把 `ai_import.rs` 的**库层函数**跑一遍，输出**一行 JSON**
//! 给 `scripts/verify-ai-import.mjs` 断言（AC8/AC9/AC10/AC12 的机械判据）。
//!
//! 为什么是 bin：AC8/AC9/AC12 要验「库里真的这么写了」，而前端读数不能当证据。走 lib 层能同时
//! 验「纯函数口径」与「真库行为」，且**不经 IPC**（不依赖 WebView，CI 也能跑）。
//!
//! **纪律（02 D6/N4）**：本文件只调 `judou_lib::ai_import::*` 与 `judou_lib::import_user::parse_preview`，
//! **不复制任何 SQL、不复制任何校验**——校验与写库只有 `ai_import.rs` 一份实现。
//!
//! 用法：
//!   ai_import_cli --commit --section <careful|long|cloze> --text <file> --payload <file> --db <path>
//!   ai_import_cli --patch  --article <id> --payload <file> --db <path> [--section <s>]
//!   ai_import_cli --dump   --article <id> --db <path>
//!
//! 输出：stdout **一行** JSON。业务失败不写 stderr、退出码恒为 0（错误码在 JSON 的 `ok:false` 里）。

use std::collections::HashMap;
use std::path::PathBuf;

use judou_lib::ai_import::{
    article_counts, build_prompt, commit_ai_import, get_article_questions, match_payload, parse_payload,
    patch_ai_analysis, preview_from_article, replace_article_questions, split_user_input, suggest_section,
    update_article_meta, AiCommitMeta, AiDraft, AiSection, ArticleMetaPatch, ImportMode, QuestionView,
};
use judou_lib::db::Db;
use judou_lib::import_user::parse_preview;
use serde_json::{json, Value};

fn main() {
    let args = parse_args();
    let report = match args.mode.as_str() {
        "commit" => commit_case(&args),
        "patch" => patch_case(&args),
        "dump" => dump_case(&args),
        // M5c D8：切分 / 三档提示词 / 编辑三命令——门禁要跑 UI 看不到的纯函数口径
        "split" => split_case(&args),
        "prompt" => prompt_case(&args),
        "meta" => meta_case(&args),
        "dump-questions" => dump_questions_case(&args),
        "set-questions" => set_questions_case(&args),
        // M5c 优化轮 AC5：题型推断（纯函数，供门禁断言三推断 + 不敢猜）
        "suggest" => suggest_case(&args),
        other => json!({ "ok": false, "code": "CLI_USAGE", "message": format!("未知模式：{other}") }),
    };
    println!("{}", serde_json::to_string(&report).expect("序列化报告失败"));
}

#[derive(Default)]
struct Args {
    mode: String,
    /// `--flag value` 的键值对（同一键重复时后者覆盖）
    options: HashMap<String, String>,
}

fn parse_args() -> Args {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    if let Some(first) = iter.next() {
        args.mode = first.trim_start_matches("--").to_string();
    }
    while let Some(key) = iter.next() {
        if !key.starts_with("--") {
            continue;
        }
        let name = key.trim_start_matches("--").to_string();
        let value = iter.next().unwrap_or_default();
        args.options.insert(name, value);
    }
    args
}

impl Args {
    fn get(&self, key: &str) -> Option<&str> {
        self.options.get(key).map(String::as_str).filter(|value| !value.is_empty())
    }

    fn required(&self, key: &str) -> Result<&str, Value> {
        self.get(key)
            .ok_or_else(|| json!({ "ok": false, "code": "CLI_USAGE", "message": format!("缺少参数 --{key}") }))
    }

    fn db(&self) -> Result<Db, Value> {
        let path = self.required("db")?;
        Db::open(PathBuf::from(path)).map_err(|err| json!({ "ok": false, "code": err.code, "message": err.message }))
    }
}

fn read_text(path: &str) -> Result<String, Value> {
    std::fs::read_to_string(path)
        .map_err(|err| json!({ "ok": false, "code": "CLI_IO", "message": format!("读文件失败 {path}：{err}") }))
}

fn failure(err: judou_lib::commands::CommandError) -> Value {
    json!({
        "ok": false,
        "code": err.code,
        "message": err.message,
        "path": err.path,
    })
}

fn usage(message: &str) -> Value {
    json!({ "ok": false, "code": "CLI_USAGE", "message": message })
}

/// `--commit`：原文 + payload → 预览 → 容错解析 → 匹配 → 入库（真库）
fn commit_case(args: &Args) -> Value {
    let (Ok(section_raw), Ok(text_path), Ok(payload_path)) =
        (args.required("section"), args.required("text"), args.required("payload"))
    else {
        return usage("--commit 需要 --section --text --payload --db");
    };
    let Some(section) = AiSection::parse(section_raw) else {
        return usage(&format!("--section 只能是 careful / long / cloze，当前是 {section_raw}"));
    };
    let Ok(raw_text) = read_text(text_path) else {
        return json!({ "ok": false, "code": "CLI_IO", "message": format!("读原文失败：{text_path}") });
    };
    let Ok(raw_payload) = read_text(payload_path) else {
        return json!({ "ok": false, "code": "CLI_IO", "message": format!("读 payload 失败：{payload_path}") });
    };
    let Ok(db) = args.db() else {
        return usage("--db 打不开");
    };

    // 预览走既有实现（App 管结构：切段/切句/分词/偏移都在这条路上算）
    let preview = match parse_preview(&raw_text, None) {
        Ok(preview) => preview,
        Err(err) => return failure(err),
    };
    // M5c：档位与题目区原文（档 C 的逐字比对 / answer_source 判定都要它们）
    let mode = args.get("mode").and_then(ImportMode::parse).unwrap_or(ImportMode::Full);
    let question_text = args.get("questions").map(|path| read_text(path).unwrap_or_default());
    let draft = AiDraft {
        preview,
        section,
        mode,
        question_text,
    };

    let parsed = match parse_payload(&raw_payload) {
        Ok(parsed) => parsed,
        Err(err) => return failure(err),
    };
    let matched = match match_payload(&draft, &parsed.payload) {
        Ok(matched) => matched,
        Err(err) => return failure(err),
    };
    let meta = AiCommitMeta {
        exam_type: args.get("exam-type").map(str::to_string),
        exam_year: args.get("exam-year").and_then(|raw| raw.parse::<i64>().ok()),
    };
    match commit_ai_import(&db, &draft, &matched, &meta) {
        Ok(report) => json!({
            "ok": true,
            "articleId": report.article_id,
            "sourceKey": report.source_key,
            "analysisWritten": report.analysis_written,
            "questionsWritten": report.questions_written,
            "blanksWritten": report.blanks_written,
            "lexiconInserted": report.lexicon_inserted,
            "coverage": report.coverage,
            "stats": report.stats,
            "ignoredChars": parsed.ignored_chars,
            "matchedCount": matched.matched.len(),
            "unmatched": matched.unmatched,
            "unmatchedLexicon": matched.unmatched_lexicon,
            "snoFixed": matched.sno_fixed,
            "missingAnswer": matched.missing_answer,
        }),
        Err(err) => failure(err),
    }
}

/// `--patch`：已入库文章（原文从库回读）+ payload → 匹配 → 只写解析四表
fn patch_case(args: &Args) -> Value {
    let (Ok(article_raw), Ok(payload_path)) = (args.required("article"), args.required("payload")) else {
        return usage("--patch 需要 --article --payload --db");
    };
    let Ok(article_id) = article_raw.parse::<i64>() else {
        return usage(&format!("--article 需要整数，当前是 {article_raw}"));
    };
    let Ok(raw_payload) = read_text(payload_path) else {
        return json!({ "ok": false, "code": "CLI_IO", "message": format!("读 payload 失败：{payload_path}") });
    };
    let Ok(db) = args.db() else {
        return usage("--db 打不开");
    };

    let (preview, section_type) = match preview_from_article(&db, article_id) {
        Ok(value) => value,
        Err(err) => return failure(err),
    };
    // 题型优先取 --section，其次取 article.section_type（NULL 或不在枚举内就报错，不猜）
    let section = match args.get("section").and_then(AiSection::parse) {
        Some(section) => section,
        None => match section_type.as_deref().and_then(AiSection::parse) {
            Some(section) => section,
            None => {
                return json!({
                    "ok": false,
                    "code": "AI_TYPE_MISMATCH",
                    "message": "这篇文章库里没有可用的题型（section_type 为空或不在 careful/long/cloze 内），请用 --section 指定",
                    "path": "section"
                })
            }
        },
    };
    let mode = args.get("mode").and_then(ImportMode::parse).unwrap_or(ImportMode::Full);
    let question_text = args.get("questions").map(|path| read_text(path).unwrap_or_default());
    let draft = AiDraft {
        preview,
        section,
        mode,
        question_text,
    };

    let parsed = match parse_payload(&raw_payload) {
        Ok(parsed) => parsed,
        Err(err) => return failure(err),
    };
    let matched = match match_payload(&draft, &parsed.payload) {
        Ok(matched) => matched,
        Err(err) => return failure(err),
    };
    match patch_ai_analysis(&db, article_id, Some(&draft), &matched) {
        Ok(report) => json!({
            "ok": true,
            "articleId": report.article_id,
            "analysisWritten": report.analysis_written,
            "questionsWritten": report.questions_written,
            "blanksWritten": report.blanks_written,
            "lexiconInserted": report.lexicon_inserted,
            "stats": report.stats,
            "coverage": matched.coverage,
            "ignoredChars": parsed.ignored_chars,
            "matchedCount": matched.matched.len(),
            "unmatched": matched.unmatched,
            "unmatchedLexicon": matched.unmatched_lexicon,
            "snoFixed": matched.sno_fixed,
            "missingAnswer": matched.missing_answer,
        }),
        Err(err) => failure(err),
    }
}

/// `--dump`：三结构表行数 + 解析/题目/空/词条数 + 三结构表内容哈希（AC8/AC9/AC12 的读数）
fn dump_case(args: &Args) -> Value {
    let Ok(article_raw) = args.required("article") else {
        return usage("--dump 需要 --article --db");
    };
    let Ok(article_id) = article_raw.parse::<i64>() else {
        return usage(&format!("--article 需要整数，当前是 {article_raw}"));
    };
    let Ok(db) = args.db() else {
        return usage("--db 打不开");
    };
    match article_counts(&db, article_id) {
        Ok(counts) => json!({
            "ok": true,
            "articleId": counts.article_id,
            "paragraphs": counts.paragraphs,
            "sentences": counts.sentences,
            "tokens": counts.tokens,
            "analyses": counts.analyses,
            "questions": counts.questions,
            "blanks": counts.blanks,
            "lexicon": counts.lexicon,
            "structureHash": counts.structure_hash,
        }),
        Err(err) => failure(err),
    }
}

// ═══════════════ M5c D8：门禁要跑的纯函数口径（切分 / 提示词 / 编辑三命令） ═══════════════
// 纪律不变：本文件只**调** `ai_import.rs` 的库层函数，不复制任何校验、不复制任何 SQL。

/// `--suggest --payload <file>`：AC1/AC5 的题型推断读数（三种推断 + 不敢猜）
///
/// 只读：走到 `parse_payload` 为止，**不碰库、不写文件**。`section: null` ＝ 不敢猜，
/// 前端据此不显示任何建议（不自动猜并静默切换是硬边界）。
fn suggest_case(args: &Args) -> Value {
    let Some(path) = args.get("payload") else {
        return usage("--suggest 需要 --payload <file>");
    };
    let raw = match read_text(path) {
        Ok(text) => text,
        Err(_) => {
            return json!({ "ok": false, "code": "CLI_IO", "message": format!("读 payload 失败：{path}") })
        }
    };
    match parse_payload(&raw) {
        Ok(parsed) => json!({
            "ok": true,
            "section": suggest_section(&parsed.payload).map(|section| section.as_str()),
        }),
        Err(err) => failure(err),
    }
}

/// 组装 `AiDraft`（三档 + 题目区原文）；`--split` 与 `--prompt` 共用
fn build_draft(args: &Args) -> Result<AiDraft, Value> {
    let section_raw = args.required("section")?;
    let Some(section) = AiSection::parse(section_raw) else {
        return Err(usage(&format!(
            "--section 只能是 careful / long / cloze，当前是 {section_raw}"
        )));
    };
    let raw_text = read_text(args.required("text")?)?;
    let preview = parse_preview(&raw_text, None).map_err(failure)?;
    let mode = args.get("mode").and_then(ImportMode::parse).unwrap_or(ImportMode::Full);
    let question_text = args.get("questions").map(|path| read_text(path).unwrap_or_default());
    Ok(AiDraft {
        preview,
        section,
        mode,
        question_text,
    })
}

/// `--split --text <file> [--start <1-based 行号>]`：AC3/AC4 的切分读数
///
/// `--start` = 界面上「手动标记题目区起点」的同一动作：只是按行切片（1-based），
/// **不改任何识别规则**——自动识别失败时的逃生口。
fn split_case(args: &Args) -> Value {
    let Ok(path) = args.required("text") else {
        return usage("--split 需要 --text <file>");
    };
    let Ok(raw) = read_text(path) else {
        return json!({ "ok": false, "code": "CLI_IO", "message": format!("读原文失败：{path}") });
    };
    let mut split = split_user_input(&raw);
    if let Some(start_raw) = args.get("start") {
        let Ok(start) = start_raw.parse::<usize>() else {
            return usage(&format!("--start 需要正整数行号，当前是 {start_raw}"));
        };
        let lines: Vec<&str> = raw.lines().collect();
        if start == 0 || start > lines.len() {
            return usage(&format!("--start 超出范围（1..={}），当前是 {start}", lines.len()));
        }
        split.body_text = lines[..start - 1].join("\n").trim_end().to_string();
        split.question_text = lines[start - 1..].join("\n");
        split.question_start_line = Some(start);
        split.detected = true;
        split.reason = "手动标记题目区起点".to_string();
    }
    json!({
        "ok": true,
        "detected": split.detected,
        "reason": split.reason,
        "questionStartLine": split.question_start_line,
        "questionCount": split.question_count,
        "bodyText": split.body_text,
        "questionText": split.question_text,
    })
}

/// `--prompt --section <s> --text <file> [--mode <m>] [--questions <file>]`：AC5/AC6 的提示词全文
fn prompt_case(args: &Args) -> Value {
    let draft = match build_draft(args) {
        Ok(draft) => draft,
        Err(err) => return err,
    };
    let prompt = build_prompt(&draft, 15);
    json!({
        "ok": true,
        "text": prompt.text,
        "sentenceCount": prompt.sentence_count,
        "batchSize": prompt.batch_size,
        "batchCount": prompt.batch_count,
        "batchHint": prompt.batch_hint,
    })
}

/// `--meta --article <id> --db <path> [--title --exam-type --exam-year --section-type --source --difficulty]`
fn meta_case(args: &Args) -> Value {
    let Ok(article_raw) = args.required("article") else {
        return usage("--meta 需要 --article --db");
    };
    let Ok(article_id) = article_raw.parse::<i64>() else {
        return usage(&format!("--article 需要整数，当前是 {article_raw}"));
    };
    let Ok(db) = args.db() else {
        return usage("--db 打不开");
    };
    let patch = ArticleMetaPatch {
        title: args.get("title").map(str::to_string),
        exam_type: args.get("exam-type").map(str::to_string),
        exam_year: args.get("exam-year").and_then(|raw| raw.parse::<i64>().ok()),
        section_type: args.get("section-type").map(str::to_string),
        source: args.get("source").map(str::to_string),
        difficulty: args.get("difficulty").map(str::to_string),
    };
    match update_article_meta(&db, article_id, &patch) {
        Ok(()) => json!({ "ok": true, "articleId": article_id }),
        Err(err) => failure(err),
    }
}

/// `--dump-questions --article <id> --db <path>`：编辑面板初值（AC10）
fn dump_questions_case(args: &Args) -> Value {
    let Ok(article_raw) = args.required("article") else {
        return usage("--dump-questions 需要 --article --db");
    };
    let Ok(article_id) = article_raw.parse::<i64>() else {
        return usage(&format!("--article 需要整数，当前是 {article_raw}"));
    };
    let Ok(db) = args.db() else {
        return usage("--db 打不开");
    };
    match get_article_questions(&db, article_id) {
        Ok(questions) => json!({ "ok": true, "questions": questions }),
        Err(err) => failure(err),
    }
}

/// `--set-questions --article <id> --db <path> --payload <file>`：整批替换题目（只写 question 表）
fn set_questions_case(args: &Args) -> Value {
    let Ok(article_raw) = args.required("article") else {
        return usage("--set-questions 需要 --article --db --payload");
    };
    let Ok(article_id) = article_raw.parse::<i64>() else {
        return usage(&format!("--article 需要整数，当前是 {article_raw}"));
    };
    let Ok(payload_path) = args.required("payload") else {
        return usage("--set-questions 需要 --payload <questions.json>");
    };
    let Ok(raw) = read_text(payload_path) else {
        return json!({ "ok": false, "code": "CLI_IO", "message": format!("读题目失败：{payload_path}") });
    };
    let Ok(questions) = serde_json::from_str::<Vec<QuestionView>>(&raw) else {
        return usage("--payload 必须是 QuestionView 数组的 JSON");
    };
    let Ok(db) = args.db() else {
        return usage("--db 打不开");
    };
    match replace_article_questions(&db, article_id, &questions) {
        Ok(written) => json!({ "ok": true, "questions": written }),
        Err(err) => failure(err),
    }
}