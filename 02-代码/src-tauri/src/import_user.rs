//! M5 用户导入（02 D0）：文本清洗 → 分段 → 切句 → 分词 → 两阶段命令（预览不写库 / 提交四层校验后入库）。
//!
//! 与 `import.rs`（内置内容包）的分工：
//!   `import.rs`      —— 内容包是**权威 JSON**，只做校验与 upsert，不解析文本；
//!   `import_user.rs` —— 用户粘贴的是**裸文本**，这里负责切段/切句/分词，口径必须与内容包一致
//!                       （`isWord` / `normalized` / **UTF-16 code unit 偏移**，见 001_init.sql ADR-008）。
//!
//! 红线（02 §三 裁定 3 / 三问裁定 3）：
//!   * 不新增 crate（uuid 手写：纳秒 + 进程内计数器混合）；
//!   * `parse_import_preview` **绝不写库**（AC1 用 `total_changes` 差值 = 0 验）；
//!   * `commit_import` 四层校验任一失败 → 整事务回滚（库中零写入）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::CommandError;
// `Db` 在 `lib.rs` 里是 `pub use` 出去的门面（门禁 bin 要用），这里引用与实现同源
pub use crate::db::Db;

/// 正文上限（02 §三 裁定 3 的缓解措施）：超过即 `IMPORT_TOO_LARGE`
pub const MAX_TEXT_CHARS: usize = 20_000;
/// L4 业务下限
const MIN_WORD_COUNT: usize = 10;
/// 标题回退链第 2 级的截取长度（02 裁定 7）
const TITLE_FALLBACK_CHARS: usize = 40;

/// 缩写表（AC4 / **B-2 写死裁定**）：命中即不断句，**不判下一词大小写**。
/// 精度取舍：`etc.` 后本应断句的场景会被误判为不断——用户在预览页能看到句数，可接受。
const ABBREVIATIONS: [&str; 18] = [
    "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "St.", "Jr.", "Sr.", "vs.", "etc.", "e.g.", "i.e.", "U.S.",
    "U.K.", "a.m.", "p.m.", "No.", "Fig.",
];

// ───────────────────────── IPC 形状（camelCase，D2 对齐） ─────────────────────────

/// 预览根：`parse_import_preview` 的返回，也是 `commit_import` 的入参（02 裁定 3：整对象回传）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub title: String,
    pub paragraphs: Vec<ImportParagraph>,
    pub stats: ImportStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportParagraph {
    pub idx: i64,
    pub text: String,
    pub sentences: Vec<ImportSentence>,
}

/// `start`/`end` 相对 `paragraph.text`，单位 **UTF-16 code unit**
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSentence {
    pub idx: i64,
    pub start: i64,
    pub end: i64,
    pub text: String,
    pub tokens: Vec<ImportToken>,
}

/// `start`/`end` 相对 `sentence.text`，单位 **UTF-16 code unit**
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportToken {
    pub start: i64,
    pub end: i64,
    pub surface: String,
    #[serde(default)]
    pub normalized: Option<String>,
    pub is_word: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub paragraph_count: i64,
    pub sentence_count: i64,
    pub token_count: i64,
    pub word_count: i64,
}

/// 预览页所选（题型/年份默认 `other` / `null`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMeta {
    #[serde(default)]
    pub exam_type: Option<String>,
    #[serde(default)]
    pub exam_year: Option<i64>,
}

/// `commit_import` 的返回：新文章 id + `source_key`（uuid 由 commit 时生成，02 裁定 5）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitResult {
    pub article_id: i64,
    pub source_key: String,
    pub stats: ImportStats,
}

// ───────────────────────── 错误码（AC6） ─────────────────────────

/// 六个错误码（camelCase 边界上 `CommandError.code` 给前端可直接用的 Code）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportCode {
    L1Structure,
    L2Offset,
    L3Coverage,
    L4Business,
    TooLarge,
    DuplicateSource,
}

