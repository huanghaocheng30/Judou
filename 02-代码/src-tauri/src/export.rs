//! M6 · 导出与备份（D1）——生词自包含 HTML / 库备份 / 库恢复。
//!
//! 三条红线（02 契约 §三.2 / §三.3）：
//! - **HTML 自包含**：全部样式写 `<style>`，不允许 `<link rel="stylesheet">`、`<script src=`、`http(s)://` 外链；
//! - **恢复先备份**：写 `*-pre-restore-YYYYMMDD-HHmm.db` → 校验源 → 临时副本校验计数 → 覆盖；
//! - **失败不破坏现库**：覆盖前任何一步失败直接返回错误（现库未动）；覆盖中途失败用 pre-restore 备份回滚。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::commands::CommandError;
use crate::db::Db;

/// `export_vocab_html` 返回体（AC5）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub count: i64,
    pub bytes: u64,
}

/// `backup_db` 返回体（AC6）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub db_path: String,
    pub meta_path: String,
    pub schema_version: i64,
    /// 各表行数（键 = 表名），JSON 元信息里同一份。
    pub tables: Vec<TableCount>,
}

/// `restore_db` 返回体（AC7）：恢复后各表计数 + 与恢复前的差异（空 = 完全一致）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_from: String,
    pub pre_backup_path: String,
    pub tables: Vec<TableCount>,
    pub diff: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub name: String,
    pub rows: i64,
}

/// 一条待导出的生词（含搭配/例句/来源句/标签，AC5）。
struct VocabRow {
    surface: String,
    phonetic: Option<String>,
    pos: Option<String>,
    context_meaning: Option<String>,
    /// 词典释义（`lexicon.sense`，按 `normalized` join）——释义回退链第二档
    sense: Option<String>,
    collocation: Option<String>,
    example: Option<String>,
    source_sentence: Option<String>,
    source_title: Option<String>,
    tags: Option<String>,
}

/// 生词导出为**自包含 HTML**：内联 CSS、无外链、打印一页一卡。
pub fn export_vocab_html(db: &Db, out_path: &Path) -> Result<ExportResult, CommandError> {
    let rows = db.read(read_vocab_rows)?;
    let html = render_vocab_html(&rows, &stamp_now());
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| CommandError::db_io("创建导出目录", err))?;
    }
    std::fs::write(out_path, html.as_bytes()).map_err(|err| CommandError::db_io("写入生词导出文件", err))?;
    let bytes = std::fs::metadata(out_path)
        .map(|meta| meta.len())
        .unwrap_or(html.len() as u64);
    Ok(ExportResult {
        path: out_path.to_string_lossy().to_string(),
        count: rows.len() as i64,
        bytes,
    })
}

// ───────────────────── M6 第四轮 · PDF 词表（三模式 / 乱序 / A4 双栏打印） ─────────────────────

/// PDF 词表三种模式（互斥单选）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheetMode {
    /// A4 默写：左栏只放 Word、右栏只放 Meaning，**各自独立编号**（遮一半即可双向默写）
    A4,
    /// 中文词表：Word 列留空（带勾选框），Meaning 填释义 → 看中文默写单词
    Zh,
    /// 英文词表：Word 填单词（带勾选框），Meaning 留空 → 看单词默写释义
    En,
}

impl SheetMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SheetMode::A4 => "a4",
            SheetMode::Zh => "zh",
            SheetMode::En => "en",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SheetMode::A4 => "A4 默写",
            SheetMode::Zh => "中文词表",
            SheetMode::En => "英文词表",
        }
    }

    /// 前端 `data-export-mode` 的三值；非法值由调用方拒收。
    pub fn from_arg(raw: &str) -> Option<Self> {
        match raw {
            "a4" => Some(SheetMode::A4),
            "zh" => Some(SheetMode::Zh),
            "en" => Some(SheetMode::En),
            _ => None,
        }
    }
}

/// 每栏行数：A4 竖版 12mm 边距下约 15 行，双栏并排 → 30 行/页（A4 默写每页 15 词）。
const SHEET_ROWS_PER_COL: usize = 15;

/// 生词导出为 **PDF 词表 HTML**：返回完整 HTML 字符串，由前端用隐藏 iframe 触发系统打印
/// （Windows 选「Microsoft Print to PDF」/「另存为 PDF」即得真 PDF）。
///
/// 为什么返回字符串而不是写文件：Tauri webview 里 `window.open` 会被拦，隐藏 iframe 的
/// `contentWindow.print()` 是唯一无需新依赖的打印通道；HTML 只在内存里过一次手。
pub fn export_vocab_sheet(db: &Db, mode: &str, shuffle: bool, with_answer: bool) -> Result<String, CommandError> {
    let mode = SheetMode::from_arg(mode).ok_or_else(|| CommandError {
        code: "EXPORT_MODE_INVALID".to_string(),
        message: format!("导出模式只能是 a4 / zh / en，当前是「{mode}」。"),
        path: Some("mode".to_string()),
    })?;
    let mut rows = db.read(read_vocab_rows)?;
    if shuffle {
        shuffle_rows(&mut rows, seed_now());
    }
    Ok(render_vocab_sheet(&rows, mode, shuffle, with_answer))
}

/// 释义回退链（第五轮）：用户手填的「本句意思」优先 → 没有则回退词典释义 `lexicon.sense` → 都没有返回 `None`。
///
/// 为什么必须回退：`context_meaning` 是用户手填字段，实测经常为 NULL（9 个词里只有 1 个有值），
/// 只取它会让导出的词表在「释义」列大片留空，教学上无意义。
fn meaning_text(row: &VocabRow) -> Option<&str> {
    fn clean(value: Option<&str>) -> Option<&str> {
        value.map(str::trim).filter(|text| !text.is_empty())
    }
    clean(row.context_meaning.as_deref()).or_else(|| clean(row.sense.as_deref()))
}

