// 内容导入（02 §三 D3）：manifest 为唯一版本权威；版本未变不做任何写入；
// 版本变化时单事务逐篇 upsert（只更新内容字段，绝不覆盖用户数据表）。

use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::db::StartupError;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u32,
    pub updated: u32,
    pub skipped: u32,
    pub pack_version: String,
    pub elapsed_ms: u64,
    /// 启动期数据库损坏重建后的备份文件名（正常为 None，由命令层补充）。
    pub db_rebuilt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    pack_version: String,
    articles: Vec<ManifestArticle>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestArticle {
    source_key: String,
    file: String,
    #[allow(dead_code)]
    content_hash: String,
    #[allow(dead_code)]
    sentence_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pack {
    article_id: String,
    meta: Meta,
    paragraphs: Vec<Para>,
    #[serde(default)]
    questions: Vec<Question>,
    #[serde(default)]
    blank_nos: Vec<i64>,
    #[serde(default)]
    blanks: serde_json::Value,
    #[serde(default)]
    lexicon: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    exam_year: i64,
    exam_month: i64,
    set_no: i64,
    section: String,
    passage_label: String,
    title: String,
    word_count: i64,
}

#[derive(Debug, Deserialize)]
struct Para {
    idx: i64,
    text: String,
    sentences: Vec<Sent>,
}

#[derive(Debug, Deserialize)]
struct Sent {
    idx: i64,
    start: i64,
    end: i64,
    text: String,
    tokens: Vec<Tok>,
    #[serde(default)]
    analysis: Option<Analysis>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tok {
    start: i64,
    end: i64,
    surface: String,
    normalized: Option<String>,
    is_word: bool,
    #[serde(default)]
    analysis: Option<TokAnalysis>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokAnalysis {
    phonetic: Option<String>,
    pos: Option<String>,
    sense_in_context: Option<String>,
    collocations: Option<serde_json::Value>,
    examples: Option<serde_json::Value>,
    is_cet4_high_freq: Option<bool>,
    more: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Analysis {
    translation_literal: Option<String>,
    translation_natural: Option<String>,
    struct_markup: Option<String>,
    structure_summary: Option<String>,
    paragraph_role: Option<String>,
    components: Option<serde_json::Value>,
    clauses: Option<serde_json::Value>,
    phrases: Option<serde_json::Value>,
    pitfalls: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Question {
    no: i64,
    stem: String,
    options: serde_json::Value,
    answer: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlankEntry {
    answer_key: Option<String>,
    answer_word: Option<String>,
    reason: Option<String>,
    distractors: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LexEntry {
    phonetic: Option<String>,
    pos: Option<String>,
    sense: Option<String>,
    lemma: Option<String>,
    collocations: Option<serde_json::Value>,
    examples: Option<serde_json::Value>,
    is_cet4_high_freq: Option<bool>,
    more: Option<serde_json::Value>,
}

fn json_opt(v: &Option<serde_json::Value>) -> Option<String> {
    v.as_ref().map(|x| x.to_string())
}

fn read_pack_version(conn: &Connection) -> Result<Option<String>, StartupError> {
    Ok(conn
        .query_row("SELECT value FROM app_meta WHERE key = 'packVersion'", [], |r| r.get::<_, String>(0))
        .optional()?)
}

/// 导入主流程（测试与命令层共用；schema 由 db::open_or_recreate 保证）。
pub fn run_import(conn: &mut Connection, pack_dir: &Path) -> Result<ImportReport, StartupError> {
    let started = Instant::now();

    // 1. 读 manifest：缺失/解析失败必须返回可见错误，不 panic、不静默继续（D3 规则 1）。
    let manifest_path = pack_dir.join("manifest.json");
    let manifest_display = manifest_path.display().to_string();
    if !manifest_path.exists() {
        return Err(StartupError::PackMissing { file: manifest_display });
    }
    let manifest_text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| StartupError::PackCorrupt { file: manifest_display.clone(), detail: e.to_string() })?;
    let manifest: Manifest = serde_json::from_str(&manifest_text)
        .map_err(|e| StartupError::PackCorrupt { file: manifest_display.clone(), detail: e.to_string() })?;
    if manifest.articles.is_empty() {
        return Err(StartupError::PackInvalid { file: manifest_display, detail: "articles 为空".to_string() });
    }

    // 2. 版本一致：直接返回 skipped，不做任何写入（05 §二 规则 1 / AC3）。
    let current = read_pack_version(conn)?;
    if current.as_deref() == Some(manifest.pack_version.as_str()) {
        let elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(ImportReport {
            imported: 0,
            updated: 0,
            skipped: manifest.articles.len() as u32,
            pack_version: manifest.pack_version,
            elapsed_ms,
            db_rebuilt: None,
        });
    }

    // 3. 事务前先把 12 篇全部读入并解析：任何一篇缺失/损坏都在写库前返回可见错误。
    let mut packs: Vec<(ManifestArticle, Pack)> = Vec::with_capacity(manifest.articles.len());
    for article in &manifest.articles {
        let path = pack_dir.join(&article.file);
        if !path.exists() {
            return Err(StartupError::PackMissing { file: path.display().to_string() });
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|e| StartupError::PackCorrupt { file: article.file.clone(), detail: e.to_string() })?;
        let pack: Pack = serde_json::from_str(&text)
            .map_err(|e| StartupError::PackCorrupt { file: article.file.clone(), detail: e.to_string() })?;
        packs.push((article.clone(), pack));
    }

    // 4. 单事务逐篇 upsert；失败回滚，旧版本仍可用。
    let tx = conn.transaction()?;
    let mut imported = 0u32;
    let mut updated = 0u32;
    for (article, pack) in &packs {
        let exists: bool = tx
            .query_row("SELECT 1 FROM article WHERE sourceKey = ?1", [&article.source_key], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if exists {
            updated += 1;
        } else {
            imported += 1;
        }
        write_article(&tx, article, pack, &manifest.pack_version)?;
    }
    tx.execute(
        "INSERT INTO app_meta(key, value) VALUES ('packVersion', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&manifest.pack_version],
    )?;
    tx.commit()?;

    Ok(ImportReport {
        imported,
        updated,
        skipped: 0,
        pack_version: manifest.pack_version,
        elapsed_ms: started.elapsed().as_millis() as u64,
        db_rebuilt: None,
    })
}

fn write_article(
    tx: &rusqlite::Transaction<'_>,
    article: &ManifestArticle,
    pack: &Pack,
    pack_version: &str,
) -> Result<(), StartupError> {
    let key = &article.source_key;
    let sentence_count: i64 = pack.paragraphs.iter().map(|p| p.sentences.len() as i64).sum();

    tx.execute(
        "INSERT INTO article (sourceKey, articleId, setNo, section, passageLabel, title, examYear, examMonth, wordCount, sentenceCount, packVersion, contentHash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(sourceKey) DO UPDATE SET
           articleId = excluded.articleId, setNo = excluded.setNo, section = excluded.section,
           passageLabel = excluded.passageLabel, title = excluded.title, examYear = excluded.examYear,
           examMonth = excluded.examMonth, wordCount = excluded.wordCount,
           sentenceCount = excluded.sentenceCount, packVersion = excluded.packVersion,
           contentHash = excluded.contentHash",
        params![
            key,
            &pack.article_id,
            pack.meta.set_no,
            &pack.meta.section,
            &pack.meta.passage_label,
            &pack.meta.title,
            pack.meta.exam_year,
            pack.meta.exam_month,
            pack.meta.word_count,
            sentence_count,
            pack_version,
            &article.content_hash,
        ],
    )?;

    // 内容字段整体替换（仅本包内容表；note/vocab/progress 不存在也不触碰）。
    for table in ["paragraph", "sentence", "token", "sentence_analysis", "token_analysis", "question", "blank"] {
        tx.execute(&format!("DELETE FROM {table} WHERE articleKey = ?1"), [key])?;
    }

    {
        let mut stmt = tx.prepare("INSERT INTO paragraph (articleKey, idx, text) VALUES (?1, ?2, ?3)")?;
        for para in &pack.paragraphs {
            stmt.execute(params![key, para.idx, &para.text])?;
        }
    }

    {
        let mut stmt_sentence =
            tx.prepare("INSERT INTO sentence (articleKey, paraIdx, idx, start, \"end\", text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        let mut stmt_token = tx.prepare(
            "INSERT INTO token (articleKey, paraIdx, sentIdx, idx, start, \"end\", surface, normalized, isWord)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        let mut stmt_sentence_analysis = tx.prepare(
            "INSERT INTO sentence_analysis (articleKey, paraIdx, sentIdx, translationLiteral, translationNatural, structMarkup, structureSummary, paragraphRole, components, clauses, phrases, pitfalls)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        let mut stmt_token_analysis = tx.prepare(
            "INSERT INTO token_analysis (articleKey, paraIdx, sentIdx, idx, phonetic, pos, senseInContext, collocations, examples, isCet4HighFreq, more)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;

        for para in &pack.paragraphs {
            for sent in &para.sentences {
                stmt_sentence.execute(params![key, para.idx, sent.idx, sent.start, sent.end, &sent.text])?;
                if let Some(a) = &sent.analysis {
                    stmt_sentence_analysis.execute(params![
                        key,
                        para.idx,
                        sent.idx,
                        &a.translation_literal,
                        &a.translation_natural,
                        &a.struct_markup,
                        &a.structure_summary,
                        &a.paragraph_role,
                        json_opt(&a.components),
                        json_opt(&a.clauses),
                        json_opt(&a.phrases),
                        json_opt(&a.pitfalls),
                    ])?;
                }
                for (token_idx, token) in sent.tokens.iter().enumerate() {
                    stmt_token.execute(params![
                        key,
                        para.idx,
                        sent.idx,
                        token_idx as i64,
                        token.start,
                        token.end,
                        &token.surface,
                        &token.normalized,
                        token.is_word as i64,
                    ])?;
                    if let Some(a) = &token.analysis {
                        stmt_token_analysis.execute(params![
                            key,
                            para.idx,
                            sent.idx,
                            token_idx as i64,
                            &a.phonetic,
                            &a.pos,
                            &a.sense_in_context,
                            json_opt(&a.collocations),
                            json_opt(&a.examples),
                            a.is_cet4_high_freq.unwrap_or(false) as i64,
                            json_opt(&a.more),
                        ])?;
                    }
                }
            }
        }
    }

    {
        let mut stmt = tx.prepare("INSERT INTO question (articleKey, no, stem, options, answer) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for q in &pack.questions {
            stmt.execute(params![key, q.no, &q.stem, q.options.to_string(), &q.answer])?;
        }
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO blank (articleKey, no, answerKey, answerWord, reason, distractors) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        let mut blank_rows: Vec<(i64, BlankEntry)> = Vec::new();
        if let Some(obj) = pack.blanks.as_object() {
            for (k, v) in obj {
                let no: i64 = k.parse().map_err(|_| StartupError::PackInvalid {
                    file: article.file.clone(),
                    detail: format!("blanks 的键 {k} 不是空号"),
                })?;
                let entry: BlankEntry = serde_json::from_value(v.clone()).map_err(|e| StartupError::PackInvalid {
                    file: article.file.clone(),
                    detail: format!("blanks[{k}] 字段异常：{e}"),
                })?;
                blank_rows.push((no, entry));
            }
        }
        if !pack.blank_nos.is_empty() {
            let mut declared = pack.blank_nos.clone();
            declared.sort_unstable();
            let mut actual: Vec<i64> = blank_rows.iter().map(|(no, _)| *no).collect();
            actual.sort_unstable();
            if declared != actual {
                return Err(StartupError::PackInvalid {
                    file: article.file.clone(),
                    detail: format!("blankNos {declared:?} 与 blanks 键 {actual:?} 不一致"),
                });
            }
        }
        for (no, entry) in &blank_rows {
            stmt.execute(params![
                key,
                no,
                &entry.answer_key,
                &entry.answer_word,
                &entry.reason,
                entry.distractors.as_ref().map(|v| v.to_string()),
            ])?;
        }
    }

    // 全局词库：按篇切片合并去重（word 主键 upsert）。
    if let Some(obj) = pack.lexicon.as_object() {
        let mut stmt = tx.prepare(
            "INSERT INTO lexicon (word, phonetic, pos, sense, lemma, collocations, examples, isCet4HighFreq, more)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(word) DO UPDATE SET
               phonetic = excluded.phonetic, pos = excluded.pos, sense = excluded.sense,
               lemma = excluded.lemma, collocations = excluded.collocations, examples = excluded.examples,
               isCet4HighFreq = excluded.isCet4HighFreq, more = excluded.more",
        )?;
        for (word, value) in obj {
            let entry: LexEntry = serde_json::from_value(value.clone()).map_err(|e| StartupError::PackInvalid {
                file: article.file.clone(),
                detail: format!("lexicon[{word}] 字段异常：{e}"),
            })?;
            stmt.execute(params![
                word,
                &entry.phonetic,
                &entry.pos,
                &entry.sense,
                &entry.lemma,
                json_opt(&entry.collocations),
                json_opt(&entry.examples),
                entry.is_cet4_high_freq.unwrap_or(false) as i64,
                json_opt(&entry.more),
            ])?;
        }
    }

    Ok(())
}