impl ImportCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::L1Structure => "IMPORT_L1_STRUCTURE",
            Self::L2Offset => "IMPORT_L2_OFFSET",
            Self::L3Coverage => "IMPORT_L3_COVERAGE",
            Self::L4Business => "IMPORT_L4_BUSINESS",
            Self::TooLarge => "IMPORT_TOO_LARGE",
            Self::DuplicateSource => "IMPORT_DUPLICATE_SOURCE",
        }
    }

    /// 用户可读提示（AC11：错误码 + 可操作提示）
    pub fn message(self) -> &'static str {
        match self {
            Self::L1Structure => "导入内容结构不完整（段落或句子为空、编号不连续），请重新粘贴后再解析。",
            Self::L2Offset => "文本含不可见字符，请重新粘贴。",
            Self::L3Coverage => "文本切分不完整（有字符未归入任何单词），请重新粘贴后再解析。",
            Self::L4Business => "内容太短或含无法识别的控制字符：至少需要 1 句话、10 个单词。",
            Self::TooLarge => "正文超过 20000 字符，请拆分后分次导入。",
            Self::DuplicateSource => "这篇已经导入过了，请换一篇再导入。",
        }
    }

    fn error(self) -> CommandError {
        CommandError {
            code: self.as_str().to_string(),
            message: self.message().to_string(),
            path: None,
        }
    }
}

// ───────────────────────── ① 清洗（AC2） ─────────────────────────

/// 去 BOM / 统一换行 / 去零宽 / 压连续空行。
///
/// 顺序有讲究：先统一换行再压空行，否则 `\r\n\r\n` 还没变成 `\n\n` 就匹配不到连续空行。
pub fn clean_text(raw: &str) -> String {
    // 先剥开头零宽/BOM：`\u{feff}` 在 `str::split('\n')` 里被当**词边界**，不先剥会留在行首
    let raw = raw.trim_start_matches(|c: char| matches!(c, '\u{feff}' | '\u{200b}' | '\u{200c}' | '\u{200d}'));
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                // `\r\n` 与孤立 `\r` 都归一成 `\n`
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\u{feff}' | '\u{200b}' | '\u{200c}' | '\u{200d}' => {}
            _ => out.push(ch),
        }
    }
    collapse_blank_lines(&out)
}

/// 连续空行（含只含空白的行）压成 1 个 `\n\n`；首尾空白行直接丢弃。
fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0usize;
    for line in text.split('\n') {
        if line.trim().is_empty() {
            blanks += 1;
            continue;
        }
        if !out.is_empty() {
            // 上一行与当前行之间：有空白行 → 一个空行；相邻 → 普通换行
            out.push('\n');
            if blanks > 0 {
                out.push('\n');
            }
        }
        blanks = 0;
        out.push_str(line);
    }
    out
}

// ───────────────────────── ② 分段（AC3） ─────────────────────────

/// 按空行切段：纯空白段丢弃。返回 `(idx, text)`，`idx` 从 0 连续。
pub fn split_paragraphs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            if !current.is_empty() {
                out.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        out.push(current.join("\n"));
    }
    out.into_iter()
        .map(|para| para.trim().to_string())
        .filter(|para| !para.trim().is_empty())
        .collect()
}

// ───────────────────────── ③ 切句（AC4） ─────────────────────────

/// 句的 `(start, end)`，**UTF-16 code unit**、相对 `paragraph`。
///
/// 边界口径（与内置内容包一致）：句子**不含**首尾/句间空白——`end` 止于句末收尾符号，
/// 下一句 `start` 跳过空白。包内「句间那个空格」属于段落的**空隙**，`renderParagraph`
/// 正是靠它还原空格；把空格算进句子会让句子卡多出前导空格。
pub fn split_sentences(paragraph: &str) -> Vec<(usize, usize)> {
    let units: Vec<u16> = paragraph.encode_utf16().collect();
    let mut out: Vec<(usize, usize)> = Vec::new();
    // 当前句的候选起点（上一句 `end`；前导空白在收敛时跳过）
    let mut seg_start = 0usize;
    let mut i = 0usize;
    while i < units.len() {
        let unit = units[i];
        let is_terminator = unit <= 0x7f && matches!(unit as u8 as char, '.' | '?' | '!');
        if !is_terminator {
            i += 1;
            continue;
        }

        // B-2：单一缩写表 + 命中即不断（不判下一词大小写）。
        // **整串匹配**：`U.S.` / `e.g.` / `a.m.` 这类多点缩写，必须在**整串末尾**一次性判定，
        // 否则从第一个点起判只会得到 "e." / "U." 这种半截候选（表里没有 → 误断）。
        let word_start = units[..i]
            .iter()
            .rposition(|u| !is_ascii_alnum_unit(*u))
            .map(|p| p + 1)
            .unwrap_or(0);
        if let Some(abbr_end) = abbreviation_end(&units, word_start) {
            i = abbr_end;
            continue;
        }

        // 小数 `3.14` / 版本号 `v1.1`：点**前后都是数字**才不断。
        // 不能只看点前一个字符——那样 `fine. Really` 的 `e.` 也会被当成小数，整段黏成一句。
        if unit == 0x2e
            && i > 0
            && is_ascii_digit_unit(units[i - 1])
            && units.get(i + 1).copied().is_some_and(is_ascii_digit_unit)
        {
            i += 1;
            continue;
        }

        // 句末标点连写（`?!` / `!!` / `...`）整体算一个结束点
        let mut end = consume_marks(&units, i);
        // 紧跟的收尾符号归属该句：`"` `'` `)` 以及 `】` `”` `’` `）`
        while end < units.len() && is_closing(units[end]) {
            end += 1;
        }
        if let Some(span) = trim_span(&units, seg_start, end) {
            out.push(span);
        }
        seg_start = end;
        i = end;
    }
    // 收尾：段末没有句末标点的残句（标题行、未写完的段落）也算一句
    if let Some(span) = trim_span(&units, seg_start, units.len()) {
        out.push(span);
    }
    out
}