/// 乱序：Fisher-Yates + 线性同余伪随机（**不引新 crate**；seed 入参便于单测可复现）。
fn shuffle_rows(rows: &mut [VocabRow], mut state: u64) {
    if rows.len() < 2 {
        return;
    }
    for i in (1..rows.len()).rev() {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let j = ((state >> 33) as usize) % (i + 1);
        rows.swap(i, j);
    }
}

fn seed_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15)
}

/// 一页里的一个表格：`columns` 决定表头与每行单元格。
enum SheetColumns {
    /// `# | □ | Word` 或 `# | □ | Meaning`（A4 默写，左右各一）
    Single(&'static str),
    /// `# | □ | Word | Meaning`（中文/英文词表，成对出现）
    Pair,
}

/// 渲染一整份词表 HTML（无外链、内联 CSS、每页重复表头）。
fn render_vocab_sheet(rows: &[VocabRow], mode: SheetMode, shuffle: bool, with_answer: bool) -> String {
    let total = rows.len();
    // A4 默写：左右是同一批词的两种视图 → 每页 15 词；中文/英文：每页双栏共 30 词
    let words_per_page = match mode {
        SheetMode::A4 => SHEET_ROWS_PER_COL,
        SheetMode::Zh | SheetMode::En => SHEET_ROWS_PER_COL * 2,
    };
    let page_count = if total == 0 { 1 } else { total.div_ceil(words_per_page) };

    let mut pages = String::new();
    for page in 0..page_count {
        let start = page * words_per_page;
        let end = (start + words_per_page).min(total);
        let page_rows = rows.get(start..end).unwrap_or(&[]);
        pages.push_str(&render_sheet_page(
            page_rows,
            mode,
            shuffle,
            total,
            page + 1,
            page_count,
            page * words_per_page,
            with_answer,
        ));
    }

    format!(
        "<!doctype html>
<html lang=\"zh-CN\">
<head>
<meta charset=\"utf-8\" />
<title>句读 · 生词{title}（{total} 词）</title>
<style>{css}</style>
</head>
<body>
{pages}</body>
</html>
",
        title = mode.label(),
        total = total,
        css = SHEET_CSS,
        pages = pages,
    )
}

/// 单页：标题行 + 「共 N 词 M 页」+ 双栏（每栏自带 `<thead>` 表头，打印时每页重复）。
#[allow(clippy::too_many_arguments)]
fn render_sheet_page(
    page_rows: &[VocabRow],
    mode: SheetMode,
    shuffle: bool,
    total: usize,
    page_no: usize,
    page_count: usize,
    offset: usize,
    with_answer: bool,
) -> String {
    let (left, right, left_cols, right_cols) = match mode {
        // 左右同批词、各自独立编号（都从本页第一个词号起算）
        SheetMode::A4 => (page_rows, page_rows, SheetColumns::Single("Word"), SheetColumns::Single("Meaning")),
        // 左右是连续两段词，编号贯穿全表
        SheetMode::Zh | SheetMode::En => {
            let split = (page_rows.len().min(SHEET_ROWS_PER_COL)).min(page_rows.len());
            (&page_rows[..split], &page_rows[split..], SheetColumns::Pair, SheetColumns::Pair)
        }
    };

    let mut html = String::new();
    html.push_str(&format!(
        "<section class=\"sheet-page\" data-export-mode=\"{mode}\">
<header class=\"sheet-head\">
  <h1 class=\"sheet-title\">生词词表 · {label}</h1>
  <p class=\"sheet-meta\">共 {total} 词 {page_count} 页 · 第 {page_no} 页 / {page_count} 页{shuffled}</p>
</header>
<div class=\"sheet-cols\">
",
        mode = mode.as_str(),
        label = mode.label(),
        total = total,
        page_count = page_count,
        page_no = page_no,
        shuffled = if shuffle { " · 乱序" } else { "" },
    ));
    html.push_str(&render_sheet_col(left, mode, &left_cols, "left", offset));
    // A4 右侧是同一批词的释义视图，各自独立编号 → 也从本页第一个词号起算
    let right_offset = match mode {
        SheetMode::A4 => offset,
        SheetMode::Zh | SheetMode::En => offset + left.len(),
    };
    html.push_str(&render_sheet_col(right, mode, &right_cols, "right", right_offset));
    html.push_str("</div>\n");
    // 第五轮：A4 默写补「答案对照」——左栏只 Word、右栏只 Meaning 时，学生写完要能自查；
    // 一节一页（行数 = 本页词数），小字号两列对照，可折起。
    if with_answer && mode == SheetMode::A4 {
        html.push_str(&render_sheet_answer(page_rows, offset));
    }
    html.push_str("</section>\n");
    html
}

/// A4 附录「答案对照」：`Word —— 释义` 逐行对照，行数 = 本页词数。
fn render_sheet_answer(page_rows: &[VocabRow], offset: usize) -> String {
    let mut items = String::new();
    for (index, row) in page_rows.iter().enumerate() {
        let no = offset + index + 1;
        let meaning = meaning_text(row).unwrap_or("");
        items.push_str(&format!(
            "<li class=\"answer-row\" data-answer-no=\"{no}\"><span class=\"answer-word\">{}</span><span class=\"answer-sep\"> —— </span><span class=\"answer-sense\">{}</span></li>\n",
            esc(&row.surface),
            esc(meaning),
        ));
    }
    format!(
        "<section class=\"sheet-answer\" data-sheet-answer>
<h2 class=\"sheet-answer-title\">答案对照（自查用，可折起）</h2>
<ol class=\"sheet-answer-list\">
{items}</ol>
</section>
"
    )
}

fn render_sheet_col(
    rows: &[VocabRow],
    mode: SheetMode,
    columns: &SheetColumns,
    side: &str,
    offset: usize,
) -> String {
    let data_col = match (mode, columns, side) {
        (SheetMode::A4, _, "left") => "word",
        (SheetMode::A4, _, _) => "meaning",
        (_, _, "left") => "pair-1",
        (_, _, _) => "pair-2",
    };
    let head = match columns {
        SheetColumns::Single(title) => {
            format!("<thead><tr><th class=\"no\">#</th><th class=\"tick\"></th><th>{title}</th></tr></thead>")
        }
        SheetColumns::Pair => "<thead><tr><th class=\"no\">#</th><th class=\"tick\"></th><th>Word</th><th>Meaning</th></tr></thead>".to_string(),
    };
    let mut body = String::new();
    for (index, row) in rows.iter().enumerate() {
        let no = offset + index + 1;
        // 第五轮：释义走回退链（本句意思 → 词典释义），三种模式共用同一口径
        let meaning = meaning_text(row).unwrap_or("");
        let cells = match mode {
            // A4 默写：左栏只 Word、右栏只 Meaning（各自独立编号，遮一半即可默写）
            SheetMode::A4 => match side {
                "left" => sheet_cell(Some(&row.surface)),
                _ => sheet_cell(Some(meaning)),
            },
            // 中文词表：Word 留空；英文词表：Meaning 留空
            SheetMode::Zh => format!("{}{}", sheet_cell(None), sheet_cell(Some(meaning))),
            SheetMode::En => format!("{}{}", sheet_cell(Some(&row.surface)), sheet_cell(None)),
        };
        body.push_str(&format!(
            "<tr data-no=\"{no}\"><td class=\"no\">{no}</td><td class=\"tick\"><span class=\"tick-box\"></span></td>{cells}</tr>\n"
        ));
    }
    format!(
        "<section class=\"sheet-col\" data-col=\"{data_col}\">
<table class=\"sheet-table\">
{head}
<tbody>
{body}</tbody>
</table>
</section>
"
    )
}

/// 一个内容单元格：无内容时打 `data-empty="1"`（门禁据此断言「该列留空」）。
fn sheet_cell(text: Option<&str>) -> String {
    match text.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => format!("<td class=\"cell\">{}</td>", esc(value)),
        None => "<td class=\"cell\" data-empty=\"1\"></td>".to_string(),
    }
}

