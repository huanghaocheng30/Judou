//! M2 D1 · 解析 / 词条 / 空格 / 笔记的查询与写入层。
//!
//! 分工（02 D1 / 评审 B-1）：本文件是**实现**；`commands.rs` 只做 `#[tauri::command]` 薄包装，
//! 注册点只在 `lib.rs` 的 `generate_handler!`。
//!
//! 红线（02 D1 / AC10）：
//! - 只写 `sentence_note` / `word_note`；**绝不写** `vocab_entry` / `tag` / `review_*` / `reading_record`；
//! - **绝不改**四张解析表（`sentence_analysis` / `token_analysis` / `lexicon` / `blank`）——本文件对它们只有 SELECT；
//! - 查不到一律 `Ok(None)`，不报错误码（04 §10.1「取后者更简」）。
//!
//! 错误结构复用 `commands::CommandError`（同 crate 模块互引，不新建错误类型、不构成循环）。
//!
//! ponytail: JSON 列在 Rust 侧解析成数组/对象再下发（§三.0「不把 JSON 串发给前端」），不引 DTO 框架；
//! 解析失败降级为空数组 + stderr 提示——一行坏 JSON 不该把整张卡拉白。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::CommandError;
use crate::db::Db;

// ───────────────────────────── 返回体（camelCase 边界） ─────────────────────────────

/// 句子成分（`components_json` 单项）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentItem {
    pub part: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 重点短语（`phrases_json` 单项）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseItem {
    pub text: String,
    #[serde(default)]
    pub meaning: Option<String>,
    #[serde(default)]
    pub usage: Option<String>,
    #[serde(default)]
    pub example: Option<String>,
}

/// `get_sentence_analysis` 返回体：9 个解析字段 + 句标识
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceAnalysis {
    pub sentence_id: i64,
    pub translation_literal: Option<String>,
    pub translation_natural: Option<String>,
    pub struct_markup: Option<String>,
    pub structure_summary: Option<String>,
    pub paragraph_role: Option<String>,
    pub components: Vec<ComponentItem>,
    pub clauses: Vec<String>,
    pub phrases: Vec<PhraseItem>,
    pub pitfalls: Vec<String>,
}

/// `get_token_analysis` 返回体（列名是 `cet4`，字段名跟着表结构走）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAnalysis {
    pub token_id: i64,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub sense_in_context: Option<String>,
    pub collocations: Option<Value>,
    pub examples: Option<Value>,
    pub is_cet4_high_freq: bool,
    pub more: Option<Value>,
}

/// `lookup_lexicon` 返回体（列名是 `cet`，**不是** `cet4`）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexiconEntry {
    pub normalized: String,
    pub word: String,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub sense: Option<String>,
    pub lemma: Option<String>,
    pub collocations: Option<Value>,
    pub examples: Option<Value>,
    pub is_cet_high_freq: bool,
    pub more: Option<Value>,
}

/// `get_blank_analysis` 返回体：字段钉死 5 个（02 D1）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlankAnalysis {
    pub blank_no: i64,
    pub answer_key: Option<String>,
    pub answer_word: Option<String>,
    pub reason: Option<String>,
    /// 两形态原样下发（string 20 / array 10）；拆条由前端 `normalizeList` 负责
    pub distractors: Option<Value>,
}

/// 句子笔记（3 栏 + 时间戳）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceNote {
    pub sentence_id: i64,
    pub translation: Option<String>,
    pub grammar_note: Option<String>,
    pub phrase_note: Option<String>,
    pub updated_at: String,
}

/// 词笔记（3 栏 + 时间戳）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordNote {
    pub token_id: i64,
    pub context_meaning: Option<String>,
    pub collocation: Option<String>,
    pub example: Option<String>,
    pub updated_at: String,
}

/// 笔记 upsert 结果：全空清空 → 删行
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsertResult {
    pub deleted: bool,
    pub updated_at: Option<String>,
}