/// 从 `word_start` 起吃掉「ASCII 字母 + 点」得到候选串；若整串以 `.` 结尾且命中缩写表，
/// 返回该缩写串的结束位置（调用方直接跳到那里，等价于「这一点不断句」）。
///
/// 例：`U.S.` → 候选 `"U.S."` 命中 → 返回第二个点之后的位置；
///     `fine.` → 候选 `"fine."` 不命中 → `None`（照常断句）。
fn abbreviation_end(units: &[u16], word_start: usize) -> Option<usize> {
    let mut end = word_start;
    while end < units.len() {
        let unit = units[end];
        let is_alpha = unit < 0x80 && (unit as u8 as char).is_ascii_alphabetic();
        if is_alpha || unit == 0x2e {
            end += 1;
        } else {
            break;
        }
    }
    if end == word_start || units[end - 1] != 0x2e {
        return None;
    }
    if is_abbreviation(&utf16_slice_to_string(units, word_start, end)) {
        Some(end)
    } else {
        None
    }
}

/// 去掉首尾空白后返回 `(start, end)`；全空白返回 `None`（不产生空句子）。
fn trim_span(units: &[u16], start: usize, end: usize) -> Option<(usize, usize)> {
    let mut s = start.min(units.len());
    let mut e = end.min(units.len());
    while s < e && is_utf16_space(units[s]) {
        s += 1;
    }
    while e > s && is_utf16_space(units[e - 1]) {
        e -= 1;
    }
    if e > s {
        Some((s, e))
    } else {
        None
    }
}

/// 句末标点连写（`?!` / `...`）整体算一个结束点。`?!` / `!!` 必须一起吞，
/// 否则 `?` 收尾后下一轮会把 `!` 判成「句首标点」，切出 `" What?!"` 这种以标点开头的句子。
fn consume_marks(units: &[u16], i: usize) -> usize {
    let mut end = i + 1;
    while end < units.len() && matches!(units[end], 0x2e | 0x21 | 0x3f) {
        end += 1;
    }
    end
}

fn is_closing(unit: u16) -> bool {
    matches!(unit, 0x22 /* " */ | 0x27 /* ' */ | 0x29 /* ) */ | 0x3011 /* 】 */ | 0x201d /* ” */ | 0x2019 /* ’ */ | 0xff09 /* ） */)
}

fn is_abbreviation(candidate: &str) -> bool {
    ABBREVIATIONS.iter().any(|abbr| abbr.eq_ignore_ascii_case(candidate))
}

fn is_ascii_alnum_unit(unit: u16) -> bool {
    unit < 0x80 && (unit as u8 as char).is_ascii_alphanumeric()
}

/// 只认 `0-9`（小数判据要比字母更严：`fine.` 的 `e` 不能算）
fn is_ascii_digit_unit(unit: u16) -> bool {
    unit < 0x80 && (unit as u8 as char).is_ascii_digit()
}

fn utf16_slice_to_string(units: &[u16], start: usize, end: usize) -> String {
    String::from_utf16_lossy(&units[start..end])
}

// ───────────────────────── ④ 分词（AC5） ─────────────────────────