/// A4 竖版打印样式：内联、无外链、浅色底纹（`print-color-adjust: exact` 保留 Z 字条纹）。
const SHEET_CSS: &str = r#"
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif; color: #1f2328; }
.sheet-page { padding: 4mm 0; }
.sheet-page + .sheet-page { break-before: page; page-break-before: always; }
.sheet-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm;
  border-bottom: 1.2pt solid #1f2328; padding-bottom: 2mm; margin-bottom: 3mm; }
.sheet-title { font-size: 16pt; margin: 0; letter-spacing: 0.4pt; }
.sheet-meta { font-size: 9pt; color: #57606a; margin: 0; }
.sheet-cols { display: table; width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 6mm 0; }
.sheet-col { display: table-cell; width: 50%; vertical-align: top; }
.sheet-table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
.sheet-table th, .sheet-table td { border: 0.6pt solid #c9d1d9; padding: 2.2mm 2mm; text-align: left; }
.sheet-table thead th { background: #eef1f5; font-weight: 600; font-size: 9.5pt; }
.sheet-table tbody tr:nth-child(even) td { background: #f7f8fa; }
.sheet-table td.no, .sheet-table th.no { width: 8mm; text-align: right; color: #57606a; font-size: 9pt; }
.sheet-table td.tick, .sheet-table th.tick { width: 6mm; text-align: center; }
.tick-box { display: inline-block; width: 3.6mm; height: 3.6mm; border: 0.8pt solid #8b949e; border-radius: 0.6mm; }
.sheet-answer { margin-top: 5mm; border-top: 0.8pt dashed #c9d1d9; padding-top: 2mm; }
.sheet-answer-title { font-size: 9pt; color: #57606a; margin: 0 0 1.5mm; font-weight: 600; }
.sheet-answer-list { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 8mm; font-size: 8.5pt; color: #1f2328; }
.answer-row { padding: 0.6mm 0; break-inside: avoid; }
.answer-word { font-weight: 600; }
.answer-sense { color: #3b434c; }
@media print {
  .sheet-page { padding: 0; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .no-print { display: none; }
}
"#;

/// 生词查询：搭配/例句来自 `word_note`（同来源句 + 同 normalized 的最近一条），标签聚合自 `vocab_tag`。
fn read_vocab_rows(conn: &Connection) -> Result<Vec<VocabRow>, CommandError> {    let mut stmt = conn
        .prepare(
            "SELECT v.surface, v.phonetic, v.pos, v.context_meaning,
                    (SELECT wn.collocation FROM word_note wn
                       JOIN token t ON t.id = wn.token_id
                      WHERE t.sentence_id = v.source_sentence_id AND t.normalized = v.normalized
                      ORDER BY wn.updated_at DESC LIMIT 1),
                    (SELECT wn.example FROM word_note wn
                       JOIN token t ON t.id = wn.token_id
                      WHERE t.sentence_id = v.source_sentence_id AND t.normalized = v.normalized
                      ORDER BY wn.updated_at DESC LIMIT 1),
                    s.text, a.title,
                    (SELECT group_concat(tg.name, ' / ') FROM vocab_tag vt
                       JOIN tag tg ON tg.id = vt.tag_id WHERE vt.vocab_id = v.id),
                    lx.sense
               FROM vocab_entry v
               LEFT JOIN sentence s ON s.id = v.source_sentence_id
               LEFT JOIN article a ON a.id = v.source_article_id
               LEFT JOIN lexicon lx ON lx.normalized = v.normalized
              ORDER BY v.created_at DESC, v.id DESC",
        )
        .map_err(|err| CommandError::db("准备生词导出查询", err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(VocabRow {
                surface: row.get(0)?,
                phonetic: row.get(1)?,
                pos: row.get(2)?,
                context_meaning: row.get(3)?,
                sense: row.get(9)?,
                collocation: row.get(4)?,
                example: row.get(5)?,
                source_sentence: row.get(6)?,
                source_title: row.get(7)?,
                tags: row.get(8)?,
            })
        })
        .map_err(|err| CommandError::db("读取生词导出数据", err))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| CommandError::db("读取生词导出数据", err))?);
    }
    Ok(out)
}

/// HTML 转义（导出文本含用户内容，必须转义后再拼）。
fn esc(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 8);
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// 自包含模板：**只有 `<style>`，没有外链**（AC5 门禁会解析断言）。
fn render_vocab_html(rows: &[VocabRow], stamp: &str) -> String {
    let mut cards = String::new();
    if rows.is_empty() {
        cards.push_str("<p class=\"empty\">还没有生词。在精读页点单词把它加进生词本，再来导出。</p>\n");
    }
    for (index, row) in rows.iter().enumerate() {
        let mut meta = String::new();
        if let Some(phonetic) = row.phonetic.as_deref().filter(|v| !v.is_empty()) {
            meta.push_str(&format!("<span class=\"phonetic\">/{}/</span>", esc(phonetic)));
        }
        if let Some(pos) = row.pos.as_deref().filter(|v| !v.is_empty()) {
            meta.push_str(&format!("<span class=\"pos\">{}</span>", esc(pos)));
        }
        let mut body = String::new();
        let section = |label: &str, value: Option<&str>| -> String {
            match value.map(str::trim).filter(|v| !v.is_empty()) {
                Some(text) => format!(
                    "<p class=\"row\"><span class=\"label\">{label}</span><span class=\"value\">{}</span></p>\n",
                    esc(text)
                ),
                None => String::new(),
            }
        };
        body.push_str(&section("释义", meaning_text(row)));
        body.push_str(&section("搭配", row.collocation.as_deref()));
        body.push_str(&section("例句", row.example.as_deref()));
        body.push_str(&section("来源句", row.source_sentence.as_deref()));
        body.push_str(&section("来源篇目", row.source_title.as_deref()));
        body.push_str(&section("标签", row.tags.as_deref()));
        cards.push_str(&format!(
            "<article class=\"card\" data-vocab-item=\"{index}\">\n  <h2 class=\"word\">{word}{meta}</h2>\n{body}</article>\n",
            word = esc(&row.surface),
            meta = meta,
            body = body
        ));
    }
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>句读 · 生词本 {count} 词</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 24px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
    color: #1f2328; background: #f6f7f9; line-height: 1.6;
  }}
  header {{ max-width: 860px; margin: 0 auto 16px; }}
  header h1 {{ margin: 0 0 4px; font-size: 20px; }}
  header p {{ margin: 0; color: #5b6470; font-size: 13px; }}
  .list {{ max-width: 860px; margin: 0 auto; }}
  .card {{
    background: #fff; border: 1px solid #e3e6ea; border-radius: 10px;
    padding: 14px 16px; margin: 0 0 12px;
  }}
  .word {{ margin: 0 0 8px; font-size: 18px; }}
  .phonetic {{ margin-left: 8px; font-size: 14px; color: #5b6470; font-weight: 400; }}
  .pos {{ margin-left: 8px; font-size: 12px; color: #7a4bd6; font-weight: 400; }}
  .row {{ margin: 4px 0; font-size: 14px; }}
  .label {{ display: inline-block; min-width: 64px; color: #5b6470; }}
  .value {{ white-space: pre-wrap; }}
  .empty {{ max-width: 860px; margin: 0 auto; color: #5b6470; }}
  footer {{ max-width: 860px; margin: 20px auto 0; color: #8b939e; font-size: 12px; }}
  @page {{ size: A4; margin: 14mm; }}
  @media print {{
    body {{ background: #fff; padding: 0; }}
    .card {{ break-inside: avoid; page-break-inside: avoid; border-color: #d0d4da; }}
    header, footer {{ max-width: none; }}
  }}
</style>
</head>
<body>
<header>
  <h1>句读 · 生词本</h1>
  <p>共 {count} 词 · 导出于 {stamp}</p>
</header>
<main class="list">
{cards}</main>
<footer>由句读（Judou）导出，本页不依赖网络即可离线查看。</footer>
</body>
</html>
"#,
        count = rows.len(),
        stamp = esc(stamp),
        cards = cards
    )
}

/// 备份库到 `out_dir`：`VACUUM INTO` 生成干净副本 + 同名 `.json` 元信息。
pub fn backup_db(db: &Db, out_dir: &Path, stamp: &str) -> Result<BackupResult, CommandError> {
    let stamp = validate_stamp(stamp)?;
    std::fs::create_dir_all(out_dir).map_err(|err| CommandError::db_io("创建备份目录", err))?;
    let db_path = out_dir.join(format!("judou-backup-{stamp}.db"));
    vacuum_into(db, &db_path)?;
    let schema_version = schema_version_of(&db_path)?;
    let tables = table_counts(&db_path)?;
    let meta = serde_json::json!({
        "app": "judou",
        "kind": "backup",
        "schemaVersion": schema_version,
        "createdAt": stamp,
        "tables": tables,
    });
    let meta_path = out_dir.join(format!("judou-backup-{stamp}.json"));
    std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta).map_err(|err| {
        CommandError::db_io("序列化备份元信息", err)
    })?)
    .map_err(|err| CommandError::db_io("写入备份元信息", err))?;

    Ok(BackupResult {
        db_path: db_path.to_string_lossy().to_string(),
        meta_path: meta_path.to_string_lossy().to_string(),
        schema_version,
        tables,
    })
}

/// 恢复：先自动备份（`pre-restore`）→ 校验源 → 临时副本校验 → 覆盖当前库 → 报告计数差异。
///
/// 覆盖用 rusqlite 的 backup API（页级复制），不替换 db 文件——Windows 上正在使用的库文件
/// 无法被 `rename` 覆盖（共享冲突），页级复制同样满足「失败不破坏现库」：开始覆盖后若失败，
/// 用 pre-restore 备份再复制回去。
pub fn restore_db(db: &Db, src: &Path, pre_dir: &Path, stamp: &str) -> Result<RestoreResult, CommandError> {
    let stamp = validate_stamp(stamp)?;
    // ① 源文件必须是合法 SQLite 且含 article 表（坏文件在这里就被挡住，现库未动）
    let src_conn = open_source(src)?;
    let _ = &src_conn;

    // ② 恢复前自动备份当前库
    std::fs::create_dir_all(pre_dir).map_err(|err| CommandError::db_io("创建备份目录", err))?;
    let pre_path = pre_dir.join(format!("judou-pre-restore-{stamp}.db"));
    vacuum_into(db, &pre_path)?;

    // ③ 临时副本上校验表计数（源文件本身只读打开，不改它）
    let tmp_dir = pre_dir.join(format!(".restore-check-{stamp}"));
    std::fs::create_dir_all(&tmp_dir).map_err(|err| CommandError::db_io("创建校验目录", err))?;
    let tmp_path = tmp_dir.join("check.db");
    std::fs::copy(src, &tmp_path).map_err(|err| CommandError::db_io("复制待恢复文件", err))?;
    let before_tables = table_counts(db.path())?;
    let after_tables = table_counts(&tmp_path)?;
    std::fs::remove_dir_all(&tmp_dir).ok();

    // ④ 页级覆盖（失败则用 pre-restore 备份回滚）
    if let Err(err) = copy_into(db, &src_conn) {
        let _ = copy_into(db, &open_source(&pre_path)?);
        return Err(err);
    }
    drop(src_conn);

    let diff = diff_counts(&before_tables, &after_tables);
    Ok(RestoreResult {
        restored_from: src.to_string_lossy().to_string(),
        pre_backup_path: pre_path.to_string_lossy().to_string(),
        tables: after_tables,
        diff,
    })
}

fn validate_stamp(stamp: &str) -> Result<String, CommandError> {
    // 只收 `YYYYMMDD-HHmm`（14 位 + 短横），挡路径穿越与空名
    let bytes = stamp.as_bytes();
    let shaped = bytes.len() == 13
        && bytes[8] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 8 || b.is_ascii_digit());
    if shaped {
        Ok(stamp.to_string())
    } else {
        Err(CommandError::invalid_setting_value("stamp", "时间戳应为 YYYYMMDD-HHmm"))
    }
}

fn vacuum_into(db: &Db, target: &Path) -> Result<(), CommandError> {
    if target.exists() {
        std::fs::remove_file(target).map_err(|err| CommandError::db_io("清理同名备份", err))?;
    }
    db.read(|conn| {
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])
            .map_err(|err| CommandError::db("导出库副本", err))?;
        Ok(())
    })
}

fn open_source(path: &Path) -> Result<Connection, CommandError> {
    if !path.exists() {
        return Err(CommandError::restore_invalid("备份文件不存在"));
    }
    let meta = std::fs::metadata(path).map_err(|err| CommandError::db_io("读取备份文件", err))?;
    if meta.len() < 1024 {
        return Err(CommandError::restore_invalid("备份文件过小，不是有效库"));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| CommandError::db("打开备份文件", err))?;
    let has_article: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='article')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::db("检查备份文件结构", err))?;
    let has_setting: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_setting')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::db("检查备份文件结构", err))?;
    if !has_article || !has_setting {
        return Err(CommandError::restore_invalid("备份文件缺少句读必需的表"));
    }
    Ok(conn)
}

fn copy_into(db: &Db, src: &Connection) -> Result<(), CommandError> {
    db.with_conn_mut(|dst| {
        let backup = Backup::new(src, dst).map_err(|err| CommandError::db("开始恢复库", err))?;
        backup
            .run_to_completion(64, Duration::from_millis(5), None)
            .map_err(|err| CommandError::db("写入恢复数据", err))?;
        Ok(())
    })
}

fn schema_version_of(path: &Path) -> Result<i64, CommandError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| CommandError::db("打开备份库", err))?;
    let version: String = conn
        .query_row("SELECT value FROM schema_meta WHERE key='version'", [], |row| row.get(0))
        .map_err(|err| CommandError::db("读取备份库版本", err))?;
    Ok(version.parse::<i64>().unwrap_or(0))
}

fn table_counts(path: &Path) -> Result<Vec<TableCount>, CommandError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| CommandError::db("打开待统计库", err))?;
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|err| CommandError::db("读取表清单", err))?
        .query_map([], |row| row.get(0))
        .map_err(|err| CommandError::db("读取表清单", err))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|err| CommandError::db("读取表清单", err))?;
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let rows: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |row| row.get(0))
            .map_err(|err| CommandError::db("统计表行数", err))?;
        out.push(TableCount { name, rows });
    }
    Ok(out)
}

fn diff_counts(before: &[TableCount], after: &[TableCount]) -> Vec<String> {
    let mut diff = Vec::new();
    for item in after {
        let old = before
            .iter()
            .find(|entry| entry.name == item.name)
            .map(|entry| entry.rows)
            .unwrap_or(-1);
        if old != item.rows {
            diff.push(format!("{}: {} → {}", item.name, old, item.rows));
        }
    }
    diff
}

/// `YYYYMMDD-HHmm`（UTC）。前端会传本地时间戳；门禁/CLI 不传时用这个兜底。
pub fn stamp_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// `days`（1970-01-01 起）→ (年, 月, 日)，Howard Hinnant 算法。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 导出文件名的默认时间戳（`judou-vocab-YYYYMMDD.html` 用）。
pub fn date_now() -> String {
    stamp_now()[0..8].to_string()
}

/// 默认导出目录：库文件同级 `exports/`。
pub fn default_export_dir(db: &Db) -> PathBuf {
    db.path()
        .parent()
        .map(|parent| parent.join("exports"))
        .unwrap_or_else(|| PathBuf::from("exports"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC5：自包含 HTML —— 无 `<link rel="stylesheet">`、无 `<script src=`、无 `http(s)://` 外链。
    #[test]
    fn html_has_no_external_links() {
        let html = render_vocab_html(
            &[VocabRow {
                surface: "abandon".into(),
                phonetic: Some("əˈbændən".into()),
                pos: Some("v.".into()),
                context_meaning: Some("放弃；抛弃".into()),
                sense: None,
                collocation: Some("abandon a plan".into()),
                example: Some("They abandoned the car.".into()),
                source_sentence: Some("He had to abandon the plan.".into()),
                source_title: Some("2019 CET4 Reading".into()),
                tags: Some("高频 / 动词".into()),
            }],
            "20261107-1730",
        );
        assert!(!html.contains("<link"), "不得有 link 标签");
        assert!(!html.contains("<script src="), "不得有外部脚本");
        assert!(!html.contains("http://"), "不得有 http 外链");
        assert!(!html.contains("https://"), "不得有 https 外链");
        assert!(html.contains("abandon"));
        assert!(html.contains("abandon a plan"), "搭配必须导出");
        assert!(html.contains("They abandoned the car."), "例句必须导出");
        assert!(html.contains("He had to abandon the plan."), "来源句必须导出");
        assert!(html.contains("高频 / 动词"), "标签必须导出");
        assert!(html.contains("break-inside: avoid"), "打印一页一卡");
    }

    /// AC5：用户内容必须转义（不能把 `<b>` 直接拼进 HTML）。
    #[test]
    fn html_escapes_user_content() {
        let html = render_vocab_html(
            &[VocabRow {
                surface: "<b>x</b>".into(),
                phonetic: None,
                pos: None,
                context_meaning: Some("a & b".into()),
                sense: None,
                collocation: None,
                example: None,
                source_sentence: None,
                source_title: None,
                tags: None,
            }],
            "20261107-1730",
        );
        assert!(html.contains("&lt;b&gt;x&lt;/b&gt;"), "词形应转义");
        assert!(html.contains("a &amp; b"), "释义应转义");
        assert!(!html.contains("<b>x</b>"), "原文标签不得原样出现");
    }

    /// AC6：备份生成 `.db` + `.json`，且元信息含 schema 版本与表计数。
    #[test]
    fn backup_writes_db_and_meta_with_counts() {
        let db = Db::open_in_memory_for_tests().expect("内存库");
        let dir = std::env::temp_dir().join(format!("judou-backup-test-{}", stamp_now()));
        std::fs::create_dir_all(&dir).expect("建目录");
        // 内存库没有文件路径，备份前先落一个真库副本作为源路径
        let src = dir.join("judou.db");
        vacuum_into(&db, &src).expect("先落盘");
        let file_db = Db::open(src.clone()).expect("打开落盘库");

        let result = backup_db(&file_db, &dir, "20261107-1730").expect("备份应成功");
        assert!(Path::new(&result.db_path).exists(), "备份 db 应存在");
        assert!(Path::new(&result.meta_path).exists(), "元信息 json 应存在");
        assert!(result.schema_version >= 1, "schema 版本应可读");
        assert!(
            result.tables.iter().any(|t| t.name == "article"),
            "表计数应含 article"
        );
        let meta = std::fs::read_to_string(&result.meta_path).expect("读元信息");
        assert!(meta.contains("schemaVersion"));
        assert!(meta.contains("judou"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// AC7：坏文件恢复必须被拒，且现库完好（表计数前后一致）。
    #[test]
    fn restore_rejects_bad_file_and_keeps_current_db() {
        let dir = std::env::temp_dir().join(format!("judou-restore-test-{}", stamp_now()));
        std::fs::create_dir_all(&dir).expect("建目录");
        let live = dir.join("judou.db");
        let seed = Db::open(live.clone()).expect("建库");
        vacuum_into(&seed, &live).ok();
        let db = Db::open(live.clone()).expect("打开库");
        let before = table_counts(&live).expect("统计前");

        let bad = dir.join("bad.db");
        std::fs::write(&bad, b"not a sqlite database at all..............").expect("写坏文件");
        let err = restore_db(&db, &bad, &dir, "20261107-1731").expect_err("坏文件必须被拒");
        assert_eq!(err.code, "restore_invalid");
        let after = table_counts(&live).expect("统计后");
        assert_eq!(
            before.iter().map(|t| (t.name.clone(), t.rows)).collect::<Vec<_>>(),
            after.iter().map(|t| (t.name.clone(), t.rows)).collect::<Vec<_>>(),
            "坏文件被拒后现库表计数不变"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────── M6 第四轮：PDF 词表（三模式 / 乱序 / A4 分页） ─────────

    fn sheet_rows(count: usize) -> Vec<VocabRow> {
        (1..=count)
            .map(|i| VocabRow {
                surface: format!("word{i:02}"),
                phonetic: None,
                pos: None,
                context_meaning: Some(format!("释义{i:02}")),
                sense: None,
                collocation: None,
                example: None,
                source_sentence: None,
                source_title: None,
                tags: None,
            })
            .collect()
    }

    #[test]
    fn sheet_three_modes_share_print_skeleton() {
        let rows = sheet_rows(7);
        for mode in [SheetMode::A4, SheetMode::Zh, SheetMode::En] {
            let html = render_vocab_sheet(&rows, mode, false, false);
            assert!(html.contains("@page"), "必须声明 @page（A4 打印）");
            assert!(html.contains("size: A4"), "@page 必须是 A4");
            assert!(!html.contains("<link"), "不得有外链样式");
            assert!(!html.contains("http"), "不得有外链地址");
            assert!(html.contains("sheet-cols"), "必须双栏布局");
            assert!(html.contains("<thead"), "每页必须重复表头");
            assert!(html.contains("共 7 词"), "标题行必须写明词数");
            assert!(html.contains("Word") && html.contains("Meaning"), "表头必须有 Word / Meaning");
            assert!(html.contains("tick"), "必须有打印用勾选框");
        }
    }

    #[test]
    fn sheet_modes_differ_in_which_column_is_blank() {
        let rows = sheet_rows(7);
        let a4 = render_vocab_sheet(&rows, SheetMode::A4, false, false);
        let zh = render_vocab_sheet(&rows, SheetMode::Zh, false, false);
        let en = render_vocab_sheet(&rows, SheetMode::En, false, false);

        // A4 默写：左右两组各自独立编号，左只放 Word、右只放 Meaning
        assert!(a4.contains(r#"data-col="word""#) && a4.contains(r#"data-col="meaning""#), "A4 必须左右分栏");
        assert!(a4.contains("word01") && a4.contains("释义01"), "A4 两侧都要有内容");
        assert_eq!(a4.matches(r#"data-empty="1""#).count(), 0, "A4 无空格");

        // 中文词表：Word 列留空（只有勾选框），Meaning 填释义
        assert!(zh.contains("释义01"), "中文词表必须填释义");
        assert!(!zh.contains("word01"), "中文词表 Word 列必须留空");
        assert_eq!(zh.matches(r#"data-empty="1""#).count(), 7, "中文词表 7 个 Word 单元格全空");

        // 英文词表：Word 填单词，Meaning 留空
        assert!(en.contains("word01"), "英文词表必须填单词");
        assert!(!en.contains("释义01"), "英文词表 Meaning 列必须留空");
        assert_eq!(en.matches(r#"data-empty="1""#).count(), 7, "英文词表 7 个 Meaning 单元格全空");
    }

    #[test]
    fn sheet_paginates_two_columns_with_repeated_thead() {
        // 中文/英文：每页 15 行 × 2 栏 = 30 词；31 词 → 2 页
        let rows = sheet_rows(31);
        let zh = render_vocab_sheet(&rows, SheetMode::Zh, false, false);
        assert!(zh.contains("共 31 词 2 页"), "31 词必须算成 2 页");
        assert!(zh.contains("第 1 页 / 2 页") && zh.contains("第 2 页 / 2 页"), "每页都要有页码");
        assert_eq!(zh.matches("<thead>").count(), 4, "2 页 × 2 栏 = 4 个表头");

        // A4 默写：左右是同一批词，每页 15 词；16 词 → 2 页
        let a4 = render_vocab_sheet(&sheet_rows(16), SheetMode::A4, false, false);
        assert!(a4.contains("共 16 词 2 页"), "A4 16 词必须算成 2 页");
        assert_eq!(a4.matches("<thead>").count(), 4, "A4 2 页 × 2 栏 = 4 个表头");
    }

    #[test]
    fn shuffle_keeps_the_set_and_changes_the_order() {
        let mut rows = sheet_rows(12);
        let before: Vec<String> = rows.iter().map(|row| row.surface.clone()).collect();
        shuffle_rows(&mut rows, 0x5EED_1234);
        let after: Vec<String> = rows.iter().map(|row| row.surface.clone()).collect();

        let mut sorted_before = before.clone();
        let mut sorted_after = after.clone();
        sorted_before.sort();
        sorted_after.sort();
        assert_eq!(sorted_before, sorted_after, "乱序不得增删词条");
        assert_ne!(before, after, "乱序后顺序必须与原名不同");

        let html = render_vocab_sheet(&rows, SheetMode::En, true, false);
        assert!(html.contains("乱序"), "乱序模式必须在标题行标注");
    }

    // ───────── M6 第五轮：释义回退链（context_meaning → lexicon.sense）+ A4 答案对照 ─────────

    /// 造「用户没填本句意思」的生词行：`context_meaning` 为 `None`，只有词典释义。
    fn rows_without_context_meaning(count: usize) -> Vec<VocabRow> {
        (1..=count)
            .map(|i| VocabRow {
                surface: format!("word{i:02}"),
                phonetic: None,
                pos: None,
                context_meaning: None,
                sense: Some(format!("词典释义{i:02}")),
                collocation: None,
                example: None,
                source_sentence: None,
                source_title: None,
                tags: None,
            })
            .collect()
    }

    /// PDF-8 / PDF-11：本句意思为空 → A4 与中文词表都必须回退到 `lexicon.sense`；
    /// 有本句意思时必须优先，不得混入词典释义。
    ///
    /// 英文词表（En）的 Meaning 列按设计**留空**（看单词默写释义），所以回退链在这一模式下
    /// 不可观测——改用 `meaning_text` 的直接断言证明链路本身与模式无关（PDF-11 的口径）。
    #[test]
    fn meaning_falls_back_to_lexicon_sense_in_all_three_modes() {
        let rows = rows_without_context_meaning(3);
        for mode in [SheetMode::A4, SheetMode::Zh] {
            let html = render_vocab_sheet(&rows, mode, false, false);
            assert!(html.contains("词典释义01"), "{mode:?} 模式丢失词典释义回退");
            assert!(html.contains("词典释义03"), "{mode:?} 模式最后一词也要回退");
        }

        // En 模式：Meaning 列留空（PDF-4 契约），但回退链对同一行仍成立
        let en = render_vocab_sheet(&rows, SheetMode::En, false, false);
        assert!(en.contains("word01"), "英文词表仍必须有单词");
        assert_eq!(en.matches(r#"data-empty="1""#).count(), 3, "英文词表 3 个 Meaning 单元格按设计留空");
        assert_eq!(meaning_text(&rows[0]), Some("词典释义01"), "回退链与模式无关");

        let mut rows = rows_without_context_meaning(1);
        rows[0].context_meaning = Some("本句意思01".into());
        let html = render_vocab_sheet(&rows, SheetMode::Zh, false, false);
        assert!(html.contains("本句意思01"), "有本句意思时必须优先用它");
        assert!(!html.contains("词典释义01"), "有本句意思时不得混入词典释义");
        assert_eq!(meaning_text(&rows[0]), Some("本句意思01"), "本句意思优先于词典释义");
    }

    /// PDF-9：A4 词表带答案对照节，行数 = 词数；关掉开关时该节不存在。
    #[test]
    fn a4_answer_section_lists_word_and_meaning_per_page() {
        let rows = rows_without_context_meaning(3);
        let on = render_vocab_sheet(&rows, SheetMode::A4, false, true);
        assert!(on.contains("<section class=\"sheet-answer\" data-sheet-answer>"), "开启时必须输出答案对照节");
        assert_eq!(on.matches("data-answer-no=").count(), 3, "答案行数必须等于词数");
        assert!(on.contains("答案对照"), "答案节必须自报用途（自查用）");
        assert!(on.contains("word01") && on.contains("词典释义01"), "答案行必须成对给出 Word —— 释义");

        let off = render_vocab_sheet(&rows, SheetMode::A4, false, false);
        assert!(!off.contains("data-sheet-answer"), "关闭开关时不得输出答案对照节");
        assert_eq!(off.matches("data-answer-no=").count(), 0, "关闭时不得残留答案行");
    }

    /// PDF-10：A4 右栏（Meaning）在「有词典释义」的词上必须非空（不得打 data-empty）。
    #[test]
    fn a4_meaning_column_is_never_empty_when_sense_present() {
        let rows = rows_without_context_meaning(9);
        let html = render_vocab_sheet(&rows, SheetMode::A4, false, false);
        assert_eq!(html.matches(r#"data-empty="1""#).count(), 0, "9 个词都有词典释义，A4 两栏不得出现空格");
    }

    /// PDF-8 端到端：真库 + 真 SQL —— `vocab_entry.context_meaning` 为 NULL 时，
    /// 导出必须拿到 `lexicon.sense`（用户实测 9 个词只有 1 个填了本句意思）。
    #[test]
    fn real_db_null_context_meaning_falls_back_to_lexicon_sense() {
        let db = Db::open_in_memory_for_tests().expect("内存库");
        db.write(|tx| {
            tx.execute(
                "INSERT INTO lexicon (normalized, word, sense) VALUES ('provoke', 'provoke', '引起；激起')",
                [],
            )
            .map_err(|err| CommandError::db("插入词库", err))?;
            // 两个生词：一个填了本句意思、一个没填（真实数据形态）
            tx.execute(
                "INSERT INTO vocab_entry (normalized, surface, context_meaning) VALUES ('provoke', 'provokes', NULL)",
                [],
            )
            .map_err(|err| CommandError::db("插入生词", err))?;
            tx.execute(
                "INSERT INTO vocab_entry (normalized, surface, context_meaning) VALUES ('abandon', 'abandoned', '放弃（本句）')",
                [],
            )
            .map_err(|err| CommandError::db("插入生词", err))?;
            Ok(())
        })
        .expect("建数据");

        let rows = db.read(read_vocab_rows).expect("读生词");
        let provoke = rows.iter().find(|row| row.surface == "provokes").expect("provokes 行");
        assert_eq!(provoke.context_meaning, None, "本用例前提：本句意思为空");
        assert_eq!(provoke.sense.as_deref(), Some("引起；激起"), "SQL 必须 join 出 lexicon.sense");
        assert_eq!(meaning_text(provoke), Some("引起；激起"), "回退链必须落到词典释义");

        // 真导出（A4 + 答案对照）：两个词都要有释义，答案行数 = 2
        let html = export_vocab_sheet(&db, "a4", false, true).expect("A4 导出");
        assert!(html.contains("引起；激起"), "没填本句意思的词必须导出词典释义");
        assert!(html.contains("放弃（本句）"), "填了本句意思的词必须用本句意思");
        assert_eq!(html.matches("data-answer-no=").count(), 2, "答案对照行数 = 词数");
        assert_eq!(html.matches(r#"data-empty="1""#).count(), 0, "两个词都有释义，A4 不得出现空格");

        let zh = export_vocab_sheet(&db, "zh", false, false).expect("中文词表导出");
        assert!(zh.contains("引起；激起"), "中文词表同样走回退链");
    }
}