/// 本篇「有笔记的句 / 词」两组 id（TP-修复1 F4）：**一次 IPC** 供正文层打标记。
///
/// 为什么不在 `get_article_content` 里下发：正文载荷属于 M1 已验收契约，加字段会改动它的形状；
/// 也不逐句 `get_sentence_note`（274 句 × 2 表 = 数百次 IPC）。两条按 `article_id` 过滤的查询即可。
///
/// 只读 `sentence_note` / `word_note`——AC-R3 红线：解析四表零写、`001_init.sql` 零改动。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMarks {
    /// 本篇有句子笔记的 `sentence.id`（升序）
    pub sentence_ids: Vec<i64>,
    /// 本篇有词笔记的 `token.id`（升序；经 `token.sentence_id → sentence.article_id` 关联）
    pub token_ids: Vec<i64>,
}

// ───────────────────────────── 小工具 ─────────────────────────────

/// JSON 列 → 值：合法 JSON 原样返回；非 JSON 文本降级为字符串值（保内容不丢）。
/// NULL / 空串 → `None`。
fn json_value(raw: Option<&str>) -> Option<Value> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => Some(value),
        Err(_) => Some(Value::String(text.to_string())),
    }
}

/// 结构体数组列（`components_json` / `phrases_json`）：解析失败降级为空数组 + stderr 提示。
/// 一行坏 JSON 不该把整张卡拉白（02 D3 / AC2 缺字段降级口径）。
fn json_list<T: for<'de> Deserialize<'de>>(context: &str, id: i64, raw: Option<&str>) -> Vec<T> {
    let Some(text) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<T>>(text) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[judou][analysis] {context} {id} 的 JSON 解析失败：{err}");
            Vec::new()
        }
    }
}

/// 字符串数组列（`clauses_json` / `pitfalls_json`）：同上。
fn json_string_list(context: &str, id: i64, raw: Option<&str>) -> Vec<String> {
    json_list::<String>(context, id, raw)
}