/// 分词（相对 `sentence` 的 UTF-16 偏移）。空格与段内换行不属于任何 token。
///
/// 口径与内置内容包一致：
///   * 词串 = 字母开头，续接 `字母 | ' | - | ’`，**吞掉后续 `'`/`’`**（`students'`）；
///   * 数字 = 数字开头，续接 `数字 | , | .`（`1997` / `150` / `88,000` / `3.14`），`isWord=false`；
///   * 其余单个非空白字符各成一个 token（标点），`isWord=false`；
///   * `normalized` = `surface` 小写并去尾部 `'`/`’`（`students'` → `students`）。
pub fn tokenize(text: &str) -> Vec<ImportToken> {
    use unicode_marks::char_len_utf16;
    let mut out = Vec::new();
    let mut units = 0usize; // 当前扫描位置的 UTF-16 偏移
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            units += char_len_utf16(ch);
            i += 1;
            continue;
        }
        // 非 ASCII「字母」（中文、日文等）：单字成 token，但仍算词（可收藏/可查词）。
        // 内置内容包是英文，没有这一支；用户粘贴中文时才走这里。标点仍是单独的非词 token。
        if !ch.is_ascii() && ch.is_alphabetic() {
            let start = units;
            units += char_len_utf16(ch);
            let surface = ch.to_string();
            out.push(ImportToken {
                start: start as i64,
                end: units as i64,
                normalized: Some(surface.clone()),
                surface,
                is_word: true,
            });
            i += 1;
            continue;
        }
        // 两个坐标系：`start` 是 UTF-16 偏移（对外交付），`char_start` 是 `chars` 数组下标（内部扫描）。
        // 混用会让含非 BMP 字符（emoji 占 2 个单位）或前导空白之后的切片错位/越界——
        // `I 😀 am` 修前会把 "am" 切出 "m"（UTF-16 偏移 5 被当成 chars 下标 5）。
        let char_start = i;
        let start = units;
        let mut j = i;
        if ch.is_alphabetic() {
            // 词串：字母 | `'` | `’` | `-`（结尾的撇号自然被吞，`students'` 保持一个 token）
            j += 1;
            while j < chars.len() && is_word_char(chars[j]) {
                j += 1;
            }
        } else if ch.is_ascii_digit() {
            // `1997` / `150` / `88,000`：整串一个 token，非词
            j += 1;
            while j < chars.len() {
                let c = chars[j];
                if c.is_ascii_digit() || c == ',' {
                    j += 1;
                    continue;
                }
                // `3.14` 吞点；`end. Next` 的句点后面不是数字就不吞
                if c == '.' && matches!(chars.get(j + 1), Some(next) if next.is_ascii_alphanumeric()) {
                    j += 1;
                    continue;
                }
                break;
            }
        } else {
            j += 1;
            // 字母内的撇号/连字符已在上面的分支处理；孤立的 `'` 单独成 token
        }
        for c in &chars[char_start..j] {
            units += char_len_utf16(*c);
        }
        let surface: String = chars[char_start..j].iter().collect();
        let is_word = surface.chars().next().is_some_and(char::is_alphabetic);
        // 纯 `-` / `'` 不当词；数字字母混写（`1st`）保持非词
        let is_word = is_word && surface.chars().all(|c| c.is_alphanumeric() || c == '\'' || c == '-');
        let normalized = if is_word { Some(normalize_surface(&surface)) } else { None };
        out.push(ImportToken {
            start: start as i64,
            end: units as i64,
            surface,
            normalized,
            is_word,
        });
        i = j;
    }
    out
}

/// `students'` → `students`；`I'm` → `i'm`；`Students’` → `students`
fn normalize_surface(surface: &str) -> String {
    surface
        .to_lowercase()
        .trim_end_matches(['\'', '\u{2019}'])
        .to_string()
}

/// 词串允许的字符（首字符另判为字母）
fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c == '\'' || c == '\u{2019}' || c == '-'
}

/// 单个字符占几个 UTF-16 code unit（Rust `len_utf16()` 的转发，便于 grep 到「UTF-16」）
mod unicode_marks {
    pub fn char_len_utf16(ch: char) -> usize {
        ch.len_utf16()
    }
}

// ───────────────────────── ⑤ 预览（AC1：不写库） ─────────────────────────

