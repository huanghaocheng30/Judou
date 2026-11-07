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
    article_counts, commit_ai_import, match_payload, parse_payload, patch_ai_analysis, preview_from_article,
    AiCommitMeta, AiDraft, AiSection, ImportMode,
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
    match patch_ai_analysis(&db, article_id, &draft, &matched) {
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