/// 笔记栏归一：`TRIM` 后为空 → `None`（落库为 NULL）
fn normalize_note(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

// ───────────────────────────── 查询 ─────────────────────────────

/// 句子六段式解析（查不到 `None`）
pub fn get_sentence_analysis(db: &Db, sentence_id: i64) -> Result<Option<SentenceAnalysis>, CommandError> {
    struct Row {
        sentence_id: i64,
        translation_literal: Option<String>,
        translation_natural: Option<String>,
        struct_markup: Option<String>,
        structure_summary: Option<String>,
        paragraph_role: Option<String>,
        components_json: Option<String>,
        clauses_json: Option<String>,
        phrases_json: Option<String>,
        pitfalls_json: Option<String>,
    }

    let row: Option<Row> = db.read(|conn| {
        conn.query_row(
            "SELECT sentence_id, translation_literal, translation_natural, struct_markup,
                    structure_summary, paragraph_role, components_json, clauses_json, phrases_json, pitfalls_json
             FROM sentence_analysis WHERE sentence_id = ?1",
            [sentence_id],
            |row| {
                Ok(Row {
                    sentence_id: row.get(0)?,
                    translation_literal: row.get(1)?,
                    translation_natural: row.get(2)?,
                    struct_markup: row.get(3)?,
                    structure_summary: row.get(4)?,
                    paragraph_role: row.get(5)?,
                    components_json: row.get(6)?,
                    clauses_json: row.get(7)?,
                    phrases_json: row.get(8)?,
                    pitfalls_json: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|err| CommandError::db("查询句子解析", err))
    })?;

    Ok(row.map(|row| SentenceAnalysis {
        sentence_id: row.sentence_id,
        translation_literal: row.translation_literal,
        translation_natural: row.translation_natural,
        struct_markup: row.struct_markup,
        structure_summary: row.structure_summary,
        paragraph_role: row.paragraph_role,
        components: json_list("句子解析成分", sentence_id, row.components_json.as_deref()),
        clauses: json_string_list("句子解析从句", sentence_id, row.clauses_json.as_deref()),
        phrases: json_list("句子解析短语", sentence_id, row.phrases_json.as_deref()),
        pitfalls: json_string_list("句子解析易错点", sentence_id, row.pitfalls_json.as_deref()),
    }))
}

/// 词的语境解析（查不到 `None`）
pub fn get_token_analysis(db: &Db, token_id: i64) -> Result<Option<TokenAnalysis>, CommandError> {
    struct Row {
        token_id: i64,
        phonetic: Option<String>,
        pos: Option<String>,
        sense_in_context: Option<String>,
        collocations_json: Option<String>,
        examples_json: Option<String>,
        is_cet4_high_freq: i64,
        more_json: Option<String>,
    }

    let row: Option<Row> = db.read(|conn| {
        conn.query_row(
            "SELECT token_id, phonetic, pos, sense_in_context, collocations_json, examples_json,
                    is_cet4_high_freq, more_json
             FROM token_analysis WHERE token_id = ?1",
            [token_id],
            |row| {
                Ok(Row {
                    token_id: row.get(0)?,
                    phonetic: row.get(1)?,
                    pos: row.get(2)?,
                    sense_in_context: row.get(3)?,
                    collocations_json: row.get(4)?,
                    examples_json: row.get(5)?,
                    is_cet4_high_freq: row.get(6)?,
                    more_json: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|err| CommandError::db("查询词解析", err))
    })?;

    Ok(row.map(|row| TokenAnalysis {
        token_id: row.token_id,
        phonetic: row.phonetic,
        pos: row.pos,
        sense_in_context: row.sense_in_context,
        collocations: json_value(row.collocations_json.as_deref()),
        examples: json_value(row.examples_json.as_deref()),
        is_cet4_high_freq: row.is_cet4_high_freq != 0,
        more: json_value(row.more_json.as_deref()),
    }))
}

/// 全局词库按 `normalized` 主键查（查不到 `None`）
pub fn lookup_lexicon(db: &Db, normalized: &str) -> Result<Option<LexiconEntry>, CommandError> {
    struct Row {
        normalized: String,
        word: String,
        phonetic: Option<String>,
        pos: Option<String>,
        sense: Option<String>,
        lemma: Option<String>,
        collocations_json: Option<String>,
        examples_json: Option<String>,
        is_cet_high_freq: i64,
        more_json: Option<String>,
    }

    let row: Option<Row> = db.read(|conn| {
        conn.query_row(
            "SELECT normalized, word, phonetic, pos, sense, lemma, collocations_json, examples_json,
                    is_cet_high_freq, more_json
             FROM lexicon WHERE normalized = ?1",
            [normalized],
            |row| {
                Ok(Row {
                    normalized: row.get(0)?,
                    word: row.get(1)?,
                    phonetic: row.get(2)?,
                    pos: row.get(3)?,
                    sense: row.get(4)?,
                    lemma: row.get(5)?,
                    collocations_json: row.get(6)?,
                    examples_json: row.get(7)?,
                    is_cet_high_freq: row.get(8)?,
                    more_json: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|err| CommandError::db("查询词库", err))
    })?;

    Ok(row.map(|row| LexiconEntry {
        normalized: row.normalized,
        word: row.word,
        phonetic: row.phonetic,
        pos: row.pos,
        sense: row.sense,
        lemma: row.lemma,
        collocations: json_value(row.collocations_json.as_deref()),
        examples: json_value(row.examples_json.as_deref()),
        is_cet_high_freq: row.is_cet_high_freq != 0,
        more: json_value(row.more_json.as_deref()),
    }))
}

/// 选词填空逐空解析（查不到 `None`）
pub fn get_blank_analysis(db: &Db, article_id: i64, blank_no: i64) -> Result<Option<BlankAnalysis>, CommandError> {
    struct Row {
        blank_no: i64,
        answer_key: Option<String>,
        answer_word: Option<String>,
        reason: Option<String>,
        distractors: Option<String>,
    }

    let row: Option<Row> = db.read(|conn| {
        conn.query_row(
            "SELECT blank_no, answer_key, answer_word, reason, distractors
             FROM blank WHERE article_id = ?1 AND blank_no = ?2",
            params![article_id, blank_no],
            |row| {
                Ok(Row {
                    blank_no: row.get(0)?,
                    answer_key: row.get(1)?,
                    answer_word: row.get(2)?,
                    reason: row.get(3)?,
                    distractors: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|err| CommandError::db("查询空格解析", err))
    })?;

    Ok(row.map(|row| BlankAnalysis {
        blank_no: row.blank_no,
        answer_key: row.answer_key,
        answer_word: row.answer_word,
        reason: row.reason,
        distractors: json_value(row.distractors.as_deref()),
    }))
}

/// 句子笔记（未写过 `None`）
pub fn get_sentence_note(db: &Db, sentence_id: i64) -> Result<Option<SentenceNote>, CommandError> {
    db.read(|conn| {
        conn.query_row(
            "SELECT sentence_id, translation, grammar_note, phrase_note, updated_at
             FROM sentence_note WHERE sentence_id = ?1",
            [sentence_id],
            |row| {
                Ok(SentenceNote {
                    sentence_id: row.get(0)?,
                    translation: row.get(1)?,
                    grammar_note: row.get(2)?,
                    phrase_note: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|err| CommandError::db("查询句子笔记", err))
    })
}

/// 词笔记（未写过 `None`）
pub fn get_word_note(db: &Db, token_id: i64) -> Result<Option<WordNote>, CommandError> {
    db.read(|conn| {
        conn.query_row(
            "SELECT token_id, context_meaning, collocation, example, updated_at
             FROM word_note WHERE token_id = ?1",
            [token_id],
            |row| {
                Ok(WordNote {
                    token_id: row.get(0)?,
                    context_meaning: row.get(1)?,
                    collocation: row.get(2)?,
                    example: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|err| CommandError::db("查询词笔记", err))
    })
}

/// 本篇笔记标记：有笔记的 `sentence.id` / `token.id` 两组集合（TP-修复1 F4 / AC-R3）。
///
/// 两条查询走 `sentence_note.sentence_id` / `word_note.token_id` 的 UNIQUE 索引 + `token(sentence_id)` 索引；
/// 空库/无笔记篇返回两空数组（不是 `None`——「没有标记」是正常状态，前端不必区分）。
///
/// ponytail: 一次拉全篇两个 id 数组，不返回笔记正文、不分页、不做增量 diff——单篇笔记量级是「几十到几百」，
/// 一次 IPC 足够（AC-R3 明确要求「一次」）。天花板：某篇笔记上万时这一次响应会变大，届时按 `LIMIT` + 游标拆批，
/// 而不是现在就上增量协议。
pub fn get_article_note_marks(db: &Db, article_id: i64) -> Result<NoteMarks, CommandError> {
    db.read(|conn| {
        let sentence_ids = {
            let mut stmt = conn
                .prepare(
                    "SELECT sn.sentence_id FROM sentence_note sn
                       JOIN sentence s ON s.id = sn.sentence_id
                      WHERE s.article_id = ?1
                      ORDER BY sn.sentence_id",
                )
                .map_err(|err| CommandError::db("准备句子笔记标记查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| row.get::<_, i64>(0))
                .map_err(|err| CommandError::db("查询句子笔记标记", err))?;
            rows.collect::<Result<Vec<i64>, _>>()
                .map_err(|err| CommandError::db("收集句子笔记标记", err))?
        };
        let token_ids = {
            let mut stmt = conn
                .prepare(
                    "SELECT wn.token_id FROM word_note wn
                       JOIN token t ON t.id = wn.token_id
                       JOIN sentence s ON s.id = t.sentence_id
                      WHERE s.article_id = ?1
                      ORDER BY wn.token_id",
                )
                .map_err(|err| CommandError::db("准备词笔记标记查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| row.get::<_, i64>(0))
                .map_err(|err| CommandError::db("查询词笔记标记", err))?;
            rows.collect::<Result<Vec<i64>, _>>()
                .map_err(|err| CommandError::db("收集词笔记标记", err))?
        };
        Ok(NoteMarks {
            sentence_ids,
            token_ids,
        })
    })
}

// ───────────────────────────── 笔记写入 ─────────────────────────────

/// 句子笔记 upsert：三栏 TRIM 后全空 → `DELETE`；否则 `INSERT … ON CONFLICT DO UPDATE`
///
/// **`updated_at` 在 001 里是 `NOT NULL` 且无 DEFAULT**，INSERT 分支必须显式给值（02 D1 / 评审 N-6）；
/// UPDATE 分支也要刷新（否则「停止输入 800ms 落库」的时点无法观测）。
pub fn upsert_sentence_note(
    db: &Db,
    sentence_id: i64,
    translation: Option<&str>,
    grammar_note: Option<&str>,
    phrase_note: Option<&str>,
) -> Result<NoteUpsertResult, CommandError> {
    let translation = normalize_note(translation);
    let grammar_note = normalize_note(grammar_note);
    let phrase_note = normalize_note(phrase_note);

    if translation.is_none() && grammar_note.is_none() && phrase_note.is_none() {
        db.write(|tx| {
            tx.execute("DELETE FROM sentence_note WHERE sentence_id = ?1", [sentence_id])
                .map_err(|err| CommandError::db("清空句子笔记", err))?;
            Ok(())
        })?;
        return Ok(NoteUpsertResult {
            deleted: true,
            updated_at: None,
        });
    }

    db.write(|tx| {
        tx.execute(
            "INSERT INTO sentence_note (sentence_id, translation, grammar_note, phrase_note, updated_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(sentence_id) DO UPDATE SET
                 translation = excluded.translation,
                 grammar_note = excluded.grammar_note,
                 phrase_note = excluded.phrase_note,
                 updated_at = datetime('now')",
            params![sentence_id, translation, grammar_note, phrase_note],
        )
        .map_err(|err| CommandError::db("写入句子笔记", err))?;
        let updated_at: String = tx
            .query_row(
                "SELECT updated_at FROM sentence_note WHERE sentence_id = ?1",
                [sentence_id],
                |row| row.get(0),
            )
            .map_err(|err| CommandError::db("读回句子笔记时间", err))?;
        Ok(NoteUpsertResult {
            deleted: false,
            updated_at: Some(updated_at),
        })
    })
}

/// 词笔记 upsert（同构，3 栏：语境义 / 搭配 / 例句）
pub fn upsert_word_note(
    db: &Db,
    token_id: i64,
    context_meaning: Option<&str>,
    collocation: Option<&str>,
    example: Option<&str>,
) -> Result<NoteUpsertResult, CommandError> {
    let context_meaning = normalize_note(context_meaning);
    let collocation = normalize_note(collocation);
    let example = normalize_note(example);

    if context_meaning.is_none() && collocation.is_none() && example.is_none() {
        db.write(|tx| {
            tx.execute("DELETE FROM word_note WHERE token_id = ?1", [token_id])
                .map_err(|err| CommandError::db("清空词笔记", err))?;
            Ok(())
        })?;
        return Ok(NoteUpsertResult {
            deleted: true,
            updated_at: None,
        });
    }

    db.write(|tx| {
        tx.execute(
            "INSERT INTO word_note (token_id, context_meaning, collocation, example, updated_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(token_id) DO UPDATE SET
                 context_meaning = excluded.context_meaning,
                 collocation = excluded.collocation,
                 example = excluded.example,
                 updated_at = datetime('now')",
            params![token_id, context_meaning, collocation, example],
        )
        .map_err(|err| CommandError::db("写入词笔记", err))?;
        let updated_at: String = tx
            .query_row(
                "SELECT updated_at FROM word_note WHERE token_id = ?1",
                [token_id],
                |row| row.get(0),
            )
            .map_err(|err| CommandError::db("读回词笔记时间", err))?;
        Ok(NoteUpsertResult {
            deleted: false,
            updated_at: Some(updated_at),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db(tag: &str) -> (Db, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-analysis-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("建库失败");
        (db, dir)
    }

    /// 最小内容：1 article / 1 paragraph / 1 sentence / 1 token
    fn seed(db: &Db) -> (i64, i64) {
        db.write(|tx| {
            tx.execute(
                "INSERT INTO article (source_key, title, exam_type, visibility) VALUES ('t-1', '测试篇', 'cet4', 'system')",
                [],
            )
            .map_err(|err| CommandError::db("插 article", err))?;
            let article_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO paragraph (article_id, idx, text) VALUES (?1, 0, 'He runs.')",
                [article_id],
            )
            .map_err(|err| CommandError::db("插 paragraph", err))?;
            let paragraph_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset)
                 VALUES (?1, ?2, 0, 'He runs.', 'hash', 0, 8)",
                params![article_id, paragraph_id],
            )
            .map_err(|err| CommandError::db("插 sentence", err))?;
            let sentence_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO token (sentence_id, idx, surface, normalized, start_offset, end_offset, is_word)
                 VALUES (?1, 0, 'runs', 'run', 3, 7, 1)",
                [sentence_id],
            )
            .map_err(|err| CommandError::db("插 token", err))?;
            let token_id = tx.last_insert_rowid();
            Ok((sentence_id, token_id))
        })
        .expect("种子数据失败")
    }

    fn count_rows(db: &Db, table: &str) -> i64 {
        db.read(|conn| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .map_err(|err| CommandError::db("计数", err))
        })
        .expect("计数失败")
    }

    #[test]
    fn sentence_note_upsert_read_and_clear_deletes_row() {
        let (db, dir) = temp_db("sn");
        let (sentence_id, _) = seed(&db);

        assert!(get_sentence_note(&db, sentence_id).expect("读空笔记").is_none());

        let created = upsert_sentence_note(&db, sentence_id, Some("译"), Some("语法"), Some("短语")).expect("首次写入");
        assert!(!created.deleted, "非空写入不应是删除");
        let stamp = created.updated_at.clone().expect("写入应返回 updatedAt");

        let note = get_sentence_note(&db, sentence_id).expect("读回").expect("应有笔记");
        assert_eq!(note.translation.as_deref(), Some("译"));
        assert_eq!(note.grammar_note.as_deref(), Some("语法"));
        assert_eq!(note.phrase_note.as_deref(), Some("短语"));
        assert_eq!(note.updated_at, stamp);

        // datetime('now') 精度到秒：隔 1.1s 才能观测刷新（UPDATE 分支漏写 updated_at 时本条会红）
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let updated = upsert_sentence_note(&db, sentence_id, Some("译2"), None, Some("   ")).expect("二次写入");
        assert!(!updated.deleted);
        assert_ne!(
            updated.updated_at.as_deref(),
            Some(stamp.as_str()),
            "updated_at 应刷新"
        );
        let note2 = get_sentence_note(&db, sentence_id).expect("读回2").expect("应有笔记");
        assert_eq!(note2.translation.as_deref(), Some("译2"));
        assert_eq!(note2.grammar_note, None, "空栏写入后应为 NULL");
        assert_eq!(note2.phrase_note, None, "纯空白串应落成 NULL");

        let cleared = upsert_sentence_note(&db, sentence_id, Some("  "), Some(""), None).expect("清空");
        assert!(cleared.deleted, "三栏全空应删行");
        assert!(cleared.updated_at.is_none(), "删行时无 updatedAt");
        assert!(get_sentence_note(&db, sentence_id).expect("读空2").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn word_note_upsert_read_and_clear_deletes_row() {
        let (db, dir) = temp_db("wn");
        let (_, token_id) = seed(&db);

        assert!(get_word_note(&db, token_id).expect("读空笔记").is_none());

        let created = upsert_word_note(&db, token_id, Some("语境义"), Some("搭配"), Some("例句")).expect("首次写入");
        assert!(!created.deleted);
        let stamp = created.updated_at.clone().expect("应返回 updatedAt");
        let note = get_word_note(&db, token_id).expect("读回").expect("应有笔记");
        assert_eq!(note.context_meaning.as_deref(), Some("语境义"));
        assert_eq!(note.collocation.as_deref(), Some("搭配"));
        assert_eq!(note.example.as_deref(), Some("例句"));

        std::thread::sleep(std::time::Duration::from_millis(1100));
        let updated = upsert_word_note(&db, token_id, Some("语境义2"), None, None).expect("二次写入");
        assert_ne!(updated.updated_at.as_deref(), Some(stamp.as_str()), "updated_at 应刷新");

        let cleared = upsert_word_note(&db, token_id, None, Some(""), Some(" ")).expect("清空");
        assert!(cleared.deleted);
        assert!(get_word_note(&db, token_id).expect("读空2").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn analysis_queries_return_none_without_rows() {
        let (db, dir) = temp_db("none");
        assert!(get_sentence_analysis(&db, 1).expect("查句子解析").is_none());
        assert!(get_token_analysis(&db, 1).expect("查词解析").is_none());
        assert!(lookup_lexicon(&db, "provoke").expect("查词库").is_none());
        assert!(get_blank_analysis(&db, 1, 26).expect("查空格").is_none());
        assert!(get_sentence_note(&db, 1).expect("查句笔记").is_none());
        assert!(get_word_note(&db, 1).expect("查词笔记").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F4（AC-R3）：本篇笔记标记**只**含本篇的句/词（跨篇不串味），清空即消失，空库返回两空数组
    #[test]
    fn article_note_marks_list_only_this_articles_notes() {
        let (db, dir) = temp_db("marks");
        let (sentence_id, token_id) = seed(&db);

        // 第二篇（同构最小种子）：用来证明按 article_id 过滤，而不是「全表扫」
        let (other_sentence, other_token) = db
            .write(|tx| {
                tx.execute(
                    "INSERT INTO article (source_key, title, exam_type, visibility) VALUES ('t-2', '第二篇', 'cet4', 'system')",
                    [],
                )
                .map_err(|err| CommandError::db("插 article2", err))?;
                let article2 = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO paragraph (article_id, idx, text) VALUES (?1, 0, 'She reads.')",
                    [article2],
                )
                .map_err(|err| CommandError::db("插 paragraph2", err))?;
                let paragraph2 = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset)
                     VALUES (?1, ?2, 0, 'She reads.', 'hash2', 0, 10)",
                    params![article2, paragraph2],
                )
                .map_err(|err| CommandError::db("插 sentence2", err))?;
                let sentence2 = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO token (sentence_id, idx, surface, normalized, start_offset, end_offset, is_word)
                     VALUES (?1, 0, 'reads', 'read', 4, 9, 1)",
                    [sentence2],
                )
                .map_err(|err| CommandError::db("插 token2", err))?;
                let token2 = tx.last_insert_rowid();
                Ok((sentence2, token2))
            })
            .expect("第二篇种子失败");

        let empty = get_article_note_marks(&db, 1).expect("查空标记");
        assert!(empty.sentence_ids.is_empty() && empty.token_ids.is_empty(), "空库应返回两空数组");

        upsert_sentence_note(&db, sentence_id, Some("译"), None, None).expect("写句笔记");
        upsert_word_note(&db, token_id, Some("语境义"), None, None).expect("写词笔记");
        upsert_sentence_note(&db, other_sentence, Some("译2"), None, None).expect("写句笔记2");
        upsert_word_note(&db, other_token, Some("语境义2"), None, None).expect("写词笔记2");

        let marks = get_article_note_marks(&db, 1).expect("查第一篇标记");
        assert_eq!(marks.sentence_ids, vec![sentence_id], "第一篇句标记应恰为本篇那条");
        assert_eq!(marks.token_ids, vec![token_id], "第一篇词标记应恰为本篇那条");
        let other = get_article_note_marks(&db, 2).expect("查第二篇标记");
        assert_eq!(other.sentence_ids, vec![other_sentence], "第二篇不得混入第一篇");
        assert_eq!(other.token_ids, vec![other_token]);

        upsert_sentence_note(&db, sentence_id, None, None, None).expect("清句笔记");
        upsert_word_note(&db, token_id, None, None, None).expect("清词笔记");
        let cleared = get_article_note_marks(&db, 1).expect("再查标记");
        assert!(cleared.sentence_ids.is_empty() && cleared.token_ids.is_empty(), "清空笔记后标记应消失");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 红线：写笔记不得碰解析四表与 vocab_entry（AC10）
    #[test]
    fn note_upserts_never_touch_analysis_or_vocab_tables() {
        let (db, dir) = temp_db("redline");
        let (sentence_id, token_id) = seed(&db);
        let tables = ["sentence_analysis", "token_analysis", "lexicon", "blank", "vocab_entry"];
        let before: Vec<i64> = tables.iter().map(|table| count_rows(&db, table)).collect();

        upsert_sentence_note(&db, sentence_id, Some("a"), Some("b"), Some("c")).expect("写句笔记");
        upsert_word_note(&db, token_id, Some("a"), Some("b"), Some("c")).expect("写词笔记");

        let after: Vec<i64> = tables.iter().map(|table| count_rows(&db, table)).collect();
        assert_eq!(before, after, "写笔记不得改变解析四表与 vocab_entry 的行数");
        assert_eq!(count_rows(&db, "vocab_entry"), 0, "M2 不写 vocab_entry（收藏归 M3）");
        std::fs::remove_dir_all(&dir).ok();
    }
}