/// 两阶段之「解析」：**纯函数 + 不碰 Db**。超长正文直接报 `IMPORT_TOO_LARGE`。
pub fn parse_import_preview(raw: &str, title: Option<&str>) -> Result<ImportPreview, CommandError> {
    let cleaned = clean_text(raw);
    let char_count = cleaned.chars().count();
    if char_count > MAX_TEXT_CHARS {
        return Err(ImportCode::TooLarge.error());
    }

    let mut paragraphs = Vec::new();
    let mut stats = ImportStats::default();
    for (p_idx, para_text) in split_paragraphs(&cleaned).into_iter().enumerate() {
        let mut sentences = Vec::new();
        for (s_idx, (start, end)) in split_sentences(&para_text).into_iter().enumerate() {
            let units: Vec<u16> = para_text.encode_utf16().collect();
            let text = utf16_slice_to_string(&units, start, end);
            let tokens = tokenize(&text);
            stats.sentence_count += 1;
            stats.token_count += tokens.len() as i64;
            stats.word_count += tokens.iter().filter(|t| t.is_word).count() as i64;
            sentences.push(ImportSentence {
                idx: s_idx as i64,
                start: start as i64,
                end: end as i64,
                text,
                tokens,
            });
        }
        if sentences.is_empty() {
            continue;
        }
        stats.paragraph_count += 1;
        paragraphs.push(ImportParagraph {
            idx: p_idx as i64,
            text: para_text,
            sentences,
        });
    }
    // 剔除空段后重排 idx，保证「idx 从 0 连续」
    for (index, paragraph) in paragraphs.iter_mut().enumerate() {
        paragraph.idx = index as i64;
    }

    let title = resolve_title(title, &cleaned);
    Ok(ImportPreview {
        title,
        paragraphs,
        stats,
    })
}

/// 标题三级回退（02 裁定 7）：用户输入 → 正文首行前 40 字 → `未命名导入 YYYY-MM-DD`
fn resolve_title(user_title: Option<&str>, cleaned: &str) -> String {
    if let Some(title) = user_title.map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_string();
    }
    for line in cleaned.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        return line.chars().take(TITLE_FALLBACK_CHARS).collect();
    }
    format!("未命名导入 {}", today_utc())
}

/// `YYYY-MM-DD`（UTC，与库中 `datetime('now')` 同日历口径）
fn today_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// days since 1970-01-01 → (y, m, d)（Howard Hinnant 的 civil_from_days，避免引 chrono）
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

// ───────────────────────── ⑥ 四层校验（AC6） ─────────────────────────

/// L1 结构：段/句非空、`idx` 连续、段文本非空白
pub fn validate_l1(preview: &ImportPreview) -> Result<(), CommandError> {
    if preview.paragraphs.is_empty() {
        return Err(ImportCode::L1Structure.error());
    }
    for (index, paragraph) in preview.paragraphs.iter().enumerate() {
        if paragraph.idx != index as i64 || paragraph.text.trim().is_empty() {
            return Err(ImportCode::L1Structure.error());
        }
        if paragraph.sentences.is_empty() {
            return Err(ImportCode::L1Structure.error());
        }
        for (si, sentence) in paragraph.sentences.iter().enumerate() {
            if sentence.idx != si as i64 || sentence.text.trim().is_empty() {
                return Err(ImportCode::L1Structure.error());
            }
        }
    }
    Ok(())
}

/// L2 偏移：句子相对段、token 相对句，**双级切片相等**（UTF-16 单位切片）
pub fn validate_l2(preview: &ImportPreview) -> Result<(), CommandError> {
    for paragraph in &preview.paragraphs {
        let para_units: Vec<u16> = paragraph.text.encode_utf16().collect();
        for sentence in &paragraph.sentences {
            let (s, e) = (sentence.start, sentence.end);
            if s < 0 || e < s || e as usize > para_units.len() {
                return Err(ImportCode::L2Offset.error());
            }
            if utf16_slice_to_string(&para_units, s as usize, e as usize) != sentence.text {
                return Err(ImportCode::L2Offset.error());
            }
            let sent_units: Vec<u16> = sentence.text.encode_utf16().collect();
            for token in &sentence.tokens {
                let (ts, te) = (token.start, token.end);
                if ts < 0 || te <= ts || te as usize > sent_units.len() {
                    return Err(ImportCode::L2Offset.error());
                }
                if utf16_slice_to_string(&sent_units, ts as usize, te as usize) != token.surface {
                    return Err(ImportCode::L2Offset.error());
                }
            }
        }
    }
    Ok(())
}

