// 目录与正文读取（02 §三 D4/D5）：sentenceCount 用落库聚合列；blankNos 从 blank 表取，不依赖前端解析 JSON。

use rusqlite::Connection;

use crate::db::StartupError;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSummary {
    pub source_key: String,
    pub set_no: i64,
    pub title: String,
    pub exam_year: i64,
    pub exam_month: i64,
    pub section: String,
    pub word_count: i64,
    pub sentence_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphDto {
    pub idx: i64,
    pub text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceDto {
    pub para_idx: i64,
    pub idx: i64,
    pub start: i64,
    pub end: i64,
    pub text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDto {
    pub para_idx: i64,
    pub sent_idx: i64,
    pub idx: i64,
    pub start: i64,
    pub end: i64,
    pub surface: String,
    pub normalized: Option<String>,
    pub is_word: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleContent {
    pub article: ArticleSummary,
    pub paragraphs: Vec<ParagraphDto>,
    pub sentences: Vec<SentenceDto>,
    pub tokens: Vec<TokenDto>,
    pub blank_nos: Vec<i64>,
}

const SUMMARY_COLUMNS: &str =
    "sourceKey, setNo, title, examYear, examMonth, section, wordCount, sentenceCount";

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArticleSummary> {
    Ok(ArticleSummary {
        source_key: row.get(0)?,
        set_no: row.get(1)?,
        title: row.get(2)?,
        exam_year: row.get(3)?,
        exam_month: row.get(4)?,
        section: row.get(5)?,
        word_count: row.get(6)?,
        sentence_count: row.get(7)?,
    })
}

/// 三套分组顺序：套号 → 题型（仔细阅读 0 / 长篇阅读 1 / 选词填空 2）→ sourceKey。
pub fn list_articles(conn: &Connection) -> Result<Vec<ArticleSummary>, StartupError> {
    let sql = format!(
        "SELECT {SUMMARY_COLUMNS} FROM article ORDER BY setNo,
           CASE section WHEN '仔细阅读' THEN 0 WHEN '长篇阅读' THEN 1 WHEN '选词填空' THEN 2 ELSE 3 END,
           sourceKey"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], summary_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_article_content(conn: &Connection, source_key: &str) -> Result<ArticleContent, StartupError> {
    let sql = format!("SELECT {SUMMARY_COLUMNS} FROM article WHERE sourceKey = ?1");
    let article = conn
        .query_row(&sql, [source_key], summary_from_row)
        .map_err(|_| StartupError::Db { message: format!("篇目不存在：{source_key}") })?;

    let mut stmt = conn.prepare("SELECT idx, text FROM paragraph WHERE articleKey = ?1 ORDER BY idx")?;
    let paragraphs = stmt
        .query_map([source_key], |row| Ok(ParagraphDto { idx: row.get(0)?, text: row.get(1)? }))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT paraIdx, idx, start, \"end\", text FROM sentence WHERE articleKey = ?1 ORDER BY paraIdx, idx",
    )?;
    let sentences = stmt
        .query_map([source_key], |row| {
            Ok(SentenceDto { para_idx: row.get(0)?, idx: row.get(1)?, start: row.get(2)?, end: row.get(3)?, text: row.get(4)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT paraIdx, sentIdx, idx, start, \"end\", surface, normalized, isWord FROM token
         WHERE articleKey = ?1 ORDER BY paraIdx, sentIdx, idx",
    )?;
    let tokens = stmt
        .query_map([source_key], |row| {
            Ok(TokenDto {
                para_idx: row.get(0)?,
                sent_idx: row.get(1)?,
                idx: row.get(2)?,
                start: row.get(3)?,
                end: row.get(4)?,
                surface: row.get(5)?,
                normalized: row.get(6)?,
                is_word: row.get::<_, i64>(7)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare("SELECT no FROM blank WHERE articleKey = ?1 ORDER BY no")?;
    let blank_nos = stmt.query_map([source_key], |row| row.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;

    Ok(ArticleContent { article, paragraphs, sentences, tokens, blank_nos })
}