/// L3 覆盖：token 按序不重叠，且该句除空格外的每个字符都被某个 token 覆盖
pub fn validate_l3(preview: &ImportPreview) -> Result<(), CommandError> {
    for paragraph in &preview.paragraphs {
        for sentence in &paragraph.sentences {
            let units: Vec<u16> = sentence.text.encode_utf16().collect();
            let mut cursor = 0usize;
            for token in &sentence.tokens {
                let (ts, te) = (token.start as usize, token.end as usize);
                if ts < cursor {
                    return Err(ImportCode::L3Coverage.error()); // 重叠/乱序
                }
                // 间隙里只允许空白
                for unit in &units[cursor..ts] {
                    if !is_utf16_space(*unit) {
                        return Err(ImportCode::L3Coverage.error());
                    }
                }
                cursor = te;
            }
            for unit in &units[cursor..] {
                if !is_utf16_space(*unit) {
                    return Err(ImportCode::L3Coverage.error());
                }
            }
        }
    }
    Ok(())
}

/// 该 UTF-16 单位是否空白。
///
/// 不用 `char::from_u32(unit as u32)` 直接判：emoji 的两半是**代理项**（0xD800~0xDFFF），
/// `from_u32` 会把它们折成 U+FFFD（既非空白也不报错），含 emoji 的段落会被整段判成「有非空白
/// 未覆盖」。代理项本身一定不是空白，直接返回 false。
fn is_utf16_space(unit: u16) -> bool {
    if (0xD800..=0xDFFF).contains(&unit) {
        return false;
    }
    char::from_u32(unit as u32).is_some_and(char::is_whitespace)
}

/// L4 业务：句数 ≥1、词数 ≥10、无控制字符
pub fn validate_l4(preview: &ImportPreview) -> Result<(), CommandError> {
    if preview.stats.sentence_count < 1 || preview.stats.word_count < MIN_WORD_COUNT as i64 {
        return Err(ImportCode::L4Business.error());
    }
    for paragraph in &preview.paragraphs {
        if has_control(&paragraph.text) {
            return Err(ImportCode::L4Business.error());
        }
        for sentence in &paragraph.sentences {
            if has_control(&sentence.text) {
                return Err(ImportCode::L4Business.error());
            }
            for token in &sentence.tokens {
                if has_control(&token.surface) {
                    return Err(ImportCode::L4Business.error());
                }
            }
        }
    }
    Ok(())
}

/// 控制字符 = Unicode Cc 类里除 `\n` / `\t` 之外的那些（`\r` 已被清洗掉）
fn has_control(text: &str) -> bool {
    text.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}

/// 四层顺序执行（L1 → L4），任一层失败即返回对应错误码
pub fn validate_all(preview: &ImportPreview) -> Result<(), CommandError> {
    validate_l1(preview)?;
    validate_l2(preview)?;
    validate_l3(preview)?;
    validate_l4(preview)
}

// ───────────────────────── 命令实现 ─────────────────────────

/// 两阶段之「预览」：**不碰 Db**（AC1）。`title` 为空串等价于未给。
pub fn parse_preview(raw: &str, title: Option<String>) -> Result<ImportPreview, CommandError> {
    parse_import_preview(raw, title.as_deref())
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 手写 uuid（Cargo 无 uuid/rand，02 三问裁定 3）：纳秒时间戳 + 进程内计数器混合，
/// 同毫秒内两次 commit 也不会撞。
fn user_source_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    // 混合：高 32 位取自纳秒、低 32 位取自计数器的 xorshift 扰动
    let mixed = (nanos ^ (seq.wrapping_mul(0x9E37_79B9_7F4A_7C15))) & 0xFFFF_FFFF;
    format!("user-{:x}{:016x}{:08x}", nanos >> 32, nanos as u64, mixed)
}

/// 两阶段之「提交」：四层校验 → 单事务入库（任一失败整体回滚）。
pub fn commit_import(db: &Db, preview: &ImportPreview, meta: &ImportMeta) -> Result<ImportCommitResult, CommandError> {
    if preview.paragraphs.iter().map(|p| p.text.chars().count()).sum::<usize>() > MAX_TEXT_CHARS {
        return Err(ImportCode::TooLarge.error());
    }
    validate_all(preview)?;

    let exam_type = match meta.exam_type.as_deref() {
        Some("cet4") => "cet4".to_string(),
        Some("cet6") => "cet6".to_string(),
        Some("other") | None => "other".to_string(),
        Some(_) => return Err(ImportCode::L4Business.error()),
    };
    let source_key = user_source_key();
    let stats = preview.stats;

    let written = db.write(|tx| -> Result<i64, CommandError> {
        let article_id: i64 = tx
            .query_row(
                "INSERT INTO article
                   (source_key, title, source, exam_type, exam_year, section_type,
                    word_count, visibility, sentence_count, pack_version)
                 VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5, 'user', ?6, NULL)
                 RETURNING id",
                params![
                    source_key.as_str(),
                    preview.title.as_str(),
                    exam_type,
                    meta.exam_year,
                    stats.word_count,
                    stats.sentence_count
                ],
                |row| row.get(0),
            )
            .map_err(|err| map_unique(err))?;

        let mut st_paragraph = tx
            .prepare("INSERT INTO paragraph (article_id, idx, text) VALUES (?1, ?2, ?3) RETURNING id")
            .map_err(|err| CommandError::db("准备段落写入", err))?;
        let mut st_sentence = tx
            .prepare(
                "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
            )
            .map_err(|err| CommandError::db("准备句子写入", err))?;
        let mut st_token = tx
            .prepare(
                "INSERT INTO token (sentence_id, idx, surface, normalized, is_word, start_offset, end_offset)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|err| CommandError::db("准备词写入", err))?;

        for paragraph in &preview.paragraphs {
            let paragraph_id: i64 = st_paragraph
                .query_row(params![article_id, paragraph.idx, paragraph.text.as_str()], |row| row.get(0))
                .map_err(|err| CommandError::db("写入段落", err))?;
            for sentence in &paragraph.sentences {
                let sentence_id: i64 = st_sentence
                    .query_row(
                        params![
                            article_id,
                            paragraph_id,
                            sentence.idx,
                            sentence.text.as_str(),
                            text_hash(&sentence.text),
                            sentence.start,
                            sentence.end
                        ],
                        |row| row.get(0),
                    )
                    .map_err(|err| CommandError::db("写入句子", err))?;
                for (index, token) in sentence.tokens.iter().enumerate() {
                    // `token.normalized` 是 NOT NULL：非词（标点/数字）库里回落 surface，
                    // 与内置导入同口径（`is_word=0` 已标明它不是词，M3 聚合只取 is_word=1）。
                    let normalized = token.normalized.clone().unwrap_or_else(|| token.surface.clone());
                    st_token
                        .execute(params![
                            sentence_id,
                            index as i64,
                            token.surface.as_str(),
                            normalized,
                            i32::from(token.is_word),
                            token.start,
                            token.end
                        ])
                        .map_err(|err| CommandError::db("写入词", err))?;
                }
            }
        }
        Ok(article_id)
    })?;

    // 本函数**不往 stdout 打印**：门禁 bin 的 JSON 契约是「stdout 只有一行 JSON」，
    // 一行诊断日志就会污染调用方的解析（本批已删 `[P-X]` / `[judou][import-user]` 两类打印）。
    Ok(ImportCommitResult {
        article_id: written,
        source_key,
        stats,
    })
}

/// `source_key` 撞 UNIQUE → `IMPORT_DUPLICATE_SOURCE` + 回滚；其余照常报 db 错误
///
/// `pub`：门禁 bin（`import_user_cli`）要用同一映射构造「重复导入」场景，
/// 否则那条断言只能验到 rusqlite 原始错误文本、验不到契约码。
pub fn map_unique(err: rusqlite::Error) -> CommandError {
    let is_unique = match &err {
        rusqlite::Error::SqliteFailure(inner, msg) => {
            inner.code == rusqlite::ErrorCode::ConstraintViolation
                && msg.as_deref().map(|m| m.contains("UNIQUE")).unwrap_or(true)
        }
        _ => false,
    };
    if is_unique {
        ImportCode::DuplicateSource.error()
    } else {
        CommandError::db("写入篇目", err)
    }
}

/// `sentence.text_hash` = sha256(text) 前 16 位十六进制（与 `import.rs` 同口径）
fn text_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 供门禁：库里该 `source_key` 是否存在（AC7 撞 UNIQUE 的构造入口）
pub fn source_key_exists(db: &Db, source_key: &str) -> Result<bool, CommandError> {
    db.read(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM article WHERE source_key = ?1)",
            [source_key],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map(|v| v.unwrap_or(false))
        .map_err(|err| CommandError::db("查篇目", err))
    })
}

// ───────────────────────── 单测（本批新增：切句/分词的最小可失败检查） ─────────────────────────
//
// 为什么要这几条：D8 门禁走 bin + JSON 契约，跑一次要编译整棵依赖树；切句器改动（尤其
// 「缩写整串判定」与「UTF-16 索引」两块）出错时，bin 只会在 JSON 里给出一个刁钻的数组，
// 定位成本高。这里用同一条断言口径给出秒级红/绿。
#[cfg(test)]
mod tests {
    use super::*;

    /// `(start, end)` → 句子文本（按 UTF-16 切片，与实现同口径）
    fn texts(paragraph: &str) -> Vec<String> {
        let units: Vec<u16> = paragraph.encode_utf16().collect();
        split_sentences(paragraph)
            .into_iter()
            .map(|(s, e)| String::from_utf16_lossy(&units[s..e]))
            .collect()
    }

    #[test]
    fn split_sentences_returns_sentences() {
        // 本批回归核心：修前这里恒为 `[]`（out 从未 push）
        assert_eq!(texts("It is fine. Really."), vec!["It is fine.", "Really."]);
        assert_eq!(texts("One end. Next one."), vec!["One end.", "Next one."]);
    }

    #[test]
    fn split_sentences_keeps_abbreviations() {
        for line in [
            "We met Mrs. Lee.",
            "Ms. Park and Dr. Wu came.",
            "Prof. Kim spoke to St. Louis.",
            "Junior Jr. and Senior Sr. attended.",
            "Red vs. blue.",
            "Books, pens, etc. are here.",
            "Use e.g. this.",
            "That is i.e. a test.",
            "The U.S. team won.",
            "The U.K. squad lost.",
            "At 9 a.m. we left.",
            "At 5 p.m. we left.",
            "See No. 5 for it.",
            "See Fig. 2 for it.",
        ] {
            assert_eq!(texts(line).len(), 1, "缩写不断句失败：{line}");
        }
    }

    #[test]
    fn split_sentences_keeps_decimal() {
        assert_eq!(texts("Pi is 3.14 now."), vec!["Pi is 3.14 now."]);
        // 反向：点前是字母（`fine.`）不能被当小数而黏成一句
        assert_eq!(texts("It is fine. Really.").len(), 2);
    }

    #[test]
    fn split_sentences_offsets_are_utf16() {
        let paragraph = "I love 😀 fun. Next one.";
        let units: Vec<u16> = paragraph.encode_utf16().collect();
        let spans = split_sentences(paragraph);
        assert_eq!(spans.len(), 2);
        // emoji 占 2 个 UTF-16 单位：首句 "I love 😀 fun." = 14（字节口径会是 17）
        assert_eq!(spans[0], (0, 14));
        // 句间那个空格不归属任何句子
        assert_eq!(spans[1].0, 15);
        assert_eq!(spans[1].1, units.len());
    }

    #[test]
    fn tokenize_offsets_are_utf16_not_char_index() {
        // 回归：修前 start 用 UTF-16 偏移去切 chars 索引，含 emoji 时切片越界/错位
        let tokens = tokenize("I 😀 am");
        let units: Vec<u16> = "I 😀 am".encode_utf16().collect();
        for token in &tokens {
            let slice = String::from_utf16_lossy(&units[token.start as usize..token.end as usize]);
            assert_eq!(slice, token.surface, "token 切片与 surface 不符：{token:?}");
        }
        assert_eq!(tokens.iter().map(|t| t.surface.as_str()).collect::<Vec<_>>(), vec!["I", "😀", "am"]);
    }

    #[test]
    fn tokenize_word_rules() {
        let apostrophe = &tokenize("Students' work is done.")[0];
        assert_eq!(apostrophe.surface, "Students'");
        assert_eq!(apostrophe.normalized.as_deref(), Some("students"));
        assert!(apostrophe.is_word);

        let hyphen = &tokenize("A day-to-day job.")[1];
        assert_eq!(hyphen.surface, "day-to-day");

        for raw in ["1997", "150", "88,000"] {
            let tokens = tokenize(raw);
            assert_eq!(tokens.len(), 1, "{raw} 应是一个 token");
            assert!(!tokens[0].is_word, "{raw} 不是词");
            assert_eq!(tokens[0].normalized, None, "{raw} 无 normalized");
            assert_eq!(tokens[0].surface, raw);
        }
    }
}