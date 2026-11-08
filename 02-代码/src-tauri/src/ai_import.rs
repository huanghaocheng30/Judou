//! M5b AI 解析导入（02 D0）——「App 管结构、AI 只出语义」的后端唯一实现。
//!
//! 分工（违反即返工）：
//!   * **结构（段/句/词/偏移）只由 App 算一次**：复用 `import_user.rs` 的
//!     `clean_text`/`split_paragraphs`/`split_sentences`/`tokenize`；AI payload 里的
//!     `start`/`end`/`offset`/`tokens`/`paragraphs` **一律忽略**（AC8，靠 serde 不声明这些字段 + 不读）。
//!   * **本文件是校验与写库的唯一实现**：命令层（`commands.rs`）与门禁 bin（`ai_import_cli.rs`）
//!     都只调这里的函数，**不复制 SQL、不复制校验**（02 N4）。
//!
//! 校验分工（AC7 六形态的落点）：
//!   * `parse_payload`：容错解析（只取最外层 `{}`）+ ⑥ `section` 枚举 + markup 平衡（AC6/AC13/AC17）；
//!   * `validate_payload`：⑤ `payload.section` 与本次所选题型一致 → ① ② ③ 选项数（AC7）；
//!   * `match_payload`：④ cloze 空号集合（需要正文，故必须在这里）+ quote 匹配 + 答案归一 + 词条校验。
//!
//! **为什么 ⑤ 在 `validate_payload` 而不是 `parse_payload`**：⑤ 的判据是「与本次模板所选题型一致」，
//! `parse_ai_payload(text)` 只有一个参数（05 冻结签名），拿不到用户所选题型；若把 ①②③ 放在
//! `parse_payload` 里按 `payload.section` 判，则「section 写成 long、内容其实是 careful」的反例
//! 会先被 ① 报成 `questions[i].options`，与 AC7⑤ 要求的 `path="section"` 冲突。故 ①②③ 与 ⑤
//! 同处 `validate_payload`（先 ⑤ 后 ①②③），`parse_payload` 只做与 draft 无关的 ⑥ + markup。
//!
//! ponytail: 写库的「结构四表」直接复用 `import_user::commit_import`（本仓库已有 → 复用，不重写），
//! 分析四表在本文件另起一个事务；失败时补偿删除刚建的整篇，语义等价于单事务回滚。
//! 升级路径：若将来需要真正的单事务，把 `commit_import` 拆出一个「在给定 tx 内写结构」的内部函数即可。

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::commands::CommandError;
use crate::db::Db;
use crate::import_user::{self, ImportMeta, ImportParagraph, ImportPreview, ImportSentence, ImportStats, ImportToken};

/// 契约版本号（§三.1；不参与校验，不匹配只在界面提示「模板版本较旧」）
pub const PACK_VERSION: &str = "2026.11.08-1";
/// 模板建议批大小（§三.7：15 是建议值，不是硬上限）
pub const DEFAULT_BATCH_SIZE: u32 = 15;
/// 句子清单里每句原文展示的字符数（05 §十一之二：`S编号` + 原文前 24 字符）
const SENTENCE_PREVIEW_CHARS: usize = 24;

// ───────────────────────── 题型 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiSection {
    Careful,
    Long,
    Cloze,
}

impl AiSection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Careful => "careful",
            Self::Long => "long",
            Self::Cloze => "cloze",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "careful" => Some(Self::Careful),
            "long" => Some(Self::Long),
            "cloze" => Some(Self::Cloze),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Careful => "仔细阅读",
            Self::Long => "长篇阅读",
            Self::Cloze => "选词填空",
        }
    }
}

// ───────────────────────── IPC 形状（camelCase） ─────────────────────────

/// 三档需求（M5c 04 §6.2 第 2 步）：
/// - `plain`（档 A）：只要原文，不要求 AI 产出任何东西，可直接入库；
/// - `analysis`（档 B）：原文 + 解析（提示词带正文全文，不带题目区）；
/// - `full`（档 C，默认）：原文 + 题目答案 + 解析（另带题目区原文，档 C 逐字比对）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Plain,
    Analysis,
    #[default]
    Full,
}

impl ImportMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Analysis => "analysis",
            Self::Full => "full",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "plain" => Some(Self::Plain),
            "analysis" => Some(Self::Analysis),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
}

/// AI 模式入参：既有 `ImportPreview`（不动）+ 用户所选题型（02 §二.1 A4 落地）
/// + M5c 的三档需求与题目区原文（档 C 用它做逐字比对与 `answer_source` 判定）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDraft {
    pub preview: ImportPreview,
    pub section: AiSection,
    #[serde(default)]
    pub mode: ImportMode,
    #[serde(default)]
    pub question_text: Option<String>,
}

impl AiDraft {
    /// 题目区原文（空串 / 全空白 → `None`）
    pub fn question_area(&self) -> Option<&str> {
        self.question_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }
}

/// `build_ai_prompt` 的返回：整段可复制的提示词 + 分批元信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPrompt {
    pub text: String,
    pub section: AiSection,
    pub sentence_count: i64,
    pub batch_size: u32,
    pub batch_count: i64,
    pub batch_hint: Option<String>,
}

/// `parse_ai_payload` 的返回：容错解析结果 + 被丢弃的说明文字字符数（AC13）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiParseResult {
    pub payload: AiPayload,
    pub ignored_chars: i64,
}

/// 轻量语义包（§三.1）。未声明的字段（`paragraphs`/`tokens`/`start`/`end`/`offset`/
/// `sourceKey`/`articleId`/`meta`）由 serde 忽略——AC8 的根据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPayload {
    /// 可选：只用于「模板版本较旧」提示，不参与校验
    #[serde(default)]
    pub pack_version: Option<String>,
    pub section: String,
    pub sentences: Vec<AiSentence>,
    #[serde(default)]
    pub questions: Option<Vec<AiQuestion>>,
    #[serde(default)]
    pub blank_analyses: Option<Vec<AiBlankAnalysis>>,
    #[serde(default)]
    pub lexicon: Option<Vec<AiLexiconItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSentence {
    pub quote: String,
    pub analysis: AiAnalysis,
    /// 辅助编号（`S1`/`S2`…）：与 `quote` 冲突时以 `quote` 为准（AC18）
    #[serde(default)]
    pub s_no: Option<String>,
}

/// `analysis` 九字段（与 `sentence_analysis` 一一对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalysis {
    pub translation_literal: String,
    pub translation_natural: String,
    pub struct_markup: String,
    pub structure_summary: String,
    pub components: Vec<AiComponent>,
    #[serde(default)]
    pub clauses: Option<Vec<String>>,
    /// 重点短语。§三.2.1 契约要求 `string[]`（AI 给「短语文本」即可）；但 App 的展示形状是
    /// `AnalysisPhrase{text,meaning,usage,example}[]`（见 `types.ts` 的 `SentenceAnalysis`），
    /// 仓库内内容包也正是对象形态。故**入参两形态都收**，写库时由 `phrases_json_text` 做
    /// 零推断投影（字符串 → `{text, meaning:null, usage:null, example:null}`），六段式卡片才不会
    /// 渲染出空字段。这不是「模糊猜测字段别名」，是两处既有形状的对齐。
    #[serde(default)]
    pub phrases: Option<Vec<Value>>,
    #[serde(default)]
    pub pitfalls: Option<Vec<String>>,
    #[serde(default)]
    pub paragraph_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiComponent {
    pub part: String,
    pub role: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuestion {
    pub no: i64,
    pub stem: String,
    /// careful 每题 4 项 / long 每题 `[]` / cloze 每题 15 项（§三.3）
    #[serde(default)]
    pub options: Vec<AiOption>,
    /// 缺省或不在合法集合内 → 归一为无答案（AC16），不编造
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOption {
    pub key: String,
    pub text: String,
}

/// 逐空解析（§三.4）。
///
/// `distractors` 收成 `Value`：契约要求对象数组，源包给的是**字符串**——字符串形态按
/// 「非必填、忽略」处理，不做结构化解析（§六.1④）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBlankAnalysis {
    pub no: i64,
    pub answer_word: String,
    pub reason: String,
    #[serde(default)]
    pub distractors: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLexiconItem {
    pub word: String,
    #[serde(default)]
    pub phonetic: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
    pub sense: String,
    #[serde(default)]
    pub collocations: Option<Vec<String>>,
    #[serde(default)]
    pub examples: Option<Vec<String>>,
    #[serde(default)]
    pub is_cet4_high_freq: Option<bool>,
}

// ───────────────────────── 匹配结果 ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMatchedSentence {
    pub paragraph_idx: i64,
    pub sentence_idx: i64,
    pub quote: String,
    #[serde(default)]
    pub s_no: Option<String>,
    pub analysis: AiAnalysis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUnmatchedSentence {
    pub quote: String,
    #[serde(default)]
    pub s_no: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUnmatchedLexicon {
    pub word: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuestionOut {
    /// **批内槽位**（`questions[]` 的数组下标 0..N），**不是**题号，也不写库。
    /// 写 `question.idx` 的一律是 `no`（试卷题号；对齐既有 `import.rs` 与 `types.ts` 的约定）。
    pub idx: i64,
    pub no: i64,
    pub stem: String,
    pub options: Vec<AiOption>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
    pub missing_answer: bool,
    /// M5c AC8：`user` 用户给的 / `ai` AI 补的 / `none` 都没有（写 `question.answer_source`）
    pub answer_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBlankOut {
    pub no: i64,
    pub answer_word: String,
    pub answer_key: Option<String>,
    pub reason: String,
    pub distractors: Option<Vec<Value>>,
}

/// 四类覆盖率（§三.7）：`analysis`/`questions`/`blanks` 为 `x/y` 串，分母未知时只有 `x`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCoverage {
    pub analysis: String,
    pub questions: String,
    pub blanks: String,
    pub lexicon: i64,
}

/// `match_ai_payload` 的返回，也是 `commit_ai_import` 的入参（前端原样回传）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMatched {
    pub section: AiSection,
    pub matched: Vec<AiMatchedSentence>,
    pub unmatched: Vec<AiUnmatchedSentence>,
    pub unmatched_lexicon: Vec<AiUnmatchedLexicon>,
    pub questions: Vec<AiQuestionOut>,
    pub blanks: Vec<AiBlankOut>,
    pub lexicon: Vec<AiLexiconItem>,
    pub coverage: AiCoverage,
    /// AC18：`sNo` 与 `quote` 冲突、已按 `quote` 纠正的条数
    pub sno_fixed: i64,
    /// AC16：答案不在合法集合内、已归一为无答案的题数
    pub missing_answer: i64,
}

// ───────────────────────── 写库契约 ─────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitMeta {
    #[serde(default)]
    pub exam_type: Option<String>,
    #[serde(default)]
    pub exam_year: Option<i64>,
}

/// 覆盖率回读（`get_ai_import_stats`）：分子都来自库，分母只有句数已知
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiImportStats {
    pub sentences: i64,
    pub analysis_covered: i64,
    pub questions: i64,
    pub blanks: i64,
    pub lexicon: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitReport {
    pub article_id: i64,
    pub source_key: String,
    pub analysis_written: i64,
    pub questions_written: i64,
    pub blanks_written: i64,
    pub lexicon_inserted: i64,
    pub coverage: AiCoverage,
    pub stats: AiImportStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchReport {
    pub article_id: i64,
    pub analysis_written: i64,
    pub questions_written: i64,
    pub blanks_written: i64,
    pub lexicon_inserted: i64,
    pub stats: AiImportStats,
}

/// 编辑元信息（AC9）：**只改 article 行的元信息列**，不碰 `paragraph`/`sentence`/`token`
/// （原文是笔记与生词的坐标基准，04 §6.2 第 6 条）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleMetaPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub exam_type: Option<String>,
    #[serde(default)]
    pub exam_year: Option<i64>,
    #[serde(default)]
    pub section_type: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub difficulty: Option<String>,
}

/// 题目视图：`get_article_questions` 下发、`replace_article_questions` 入参（同一形状，零转换）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionView {
    pub no: i64,
    pub stem: String,
    #[serde(default)]
    pub options: Vec<AiOption>,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default = "default_answer_source")]
    pub answer_source: String,
}

fn default_answer_source() -> String {
    "none".to_string()
}

/// `--dump` 的读数（AC8/AC9/AC12 的机械判据）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArticleCounts {
    pub article_id: i64,
    pub paragraphs: i64,
    pub sentences: i64,
    pub tokens: i64,
    pub analyses: i64,
    pub questions: i64,
    pub blanks: i64,
    pub lexicon: i64,
    /// `paragraph`/`sentence`/`token` 三表内容哈希（结构是否被动过）
    pub structure_hash: String,
}

// ───────────────────────── 错误码（§五，4 码） ─────────────────────────

fn ai_err(code: &str, message: impl Into<String>, path: &str) -> CommandError {
    CommandError {
        code: code.to_string(),
        message: message.into(),
        path: Some(path.to_string()),
    }
}

fn payload_invalid(detail: &str) -> CommandError {
    ai_err(
        "AI_PAYLOAD_INVALID",
        format!("粘贴内容不是合法 JSON。请确认复制了完整的 `{{` … `}}` 块，且没有漏掉结尾的 `}}`（{detail}）"),
        "payload",
    )
}

fn type_mismatch(message: impl Into<String>, path: &str) -> CommandError {
    ai_err("AI_TYPE_MISMATCH", message, path)
}

fn markup_unbalanced(ordinal: usize, s_no: Option<&str>, problem: &str) -> CommandError {
    let label = s_no
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("S{}", ordinal + 1));
    ai_err(
        "AI_MARKUP_UNBALANCED",
        format!("第 {label} 句的结构标记不配平：{problem}。可点『跳过该句』继续导入"),
        &format!("sentences[{ordinal}].analysis.structMarkup"),
    )
}

fn no_match() -> CommandError {
    ai_err(
        "AI_NO_MATCH",
        "粘贴的解析与当前文章完全不匹配：请确认复制的是这篇文章的模板产物",
        "sentences",
    )
}

// ───────────────────────── ① build_prompt（纯字符串） ─────────────────────────

/// 生成提示词模板（05 §十一之二：「提示词模板 + 本批句子清单 + 题型片段」）。
/// 与 §三 契约同源：字段名、必填项、题型差异三者一致。
pub fn build_prompt(draft: &AiDraft, batch_size: u32) -> AiPrompt {
    let batch = if batch_size == 0 { DEFAULT_BATCH_SIZE } else { batch_size } as i64;
    let total = draft.preview.stats.sentence_count;
    let batch_count = if total <= 0 { 0 } else { (total + batch - 1) / batch };
    let batch_hint = if total > batch {
        Some(format!("建议分批（当前 {total} 句）"))
    } else {
        None
    };

    let mut out = String::new();
    if draft.mode == ImportMode::Plain {
        // 档 A：只读原文，不需要 AI 产出（AC2/AC6：提示词不要求 sentences[]/analysis）
        out.push_str("【档 A · 只要原文】\n");
        out.push_str("这篇只需要原文：不需要句级解析、不需要题目、不需要词条。\n");
        out.push_str("App 会自己切段、切句、分词并计算偏移；你不需要输出任何内容，也不需要复制这段提示词。\n");
        out.push_str("直接点「导入这篇文章」即可入库。\n");
        return AiPrompt {
            text: out,
            section: draft.section,
            sentence_count: total,
            batch_size: batch as u32,
            batch_count,
            batch_hint,
        };
    }

    out.push_str("你是一位英语四级阅读解析助手。请阅读 App 提供的英文原文，按下面的 JSON 契约输出**一个 JSON 对象**。\n\n");
    out.push_str("【总要求】\n");
    out.push_str("1. 只输出 JSON：不要 ``` 围栏，不要前后解释文字。\n");
    out.push_str("2. sentences[] 逐句给：quote 必须是原文该句的**逐字符拷贝**（含标点、引号、连字符）。App 用 quote 对齐句子，错一个字符这句就匹配不上。\n");
    out.push_str("3. 不要输出 start / end / offset / tokens / paragraphs 等位置与分词字段——App 自己算，你给的数字一律被忽略。\n");
    out.push_str(&format!(
        "4. section 必须回填 \"{}\"（与本次题型一致，不一致会被拒收）。\n",
        draft.section.as_str()
    ));
    out.push_str(&format!("5. packVersion 回填 \"{PACK_VERSION}\"。\n"));
    if draft.mode == ImportMode::Full {
        out.push_str(
            "6. 题目与答案**只对齐、不生成**：题干与选项必须逐字照抄用户给的题目区，禁止新增题目、禁止改写题干、禁止另编选项。\n\
   7. 用户已给答案的题，answer 照抄原值；用户没给答案的题可以补，但必须在该题写 answerSource: \"ai\"；用户给的答案写 answerSource: \"user\"；都没有就写 answerSource: \"none\"。\n",
        );
    }
    out.push('\n');
    out.push_str(&format!("【本次题型】{}（{}）\n", draft.section.label(), draft.section.as_str()));
    out.push_str(&section_notes(draft.section));
    out.push_str("\n【JSON 契约】\n");
    out.push_str(&json_skeleton(draft.section));
    out.push_str("\n\n");

    // M5c D0②（承重 2）：档 B/C 把**全篇正文按段落拼接、原样注入**（位置在句子清单之前）。
    // 判据（AC5）= 提示词去空白后包含正文全文去空白——不是「含首句」这类可被 24 字符前缀假命中的写法。
    let body_text: String = draft
        .preview
        .paragraphs
        .iter()
        .map(|paragraph| paragraph.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    out.push_str(&format!(
        "【正文全文】共 {} 段（逐句解析它；quote 必须是这里的逐字符拷贝，不要改写原文）\n",
        draft.preview.stats.paragraph_count
    ));
    out.push_str(&body_text);
    out.push_str("\n\n");

    // 档 C：题目区原文原样注入（含题干、选项与答案行）。档 B 明确**不带**题目区（AC6）。
    if draft.mode == ImportMode::Full {
        if let Some(questions) = draft.question_area() {
            out.push_str("【用户提供的题目与答案（档 C：逐字对齐，不得改写 / 不得新增）】\n");
            out.push_str(questions);
            out.push_str("\n\n");
        }
    }

    out.push_str(&format!(
        "【句子清单】共 {total} 句（按原文顺序；每行 = S 编号 + 原文前 {SENTENCE_PREVIEW_CHARS} 个字符）\n"
    ));

    let mut ordinal = 1usize;
    for paragraph in &draft.preview.paragraphs {
        for sentence in &paragraph.sentences {
            out.push_str(&format!(
                "S{ordinal}｜{}（第 {} 段第 {} 句）\n",
                sentence_preview(&sentence.text),
                paragraph.idx + 1,
                sentence.idx + 1
            ));
            ordinal += 1;
        }
    }
    out.push_str("\n【分批】");
    if total > batch {
        out.push_str(&format!(
            "当前 {total} 句 > 每批 {batch} 句，建议分 {batch_count} 批：每批只输出该批句子的解析；\
题目（questions）与 blankAnalyses / lexicon 可以只在第一批给，也可以每批重复——App 会按 quote 对齐累加，重复的以最后一次为准。\n"
        ));
    } else {
        out.push_str(&format!("当前 {total} 句 ≤ 每批 {batch} 句，一次可给完。\n"));
    }
    out.push_str("\n【提醒】正文已在上面的【正文全文】里给出，quote 必须是其中的逐字符拷贝；句子清单只是定位辅助。\n");

    AiPrompt {
        text: out,
        section: draft.section,
        sentence_count: total,
        batch_size: batch as u32,
        batch_count,
        batch_hint,
    }
}

// ───────────────────────── ①-b M5c · 正文区 / 题目区自动切分（04 §6.2.1） ─────────────────────────

/// 一次粘贴「原文 + 题目 + 答案」后的切分结果（02 §三.1 契约 + `question_count` 供界面显示 K 道题）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputSplit {
    pub body_text: String,
    pub question_text: String,
    /// 题目区起点（**1-based 行号**，与界面显示同口径）；`detected=false` 时为 None
    pub question_start_line: Option<usize>,
    pub detected: bool,
    pub reason: String,
    /// 题目区里命中题号正则的行数（AC3 的 K，N5 口径）
    pub question_count: i64,
}

/// 行首题号：`^\s*\d{1,3}\s*[.、．)]\s*\S`（02 §三.2；要求分隔符后**有非空字符**，排除纯数字短行）
fn question_no_of(line: &str) -> Option<i64> {
    let trimmed = line.trim_start();
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 3 {
        return None;
    }
    let rest = &trimmed[digits.len()..];
    let rest = rest.trim_start();
    let mut chars = rest.chars();
    match chars.next() {
        Some('.') | Some('、') | Some('．') | Some(')') => {}
        _ => return None,
    }
    if chars.as_str().trim_start().is_empty() {
        return None;
    }
    digits.parse::<i64>().ok()
}

/// 题型标题行（02 §三.2 第二类候选）
fn is_section_title_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["section ", "part ", "passage "] {
        if lower.starts_with(prefix) {
            return true;
        }
    }
    for prefix in ["directions:", "directions：", "questions "] {
        if lower.starts_with(prefix) {
            return true;
        }
    }
    for prefix in ["选词填空", "长篇阅读", "仔细阅读"] {
        if trimmed.starts_with(prefix) {
            return true;
        }
    }
    false
}

/// 选项行 / 答案行：切分确认窗口要跳过它们（同一道题的组成部分，不占「有效题行」额度）。
///
/// 注意顺序：题号行优先（`question_no_of` 命中就不算可跳过行），避免「46. A」这类怪行被误跳。
/// 选项字母用 **A~Z** 而不是 `option_of` 的 A~D：选词填空（cloze）一道题有 15 个选项 A~O，
/// 若只认 A~D，E~O 会被算成「有效题行」占满窗口 → `cloze.full.txt` 仍判 false（实测）。
/// `option_of` 保持 A~D 不动——它服务的是「题目逐字比对」的解析口径，放宽会污染档 C 校验。
fn is_option_or_answer_line(line: &str) -> bool {
    if question_no_of(line).is_some() {
        return false;
    }
    answer_of(line).is_some() || looks_like_option_line(line)
}

/// 宽松选项行判定（**只用于切分窗口跳过**）：单个 A~Z 字母 + `.`/`、`/`)`/`．` + 内容
fn looks_like_option_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some('A'..='Z') => {}
        _ => return false,
    }
    let mut rest_chars = chars.as_str().chars();
    match rest_chars.next() {
        Some('.') | Some('、') | Some(')') | Some('．') => !rest_chars.as_str().trim().is_empty(),
        _ => false,
    }
}

/// 正文区 / 题目区自动切分（02 §三.2 的可执行版）。
///
/// 规则：逐行扫描 → 题号行或题型标题行为候选 → 取最靠前候选 `L`；`L` 之后 **5 个有效题行**内
/// 题号行 ≥2 才确认（避免正文里的「2024.」被误判）→ 否则继续找下一候选；全不中 →
/// `detected=false` 且 `question_text` 为空串（**不猜**）。
///
/// ponytail: 确认窗口数的是「有效题行」＝非空行 − 选项行 − 答案行（02 §三.2 v1.3 修订，修 D-M5c-1）。
/// 两级演进原因：原口径「其后 5 个**原始行**」→ 空行会偷走额度；改成「5 个非空行」后仍不够——
/// 真实卷面「题干 1 行 + A/B/C/D 四个分行选项」里，4 个选项行同样能把窗口占满，依旧看不到
/// 下一个题号行（`careful.full.txt` / `cloze.full.txt` 实测仍判 false）。所以选项行与答案行
/// 也一并跳过：它们是**同一道题的组成部分**，不是独立的题。
/// 天花板：确认仍要求窗口内有第 2 个题号行——单题卷面（只有 1 道题）依旧判不出，走「手动标记
/// 题目区起点」逃生口（04 §6.2.1 第 4 条）。正文里孤立的「2024. was a hard year.」也只有
/// 1 个题号行，确认不过 → 「不猜」原则不变（有反例单测守）。
/// 升级路径：若还要放宽，只能动这一处窗口循环；不要改 `question_no_of` 的正则宽度（会引回误判）。
pub fn split_user_input(raw: &str) -> UserInputSplit {
    let lines: Vec<&str> = raw.lines().collect();
    let mut index = 0usize;
    while index < lines.len() {
        let candidate = question_no_of(lines[index]).is_some() || is_section_title_line(lines[index]);
        if candidate {
            // 窗口：其后 5 个**有效题行**（空行跳过；选项行 `A.`~`D.` 与答案行不占额度——
            // 它们是同一道题的组成部分，若占额度，「题干 + 4 选项」的卷面就永远看不到下一个题号）
            let mut confirm = 0usize;
            let mut seen = 0usize;
            let mut offset = 1usize;
            while seen < 5 {
                let Some(line) = lines.get(index + offset) else { break };
                offset += 1;
                if line.trim().is_empty() || is_option_or_answer_line(line) {
                    continue;
                }
                seen += 1;
                if question_no_of(line).is_some() {
                    confirm += 1;
                }
            }
            if confirm >= 2 {
                let question_count = lines[index..]
                    .iter()
                    .filter(|line| question_no_of(line).is_some())
                    .count() as i64;
                return UserInputSplit {
                    body_text: lines[..index].join("\n").trim_end().to_string(),
                    question_text: lines[index..].join("\n").trim_end().to_string(),
                    question_start_line: Some(index + 1),
                    detected: true,
                    reason: format!("第 {} 行起识别为题目区", index + 1),
                    question_count,
                };
            }
        }
        index += 1;
    }
    UserInputSplit {
        body_text: raw.trim_end().to_string(),
        question_text: String::new(),
        question_start_line: None,
        detected: false,
        reason: "没识别到题目区".to_string(),
        question_count: 0,
    }
}

/// 整卷里的一篇（02 §八 AC3 / D0）。行号一律 **1-based 闭区间**，与界面显示同口径。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PassageSpan {
    /// 篇序号（1-based）
    pub index: usize,
    /// 篇名：命中边界行的原文（截断 40 字符）；卷首无边界时是「卷首…」；整卷单篇时是「全文…」
    pub label: String,
    pub start_line: usize,
    pub end_line: usize,
    /// 该篇首个非空行的前 30 字符
    pub preview: String,
}

/// 篇边界行（02 §八 AC3 的四形态）——**防误切**是这里的重点：
/// 关键字必须独立成词（`Passages` / `Parts` 不算）；`Section` 后必须紧跟**单个** A~C 字母
/// （「Section of the market」「Section Co.」都不切）；`Part` 后必须是罗马数字/数字
/// （「Part of the reason」不切）；`Passage` 后必须是 One~Four 或 1~4；`Questions` 必须是 `N-M` 区间行。
///
/// ponytail: 只认卷面英文标记，含非 ASCII 小标题的行不参与分篇（中文卷面靠用户手动切）。
/// 天花板：真实卷面里「Section A Directions: …」这类**同行带说明**的标题算边界（字母后不粘字母数字即可），
/// 若将来要更严（要求整行只有标题），改这一处判定即可，不要动 `split_passages` 的切分骨架。
fn is_passage_boundary(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_lowercase();
    // 大小写变换若改了字节长度（极少数文字），按词切分的偏移会错位 → 直接不参与分篇
    if lower.len() != trimmed.len() {
        return false;
    }
    let tokens: Vec<&str> = lower.split_whitespace().collect();
    let Some(head) = tokens.first() else { return false };
    let first = tokens.get(1).copied().unwrap_or("");
    let digits = |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
    match *head {
        "section" => {
            let mut chars = first.chars();
            matches!(chars.next(), Some('a'..='c')) && chars.next().is_none()
        }
        "part" => {
            !first.is_empty()
                && first.chars().all(|c| {
                    matches!(c, 'i' | 'v' | 'x' | 'ⅰ' | 'ⅱ' | 'ⅲ' | 'ⅳ' | 'ⅴ' | 'ⅵ') || c.is_ascii_digit()
                })
        }
        "passage" => matches!(first, "one" | "two" | "three" | "four" | "1" | "2" | "3" | "4"),
        "questions" => match tokens.get(1..) {
            Some([single]) => match single.split_once(['-', '~']) {
                Some((a, b)) => digits(a) && digits(b),
                None => false,
            },
            Some([a, sep, b, ..]) => digits(a) && matches!(*sep, "-" | "~") && digits(b),
            _ => false,
        },
        _ => false,
    }
}

/// 取 `text` 的前 `limit` 个**字符**（不是字节——中文按字算）
fn first_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// 整卷多篇切分（02 §八 AC3 / D0）：按边界行切；**首篇从文件头起**；单篇返回单元素；空输入返回空。
///
/// 相邻的小标题（`Section B` 紧接 `Passage One`、中间无正文）合并为同一处边界，
/// 避免切出一篇「只有一行标题」的空壳篇。
pub fn split_passages(raw: &str) -> Vec<PassageSpan> {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.iter().all(|line| line.trim().is_empty()) {
        return Vec::new();
    }
    let mut bounds: Vec<usize> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if !is_passage_boundary(line) {
            continue;
        }
        if let Some(&prev) = bounds.last() {
            if !lines[prev + 1..idx].iter().any(|line| !line.trim().is_empty()) {
                continue;
            }
        }
        bounds.push(idx);
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    if bounds.is_empty() {
        spans.push((0, lines.len() - 1));
    } else {
        for (i, &start) in bounds.iter().enumerate() {
            let from = if i == 0 { 0 } else { start };
            let to = bounds.get(i + 1).map(|next| next - 1).unwrap_or(lines.len() - 1);
            spans.push((from, to));
        }
    }
    spans
        .iter()
        .enumerate()
        .map(|(i, &(from, to))| {
            let label = if bounds.is_empty() {
                "全文（未识别到分篇标记）".to_string()
            } else if bounds[i] == from {
                first_chars(lines[from].trim(), 40)
            } else {
                "卷首（第一个分篇标记之前）".to_string()
            };
            let preview = lines[from..=to]
                .iter()
                .find(|line| !line.trim().is_empty())
                .map(|line| first_chars(line.trim(), 30))
                .unwrap_or_default();
            PassageSpan { index: i + 1, label, start_line: from + 1, end_line: to + 1, preview }
        })
        .collect()
}

/// 用户题目区里的一道题（02 §三.4 的宽松解析结果）
#[derive(Debug, Clone, PartialEq, Eq)]
struct UserQuestion {
    no: i64,
    stem: String,
    options: Vec<String>,
    answer: Option<String>,
}

/// 选项行：`^[A-D][.、)]`
fn option_of(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let mut chars = trimmed.chars();
    let letter = chars.next()?;
    if !matches!(letter, 'A'..='D') {
        return None;
    }
    let rest = chars.as_str();
    let mut rest_chars = rest.chars();
    match rest_chars.next() {
        Some('.') | Some('、') | Some(')') | Some('．') => {}
        _ => return None,
    }
    Some(rest_chars.as_str().trim().to_string())
}

/// 答案行：`answer`/`答案` 前缀，或整行就是单个答案字母（02 §三.4）
fn answer_of(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["answer:", "answer：", "答案:", "答案：", "答案"] {
        if lower.starts_with(prefix) || trimmed.starts_with(prefix) {
            let value = trimmed[prefix.len()..].trim();
            return normalize_answer(value);
        }
    }
    normalize_answer(trimmed)
}

/// 答案归一：只保留字母（`B` / `B.` / `b` → `B`）；不是单字母就返回 None
fn normalize_answer(raw: &str) -> Option<String> {
    let letters: String = raw.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if letters.chars().count() != 1 {
        return None;
    }
    Some(letters.to_ascii_uppercase())
}

fn parse_user_questions(question_text: &str) -> Vec<UserQuestion> {
    let mut out: Vec<UserQuestion> = Vec::new();
    for line in question_text.lines() {
        if let Some(no) = question_no_of(line) {
            // 题号行之后的剩余部分即题干首行
            let rest = line.trim_start();
            let after_digits = rest.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start();
            let stem = after_digits
                .trim_start_matches(['.', '、', '．', ')'])
                .trim()
                .to_string();
            out.push(UserQuestion {
                no,
                stem,
                options: Vec::new(),
                answer: None,
            });
            continue;
        }
        let Some(current) = out.last_mut() else {
            continue;
        };
        if let Some(text) = option_of(line) {
            current.options.push(text);
            continue;
        }
        if let Some(answer) = answer_of(line) {
            current.answer = Some(answer);
            continue;
        }
        if !line.trim().is_empty() {
            if current.stem.is_empty() {
                current.stem = line.trim().to_string();
            } else {
                current.stem.push(' ');
                current.stem.push_str(line.trim());
            }
        }
    }
    out
}

fn question_mismatch(message: impl Into<String>, path: &str) -> CommandError {
    ai_err("AI_QUESTION_MISMATCH", message, path)
}

/// 去空白（档 C 逐字比对的唯一归一：只去空白，不改大小写、不改标点）
fn strip_ws(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn section_notes(section: AiSection) -> &'static str {
    match section {
        AiSection::Careful => {
            "- 每题 4 个 options（key 用 A/B/C/D），answer 必须是其中一个 key。\n\
- 题目编号按本卷实际题号填（仔细阅读常见 46~50）。\n\
- 句数一般 20 句左右，一次可给完。\n"
        }
        AiSection::Long => {
            "- 信息匹配题：每题 options 必须是空数组 `[]`，answer 是段落字母（A/B/C…）。\n\
- 题目编号按本卷实际题号填（长篇阅读常见 36~45）。\n\
- 47 句较长：建议按段落拆 2~4 批，每批 15 句上下。\n"
        }
        AiSection::Cloze => {
            "- 每题 options 必须是**全部 15 项词库**（`{key,text}`），不是单空答案；每题都必须 15 项。\n\
- 题目编号按本卷实际题号填（选词填空常见 26~35），并且必须与正文里出现的空号一一对应（正文写了 26~35，questions 就必须正好是 26~35）。\n\
- blankAnalyses[] 逐空给答案词与理由；distractors 给对象数组 `{key,word,why}`。少给几个空没关系（App 允许不完整），但**不能给正文里不存在的空号**。\n\
- 13 句，一次可给完。\n"
        }
    }
}

fn json_skeleton(section: AiSection) -> String {
    let questions = match section {
        AiSection::Careful => {
            "  \"questions\": [\n\
    {\"no\": 46, \"stem\": \"题干\", \"options\": [\n\
      {\"key\": \"A\", \"text\": \"选项A\"}, {\"key\": \"B\", \"text\": \"选项B\"},\n\
      {\"key\": \"C\", \"text\": \"选项C\"}, {\"key\": \"D\", \"text\": \"选项D\"}],\n\
     \"answer\": \"B\", \"explanation\": \"为什么选 B\"}\n\
  ],\n"
        }
        AiSection::Long => {
            "  \"questions\": [\n\
    {\"no\": 36, \"stem\": \"题干\", \"options\": [], \"answer\": \"I\", \"explanation\": \"为什么是 I 段\"}\n\
  ],\n"
        }
        AiSection::Cloze => {
            "  \"questions\": [\n\
    {\"no\": 26, \"stem\": \"第 26 空\", \"options\": [\n\
      {\"key\": \"A\", \"text\": \"单词A\"}, {\"key\": \"B\", \"text\": \"单词B\"}\n\
      /* … 共 15 项 A~O … */],\n\
     \"answer\": \"O\"}\n\
  ],\n\
  \"blankAnalyses\": [\n\
    {\"no\": 26, \"answerWord\": \"单词O\", \"reason\": \"为什么选它\",\n\
     \"distractors\": [{\"key\": \"D\", \"word\": \"单词D\", \"why\": \"为什么不行\"}]}\n\
  ],\n"
        }
    };
    format!(
        "{{\n\
  \"packVersion\": \"{PACK_VERSION}\",\n\
  \"section\": \"{}\",\n\
  \"sentences\": [\n\
    {{\"sNo\": \"S1\", \"quote\": \"原文第一句（逐字符拷贝）\", \"analysis\": {{\n\
      \"translationLiteral\": \"逐句直译\",\n\
      \"translationNatural\": \"通顺中文\",\n\
      \"structMarkup\": \"【主语】People _谓语_ wonder ~why~ {{宾语从句}}\",\n\
      \"structureSummary\": \"主谓 + 宾语从句\",\n\
      \"components\": [{{\"part\": \"People\", \"role\": \"主语\", \"note\": \"复数泛指\"}}],\n\
      \"clauses\": [\"why 引导宾语从句\"], \"phrases\": [], \"pitfalls\": [], \"paragraphRole\": \"开篇引出话题\"}}}}\n\
  ],\n\
{}\
  \"lexicon\": [\n\
    {{\"word\": \"wonder\", \"phonetic\": \"/ˈwʌndə/\", \"pos\": \"v.\", \"sense\": \"想知道\",\n\
     \"collocations\": [\"wonder why\"], \"examples\": [\"I wonder why. 我想知道为什么。\"], \"isCet4HighFreq\": true}}\n\
  ]\n\
}}",
        section.as_str(),
        questions
    )
}

/// 原文前 24 个**字符**（不是字节，也不是 UTF-16 单位）
fn sentence_preview(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= SENTENCE_PREVIEW_CHARS {
        return text.to_string();
    }
    let mut out: String = chars[..SENTENCE_PREVIEW_CHARS].iter().collect();
    out.push('…');
    out
}

// ───────────────────────── ② parse_payload（容错解析） ─────────────────────────

/// 容错解析：只取**最外层 `{}`**（首个 `{` 到与之匹配的 `}`），围栏与前后说明文字全部丢弃并计数。
/// 之后做 ⑥ `section` 枚举校验与 markup 平衡校验（AC6/AC13/AC17）。
pub fn parse_payload(text: &str) -> Result<AiParseResult, CommandError> {
    let (slice, ignored_chars) = extract_outermost_object(text)
        .ok_or_else(|| payload_invalid("没有找到 `{` … `}` 块"))?;
    let payload: AiPayload = serde_json::from_str(slice)
        .map_err(|err| payload_invalid(&format!("JSON 解析失败：{err}")))?;

    if AiSection::parse(&payload.section).is_none() {
        return Err(type_mismatch(
            format!(
                "`section` 只能是 careful / long / cloze 三者之一，当前是「{}」。请在导入页选对题型后重新生成模板。",
                payload.section
            ),
            "section",
        ));
    }

    for (ordinal, sentence) in payload.sentences.iter().enumerate() {
        if let Some(problem) = markup_problem(&sentence.analysis.struct_markup) {
            return Err(markup_unbalanced(ordinal, sentence.s_no.as_deref(), &problem));
        }
    }

    Ok(AiParseResult {
        payload,
        ignored_chars: ignored_chars as i64,
    })
}

/// 取最外层 `{}`（跳过字符串字面量里的花括号）→ (切片, 被丢弃的字符数)
fn extract_outermost_object(text: &str) -> Option<(&str, usize)> {
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, ch) in text.char_indices() {
        if start.is_none() {
            if ch == '{' {
                start = Some(index);
                depth = 1;
            }
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(index + ch.len_utf8());
                    break;
                }
            }
            _ => {}
        }
    }

    let (start, end) = (start?, end?);
    let ignored = text[..start].chars().count() + text[end..].chars().count();
    Some((&text[start..end], ignored))
}

/// 结构标记配平（AC6）：`_`/`~` 必须偶数次，`【】`/`{}`/`()` 必须配对。
/// 返回 `Some(问题描述)` 表示不配平。
fn markup_problem(markup: &str) -> Option<String> {
    let underscores = markup.matches('_').count();
    if underscores % 2 == 1 {
        return Some(format!("`_` 出现 {underscores} 次（必须成对）"));
    }
    let tildes = markup.matches('~').count();
    if tildes % 2 == 1 {
        return Some(format!("`~` 出现 {tildes} 次（必须成对）"));
    }

    let mut stack: Vec<char> = Vec::new();
    for ch in markup.chars() {
        match ch {
            '【' => stack.push('【'),
            '】' => {
                if stack.pop() != Some('【') {
                    return Some("`【】` 不配对".to_string());
                }
            }
            '{' => stack.push('{'),
            '}' => {
                if stack.pop() != Some('{') {
                    return Some("`{}` 不配对".to_string());
                }
            }
            '(' => stack.push('('),
            ')' => {
                if stack.pop() != Some('(') {
                    return Some("`()` 不配对".to_string());
                }
            }
            _ => {}
        }
    }
    match stack.pop() {
        Some(open) => Some(format!("`{open}` 未闭合")),
        None => None,
    }
}

// ───────────────────────── ③ validate_payload（AC7 ①~⑤） ─────────────────────────

/// 形态校验：⑤ 题型一致 → ① ② ③ 选项数。④（cloze 空号集合）需要正文，落在 `match_payload`。
pub fn validate_payload(expected: AiSection, payload: &AiPayload) -> Result<(), CommandError> {
    let got = AiSection::parse(&payload.section).ok_or_else(|| {
        type_mismatch(
            format!(
                "`section` 只能是 careful / long / cloze 三者之一，当前是「{}」。",
                payload.section
            ),
            "section",
        )
    })?;

    // ⑤ 与本次模板所选题型一致
    if got != expected {
        return Err(type_mismatch(
            format!(
                "题型不一致：本批模板是「{}」（{}），粘贴的 payload 里 section 是「{}」（{}）。\
请在导入页选对题型后重新复制模板，或让 AI 把 section 改回 {}。",
                expected.label(),
                expected.as_str(),
                got.label(),
                got.as_str(),
                expected.as_str()
            ),
            "section",
        ));
    }

    if let Some(questions) = &payload.questions {
        for (index, question) in questions.iter().enumerate() {
            match expected {
                // ① 长篇信息匹配题无选项
                AiSection::Long => {
                    if !question.options.is_empty() {
                        return Err(type_mismatch(
                            format!(
                                "长篇阅读的题目不应带选项（第 {} 题有 {} 个选项）；长篇信息匹配题的 `options` 必须是空数组 `[]`，`answer` 写段落字母。",
                                question.no,
                                question.options.len()
                            ),
                            &format!("questions[{index}].options"),
                        ));
                    }
                }
                // ② 仔细阅读每题 4 项
                AiSection::Careful => {
                    if question.options.len() != 4 {
                        return Err(type_mismatch(
                            format!(
                                "仔细阅读第 {} 题应有 4 个选项，当前给了 {} 个。请让 AI 补齐 A/B/C/D 四项。",
                                question.no,
                                question.options.len()
                            ),
                            &format!("questions[{index}].options"),
                        ));
                    }
                }
                // ③ 选词填空每题 15 项（全部词库项）
                AiSection::Cloze => {
                    if question.options.len() != 15 {
                        return Err(type_mismatch(
                            format!(
                                "选词填空第 {} 题的 `options` 应是**全部 15 项词库**，当前给了 {} 项。请让 AI 每题都给 A~O 十五项。",
                                question.no,
                                question.options.len()
                            ),
                            &format!("questions[{index}].options"),
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}

/// 按 payload 结构推断「最可能」的题型（M5c 优化轮 AC1）。
///
/// **纯函数、无 IO、不做任何校验**：它只回答「这包看起来是哪种题型」，供前端在
/// `AI_TYPE_MISMATCH` 之后给用户一条可执行的下一步。**本函数永不决定切换**——真正切题型
/// 必须用户点确认（02 §七 三问裁定第 3 条：不自动猜并静默切换）。
///
/// 判据（按优先级，先命中先返回）：
/// 1. 全部题 `options` 为空串数组 **且** `answer` 是单个字母 → 长篇信息匹配（段落字母 L/B/G）；
/// 2. 任一题 `options` 恰好 15 项 → 选词填空（A~O 全部词库）；
/// 3. 任一题 `options` 恰好 4 项 → 仔细阅读（A/B/C/D）；
/// 4. 其余（无题、题数形态混合、选项数既非 4 也非 15）→ `None`＝不敢猜。
///
/// `questions` 为 `None`/空数组一律 `None`：没有题目就没有可判形态，猜了也只能猜错。
pub fn suggest_section(payload: &AiPayload) -> Option<AiSection> {
    let questions = payload.questions.as_ref().filter(|list| !list.is_empty())?;

    let all_blank_with_letter = questions
        .iter()
        .all(|question| question.options.is_empty() && is_single_letter(question.answer.as_deref()));
    if all_blank_with_letter {
        return Some(AiSection::Long);
    }
    if questions.iter().any(|question| question.options.len() == 15) {
        return Some(AiSection::Cloze);
    }
    if questions.iter().any(|question| question.options.len() == 4) {
        return Some(AiSection::Careful);
    }
    None
}

/// `answer` 是否为「单个 ASCII 字母」（长篇阅读的段落字母；空白与全角不算）
fn is_single_letter(raw: Option<&str>) -> bool {
    match raw.map(str::trim) {
        Some(text) => {
            let mut chars = text.chars();
            matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_alphabetic())
        }
        None => false,
    }
}

// ───────────────────────── ④ match_payload ─────────────────────────

/// 正文空号集合（§三.4.1）：App 自算 token 流，**去尾部标点**后为纯 ASCII 数字、且落在题号区间。
///
/// 为什么不能直接 `surface.parse::<i32>()`：既有分词会把数字与紧跟的逗号吞成一个 token
/// （实测源包 `surface` 为 `"28,"`），直接 parse 会失败 → 正例被误判为形态错误。
pub fn body_blank_nos(preview: &ImportPreview, range: Option<(i64, i64)>) -> BTreeSet<i64> {
    let mut out = BTreeSet::new();
    for paragraph in &preview.paragraphs {
        for sentence in &paragraph.sentences {
            for token in &sentence.tokens {
                if token.is_word {
                    continue;
                }
                let trimmed = token
                    .surface
                    .trim_end_matches(|c: char| matches!(c, ',' | '.' | ';' | ':' | '!' | '?' | '"' | '\'' | ')' | ']' | '）' | '”' | '’'));
                if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let Ok(value) = trimmed.parse::<i64>() else {
                    continue;
                };
                if let Some((min, max)) = range {
                    if value < min || value > max {
                        continue;
                    }
                }
                out.insert(value);
            }
        }
    }
    out
}

/// `quote` 匹配 + 答案归一 + 词条在正文校验 + 四类覆盖率（05 约束 2/3）。
pub fn match_payload(draft: &AiDraft, payload: &AiPayload) -> Result<AiMatched, CommandError> {
    validate_payload(draft.section, payload)?;
    let section = draft.section;

    // ④ cloze 的结构一致性（A1 裁决：只拒形态错误；blankAnalyses 真子集放行）
    let question_nos: BTreeSet<i64> = payload
        .questions
        .as_ref()
        .map(|questions| questions.iter().map(|question| question.no).collect())
        .unwrap_or_default();
    let range = if question_nos.is_empty() {
        None
    } else {
        Some((
            *question_nos.iter().next().unwrap_or(&0),
            *question_nos.iter().next_back().unwrap_or(&0),
        ))
    };
    let body_nos = body_blank_nos(&draft.preview, range);
    // ④ 只在「有题号区间 `R`」时判定（02 §三.1 缺省口径）：无 `questions` → 无 `R` → ④ 整体跳过、
    // **不拒收**，`blankAnalyses` 照常入库，逐空覆盖率只显示已解析数 `k`。
    if section == AiSection::Cloze && !question_nos.is_empty() {
        // AC7④ 的「重号」：`question_nos` 是 `BTreeSet`，重复号会被去重吃掉 → 先按 `Vec` 计重号
        let mut seen_nos: HashMap<i64, usize> = HashMap::new();
        for question in payload.questions.iter().flatten() {
            *seen_nos.entry(question.no).or_insert(0) += 1;
        }
        let mut duplicated: Vec<i64> = seen_nos
            .iter()
            .filter(|(_, count)| **count > 1)
            .map(|(no, _)| *no)
            .collect();
        duplicated.sort_unstable();
        if !duplicated.is_empty() {
            return Err(type_mismatch(
                format!(
                    "选词填空的题号有重复：{} 出现了两次以上。请让 AI 每道题只给一次（多号/少号/重号都会被拒收）。",
                    duplicated
                        .iter()
                        .map(i64::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                "blankAnalyses",
            ));
        }
        if question_nos != body_nos {
            return Err(type_mismatch(
                format!(
                    "选词填空的空号对不上：正文里的空号是 {{ {} }}，questions 里的题号是 {{ {} }}。请让 AI 按正文空号给题（多号/少号/重号都会被拒收）。",
                    join_nos(&body_nos),
                    join_nos(&question_nos)
                ),
                "blankAnalyses",
            ));
        }
        for blank in payload.blank_analyses.iter().flatten() {
            if !body_nos.contains(&blank.no) {
                return Err(type_mismatch(
                    format!(
                        "blankAnalyses 里有正文中不存在的空号 {}：正文空号是 {{ {} }}。请删掉这一条或改成正文里的空号。",
                        blank.no,
                        join_nos(&body_nos)
                    ),
                    "blankAnalyses",
                ));
            }
        }
    }

    // quote 匹配：按句序取第一条未被占用的句子（同文重复句按出现顺序对齐）
    struct Candidate {
        paragraph_idx: i64,
        sentence_idx: i64,
        normalized: String,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    for paragraph in &draft.preview.paragraphs {
        for sentence in &paragraph.sentences {
            candidates.push(Candidate {
                paragraph_idx: paragraph.idx,
                sentence_idx: sentence.idx,
                normalized: normalize_quote(&sentence.text),
            });
        }
    }
    let mut used = vec![false; candidates.len()];
    let mut matched: Vec<AiMatchedSentence> = Vec::new();
    let mut unmatched: Vec<AiUnmatchedSentence> = Vec::new();
    let mut sno_fixed = 0i64;

    for sentence in &payload.sentences {
        let normalized = normalize_quote(&sentence.quote);
        if normalized.is_empty() {
            unmatched.push(AiUnmatchedSentence {
                quote: sentence.quote.clone(),
                s_no: sentence.s_no.clone(),
                reason: "这条解析的 quote 是空的".to_string(),
            });
            continue;
        }
        let hit = candidates
            .iter()
            .enumerate()
            .find(|(index, candidate)| !used[*index] && candidate.normalized == normalized);
        match hit {
            Some((index, _)) => {
                used[index] = true;
                let (paragraph_idx, sentence_idx) = (candidates[index].paragraph_idx, candidates[index].sentence_idx);
                // AC18：sNo 只是辅助，与 quote 冲突时以 quote 为准（并按真实序号纠正）
                if let Some(raw_no) = sentence.s_no.as_deref() {
                    if let Some(declared) = trailing_number(raw_no) {
                        if declared != sentence_ordinal(&draft.preview, paragraph_idx, sentence_idx) {
                            sno_fixed += 1;
                        }
                    }
                }
                matched.push(AiMatchedSentence {
                    paragraph_idx,
                    sentence_idx,
                    quote: sentence.quote.clone(),
                    s_no: sentence.s_no.clone(),
                    analysis: sentence.analysis.clone(),
                });
            }
            None => unmatched.push(AiUnmatchedSentence {
                quote: sentence.quote.clone(),
                s_no: sentence.s_no.clone(),
                reason: "这段文字在原文里找不到（AI 可能改写了原文，quote 必须逐字符一致）".to_string(),
            }),
        }
    }

    // 部分不匹配不是错误（进 unmatched 由用户处置）；一句都没命中才是 AI_NO_MATCH
    if matched.is_empty() && !unmatched.is_empty() {
        return Err(no_match());
    }

    // 答案归一（AC16：不编造、不猜、不补）
    let paragraph_count = draft.preview.stats.paragraph_count;
    let mut questions: Vec<AiQuestionOut> = Vec::new();
    let mut missing_answer = 0i64;
    // 档 C：用户题目区原文 → 用于逐字比对与 answer_source 判定（02 §三.4 / §三.5）
    let user_questions: Option<Vec<UserQuestion>> = if draft.mode == ImportMode::Full {
        draft.question_area().map(parse_user_questions)
    } else {
        None
    };
    for (index, question) in payload.questions.iter().flatten().enumerate() {
        let raw = question
            .answer
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let mut answer = raw.clone();
        let mut missing = false;
        if let Some(current) = &raw {
            let valid = match section {
                AiSection::Careful | AiSection::Cloze => {
                    question.options.iter().any(|option| option.key.eq_ignore_ascii_case(current))
                }
                AiSection::Long => is_paragraph_letter(current, paragraph_count),
            };
            if !valid {
                answer = None;
                missing = true;
                missing_answer += 1;
            }
        } else {
            missing = true;
            missing_answer += 1;
        }

        // M5c AC7/AC8：档 C 逐字比对（题干 / 选项 / 答案）与 answer_source 三值
        let mut answer_source = "none".to_string();
        if let Some(user_list) = &user_questions {
            let user = user_list.iter().find(|item| item.no == question.no);
            match user {
                Some(item) => {
                    if strip_ws(&item.stem) != strip_ws(&question.stem) {
                        return Err(question_mismatch(
                            format!(
                                "第 {} 题的题干与你给的题目区不一致：题目只能对齐、不能改写。请让 AI 逐字照抄题目区，或修正题目区后重试。",
                                question.no
                            ),
                            &format!("questions[{index}].stem"),
                        ));
                    }
                    let payload_options: Vec<String> =
                        question.options.iter().map(|option| strip_ws(&option.text)).collect();
                    let user_options: Vec<String> = item.options.iter().map(|text| strip_ws(text)).collect();
                    if payload_options != user_options {
                        return Err(question_mismatch(
                            format!(
                                "第 {} 题的选项与你给的题目区不一致：选项必须逐字照抄题目区（不得另编）。",
                                question.no
                            ),
                            &format!("questions[{index}].options"),
                        ));
                    }
                    if let Some(user_answer) = &item.answer {
                        match answer.as_deref() {
                            Some(got) if got.eq_ignore_ascii_case(user_answer) => {
                                answer_source = "user".to_string();
                            }
                            _ => {
                                return Err(question_mismatch(
                                    format!(
                                        "第 {} 题的答案与题目区里给的答案不一致：你给的是 {}，题目区写的是 {}。答案只能对齐，不能改写。",
                                        question.no,
                                        answer.as_deref().unwrap_or("<无>"),
                                        user_answer
                                    ),
                                    &format!("questions[{index}].answer"),
                                ));
                            }
                        }
                    } else if answer.is_some() {
                        answer_source = "ai".to_string();
                    }
                }
                None => {
                    return Err(question_mismatch(
                        format!(
                            "第 {} 题不在你给的题目区里：题目只能对齐、禁止新增。请让 AI 不要输出题目区之外的题。",
                            question.no
                        ),
                        &format!("questions[{index}].stem"),
                    ));
                }
            }
        } else if answer.is_some() {
            answer_source = "ai".to_string();
        }

        questions.push(AiQuestionOut {
            idx: index as i64,
            no: question.no,
            stem: question.stem.clone(),
            options: question.options.clone(),
            answer: answer.clone(),
            explanation: question.explanation.clone(),
            missing_answer: missing,
            answer_source,
        });
    }

    // 逐空解析（distractors 只收对象数组，字符串形态按非必填忽略）
    let mut blanks: Vec<AiBlankOut> = Vec::new();
    for blank in payload.blank_analyses.iter().flatten() {
        let answer_key = questions
            .iter()
            .find(|question| question.no == blank.no)
            .and_then(|question| {
                question
                    .options
                    .iter()
                    .find(|option| option.text.eq_ignore_ascii_case(blank.answer_word.trim()))
                    .map(|option| option.key.clone())
            });
        let distractors = match &blank.distractors {
            Some(Value::Array(items)) => Some(items.clone()),
            _ => None,
        };
        blanks.push(AiBlankOut {
            no: blank.no,
            answer_word: blank.answer_word.clone(),
            answer_key,
            reason: blank.reason.clone(),
            distractors,
        });
    }

    // 词条必须在正文出现（按 token normalized 比对，大小写不敏感；AC15）
    let token_keys = word_keys(&draft.preview);
    let mut lexicon: Vec<AiLexiconItem> = Vec::new();
    let mut unmatched_lexicon: Vec<AiUnmatchedLexicon> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in payload.lexicon.iter().flatten() {
        let key = normalize_lexicon_key(&item.word);
        if key.is_empty() || !token_keys.contains(&key) {
            unmatched_lexicon.push(AiUnmatchedLexicon {
                word: item.word.clone(),
                reason: "词条不在正文".to_string(),
            });
            continue;
        }
        if !seen.insert(key) {
            continue;
        }
        lexicon.push(item.clone());
    }

    let total_sentences = draft.preview.stats.sentence_count.max(0);
    let question_total = payload.questions.as_ref().map(|items| items.len() as i64).unwrap_or(0);
    let coverage = AiCoverage {
        analysis: format!("{}/{}", matched.len(), total_sentences),
        questions: if question_total == 0 {
            "-".to_string()
        } else {
            format!("{}/{}", questions.len(), question_total)
        },
        blanks: match section {
            AiSection::Cloze => {
                if question_nos.is_empty() {
                    format!("{}", blanks.len())
                } else {
                    format!("{}/{}", blanks.len(), body_nos.len())
                }
            }
            _ => "-".to_string(),
        },
        lexicon: lexicon.len() as i64,
    };

    Ok(AiMatched {
        section,
        matched,
        unmatched,
        unmatched_lexicon,
        questions,
        blanks,
        lexicon,
        coverage,
        sno_fixed,
        missing_answer,
    })
}

fn join_nos(nos: &BTreeSet<i64>) -> String {
    nos.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")
}

/// `S12` / `s12` / `12` → 12
fn trailing_number(raw: &str) -> Option<i64> {
    let digits: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok()
}

/// 该句在全文的 1-based 序号（全篇句序，不按段重置）
fn sentence_ordinal(preview: &ImportPreview, paragraph_idx: i64, sentence_idx: i64) -> i64 {
    let mut ordinal = 0i64;
    for paragraph in &preview.paragraphs {
        for sentence in &paragraph.sentences {
            ordinal += 1;
            if paragraph.idx == paragraph_idx && sentence.idx == sentence_idx {
                return ordinal;
            }
        }
    }
    ordinal
}

/// long 的 answer 必须是正文实际段落字母集内（A、B、C… 按段数）
fn is_paragraph_letter(answer: &str, paragraph_count: i64) -> bool {
    let trimmed = answer.trim();
    if trimmed.chars().count() != 1 {
        return false;
    }
    let ch = trimmed.chars().next().unwrap_or(' ');
    if !ch.is_ascii_uppercase() {
        return false;
    }
    let index = ch as i64 - 'A' as i64 + 1;
    index >= 1 && index <= paragraph_count.max(0)
}

/// 正文里出现过的词（小写 normalized 集合），用于词条校验
fn word_keys(preview: &ImportPreview) -> HashSet<String> {
    let mut out = HashSet::new();
    for paragraph in &preview.paragraphs {
        for sentence in &paragraph.sentences {
            for token in &sentence.tokens {
                if token.is_word {
                    out.insert(normalize_lexicon_key(&token.surface));
                }
            }
        }
    }
    out
}

/// `normalized` 规则：小写 + 去尾部撇号（对齐 `import_user::normalize_surface`）
fn normalize_lexicon_key(word: &str) -> String {
    word.trim()
        .to_lowercase()
        .trim_end_matches(['\'', '\u{2019}'])
        .to_string()
}

/// `quote` 匹配口径（05 约束 2）：小写 + 折叠空白 + 去首尾标点
fn normalize_quote(text: &str) -> String {
    let lowered = text.to_lowercase();
    let collapsed = lowered.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_matches(|c: char| c.is_whitespace() || is_edge_punct(c))
        .to_string()
}

fn is_edge_punct(c: char) -> bool {
    matches!(
        c,
        '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '(' | ')' | '[' | ']' | '“' | '”' | '‘' | '’' | '（' | '）' | '【' | '】' | '…' | '—'
    )
}

// ───────────────────────── ⑤ 库层写库函数（SQL 只在本文件） ─────────────────────────

/// 结构四表复用既有实现（`import_user::commit_import`）；分析四表另起事务。
/// 任一步失败 → 补偿删除刚建的整篇（等价于单事务回滚，不给库里留半套）。
pub fn commit_ai_import(
    db: &Db,
    draft: &AiDraft,
    matched: &AiMatched,
    meta: &AiCommitMeta,
) -> Result<AiCommitReport, CommandError> {
    // 档 A（plain）：只要原文，不要求任何解析 → `matched` 为空也必须能入库（AC2）。
    if matched.matched.is_empty() && draft.mode != ImportMode::Plain {
        return Err(no_match());
    }
    let import_meta = ImportMeta {
        exam_type: meta.exam_type.clone(),
        exam_year: meta.exam_year,
    };
    let committed = import_user::commit_import(db, &draft.preview, &import_meta)?;
    let article_id = committed.article_id;

    let written = db.write(|tx| {
        // 题型落库：patch 模式 `data-ai-section` 的初值来源（02 §二 D4）
        tx.execute(
            "UPDATE article SET section_type = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![draft.section.as_str(), article_id],
        )
        .map_err(|err| CommandError::db("写题型", err))?;
        write_analysis_rows(tx, article_id, matched, true)
    });

    let counts = match written {
        Ok(counts) => counts,
        Err(err) => {
            // 补偿：整篇删掉（paragraph/sentence/token 走 ON DELETE CASCADE）
            let _ = db.write(|tx| {
                tx.execute("DELETE FROM article WHERE id = ?1", params![article_id])
                    .map(|_| ())
                    .map_err(|inner| CommandError::db("回滚文章", inner))
            });
            return Err(err);
        }
    };

    let stats = get_ai_import_stats(db, article_id)?;
    Ok(AiCommitReport {
        article_id,
        source_key: committed.source_key,
        analysis_written: counts.analysis,
        questions_written: counts.questions,
        blanks_written: counts.blanks,
        lexicon_inserted: counts.lexicon,
        coverage: matched.coverage.clone(),
        stats,
    })
}

/// 后补解析：**只写** `sentence_analysis`/`question`/`lexicon`/`blank` 四张解析表，
/// 不动 `paragraph`/`sentence`/`token`（05 约束 6：笔记与生词引用不失效）。
///
/// M5c（05 §十一之三）：`draft` 为 `Some` 时——档 C 的逐字比对与 `answer_source` 判定在
/// `match_payload` 里已经按同一个 `draft` 做完，这里再用 `draft.section` 复核题型一致
/// （拿错模板的 matched 写进来会被挡下），并把题型回写到 `article.section_type`。
///
/// M5c 回退兼容：`draft` 为 `None`（M5b 版导入页只传 `matched`）时**跳过**题型复核、
/// 不回写 `article.section_type`、且不写 `question.answer_source`（列保持默认 `'none'`），
/// 其余行为不变。
pub fn patch_ai_analysis(
    db: &Db,
    article_id: i64,
    draft: Option<&AiDraft>,
    matched: &AiMatched,
) -> Result<AiPatchReport, CommandError> {
    ensure_article(db, article_id)?;
    let counts = match draft {
        Some(draft) => {
            if matched.section != draft.section {
                return Err(type_mismatch(
                    format!(
                        "题型不一致：本次模板是「{}」（{}），待写入的解析是「{}」（{}）。请用同一题型重新匹配后再补解析。",
                        draft.section.label(),
                        draft.section.as_str(),
                        matched.section.label(),
                        matched.section.as_str()
                    ),
                    "section",
                ));
            }
            db.write(|tx| {
                tx.execute(
                    "UPDATE article SET section_type = ?1, updated_at = datetime('now') WHERE id = ?2",
                    params![draft.section.as_str(), article_id],
                )
                .map_err(|err| CommandError::db("写题型", err))?;
                write_analysis_rows(tx, article_id, matched, true)
            })?
        }
        None => db.write(|tx| write_analysis_rows(tx, article_id, matched, false))?,
    };
    let stats = get_ai_import_stats(db, article_id)?;
    Ok(AiPatchReport {
        article_id,
        analysis_written: counts.analysis,
        questions_written: counts.questions,
        blanks_written: counts.blanks,
        lexicon_inserted: counts.lexicon,
        stats,
    })
}

struct WriteCounts {
    analysis: i64,
    questions: i64,
    blanks: i64,
    lexicon: i64,
}

// ───────────────────────── ⑥ M5c · 编辑元信息 / 题目（AC9/AC10；SQL 只在本文件） ─────────────────────────

/// 改元信息：标题 / 考试类型 / 年份 / 题型 / 来源 / 难度。**只 UPDATE article 一行**。
pub fn update_article_meta(db: &Db, article_id: i64, patch: &ArticleMetaPatch) -> Result<(), CommandError> {
    ensure_article(db, article_id)?;
    if let Some(exam_type) = patch.exam_type.as_deref() {
        if !matches!(exam_type, "cet4" | "cet6" | "other") {
            return Err(CommandError {
                code: "ARTICLE_META_INVALID".to_string(),
                message: format!("考试类型只能是 cet4 / cet6 / other，当前是「{exam_type}」。"),
                path: Some("examType".to_string()),
            });
        }
    }
    if let Some(title) = patch.title.as_deref() {
        if title.trim().is_empty() {
            return Err(CommandError {
                code: "ARTICLE_META_INVALID".to_string(),
                message: "标题不能为空。".to_string(),
                path: Some("title".to_string()),
            });
        }
    }
    db.write(|tx| {
        tx.execute(
            "UPDATE article SET
               title        = COALESCE(?1, title),
               exam_type    = COALESCE(?2, exam_type),
               exam_year    = COALESCE(?3, exam_year),
               section_type = COALESCE(?4, section_type),
               source       = COALESCE(?5, source),
               difficulty   = COALESCE(?6, difficulty),
               updated_at   = datetime('now')
             WHERE id = ?7",
            params![
                patch.title.as_deref().map(str::trim),
                patch.exam_type.as_deref(),
                patch.exam_year,
                patch.section_type.as_deref(),
                patch.source.as_deref(),
                patch.difficulty.as_deref(),
                article_id,
            ],
        )
        .map(|_| ())
        .map_err(|err| CommandError::db("更新文章元信息", err))
    })
}

/// 读该篇题目（编辑面板初值）：`idx` 即试卷题号
pub fn get_article_questions(db: &Db, article_id: i64) -> Result<Vec<QuestionView>, CommandError> {
    db.read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT idx, stem, options_json, answer, explanation, answer_source
                 FROM question WHERE article_id = ?1 ORDER BY idx",
            )
            .map_err(|err| CommandError::db("准备题目查询", err))?;
        let rows = stmt
            .query_map([article_id], |row| {
                let options_json: Option<String> = row.get(2)?;
                Ok(QuestionView {
                    no: row.get(0)?,
                    stem: row.get(1)?,
                    options: options_json
                        .as_deref()
                        .and_then(|raw| serde_json::from_str::<Vec<AiOption>>(raw).ok())
                        .unwrap_or_default(),
                    answer: row.get(3)?,
                    explanation: row.get(4)?,
                    answer_source: row.get(5)?,
                })
            })
            .map_err(|err| CommandError::db("查询题目", err))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| CommandError::db("读取题目", err))?);
        }
        Ok(out)
    })
}

/// 整批替换该篇题目（AC10）：**只写 `question` 表**，原文与笔记不动；`answer_source` 原样保留。
pub fn replace_article_questions(
    db: &Db,
    article_id: i64,
    questions: &[QuestionView],
) -> Result<Vec<QuestionView>, CommandError> {
    ensure_article(db, article_id)?;
    db.write(|tx| {
        tx.execute("DELETE FROM question WHERE article_id = ?1", [article_id])
            .map_err(|err| CommandError::db("清空旧题目", err))?;
        let mut stmt = tx
            .prepare(
                "INSERT INTO question (article_id, idx, stem, options_json, answer, explanation, answer_source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|err| CommandError::db("准备题目写入", err))?;
        for question in questions {
            stmt.execute(params![
                article_id,
                question.no,
                question.stem.as_str(),
                serde_json::to_string(&question.options).unwrap_or_else(|_| "[]".to_string()),
                question.answer.as_deref(),
                question.explanation.as_deref(),
                question.answer_source.as_str(),
            ])
            .map_err(|err| CommandError::db("写入题目", err))?;
        }
        Ok(())
    })?;
    get_article_questions(db, article_id)
}

/// 四张解析表的唯一写入实现（commit 与 patch 共用；命令层与 bin 都不得复制）
///
/// `write_answer_source`：M5c 回退兼容开关。`false` 时 `question.answer_source` 不进 SQL，
/// 新行取列默认 `'none'`、冲突更新时保留库中原值（对应「调用方没给 draft」的 M5b 路径）。
fn write_analysis_rows(
    tx: &rusqlite::Transaction<'_>,
    article_id: i64,
    matched: &AiMatched,
    write_answer_source: bool,
) -> Result<WriteCounts, CommandError> {
    // (paragraph.idx, sentence.idx) → sentence.id
    let mut sentence_ids: HashMap<(i64, i64), i64> = HashMap::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT p.idx, s.idx, s.id FROM sentence s
                 JOIN paragraph p ON p.id = s.paragraph_id
                 WHERE s.article_id = ?1",
            )
            .map_err(|err| CommandError::db("准备句子索引查询", err))?;
        let rows = stmt
            .query_map([article_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })
            .map_err(|err| CommandError::db("查询句子索引", err))?;
        for row in rows {
            let (paragraph_idx, sentence_idx, sentence_id) = row.map_err(|err| CommandError::db("读取句子索引", err))?;
            sentence_ids.insert((paragraph_idx, sentence_idx), sentence_id);
        }
    }

    // ① sentence_analysis：1:1 于 sentence，同一句再给视为修订
    let mut analysis = 0i64;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO sentence_analysis
                   (sentence_id, translation_literal, translation_natural, struct_markup,
                    structure_summary, paragraph_role, components_json, clauses_json,
                    phrases_json, pitfalls_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(sentence_id) DO UPDATE SET
                   translation_literal = excluded.translation_literal,
                   translation_natural = excluded.translation_natural,
                   struct_markup       = excluded.struct_markup,
                   structure_summary   = excluded.structure_summary,
                   paragraph_role      = excluded.paragraph_role,
                   components_json     = excluded.components_json,
                   clauses_json        = excluded.clauses_json,
                   phrases_json        = excluded.phrases_json,
                   pitfalls_json       = excluded.pitfalls_json",
            )
            .map_err(|err| CommandError::db("准备解析写入", err))?;
        for item in &matched.matched {
            let Some(sentence_id) = sentence_ids.get(&(item.paragraph_idx, item.sentence_idx)).copied() else {
                continue;
            };
            let analysis_row = &item.analysis;
            stmt.execute(params![
                sentence_id,
                analysis_row.translation_literal.as_str(),
                analysis_row.translation_natural.as_str(),
                analysis_row.struct_markup.as_str(),
                analysis_row.structure_summary.as_str(),
                analysis_row.paragraph_role.as_deref(),
                json_array_text_components(&analysis_row.components),
                json_array_text(analysis_row.clauses.as_deref()),
                phrases_json_text(analysis_row.phrases.as_deref()),
                json_array_text(analysis_row.pitfalls.as_deref()),
            ])
            .map_err(|err| CommandError::db("写入解析", err))?;
            analysis += 1;
        }
    }

    // ② question：(article_id, idx) 唯一；`idx` 写**试卷题号**（payload `questions[].no`，
    //    与 `blank.blank_no` 同源，对齐既有 `import.rs` 的 `question.no` 约定），重复补解析按题号修订
    //    M5c AC8：commit 与 patch 共用这一处写入，所以两条路径的 `answer_source` 天然一致。
    //    M5c 回退兼容：`write_answer_source=false`（调用方未给 draft）时该列不进 SQL。
    let mut questions = 0i64;
    if write_answer_source {
        let mut stmt = tx
            .prepare(
                "INSERT INTO question (article_id, idx, stem, options_json, answer, explanation, answer_source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(article_id, idx) DO UPDATE SET
                   stem = excluded.stem,
                   options_json = excluded.options_json,
                   answer = excluded.answer,
                   explanation = excluded.explanation,
                   answer_source = excluded.answer_source",
            )
            .map_err(|err| CommandError::db("准备题目写入", err))?;
        for question in &matched.questions {
            stmt.execute(params![
                article_id,
                question.no,
                question.stem.as_str(),
                serde_json::to_string(&question.options).unwrap_or_else(|_| "[]".to_string()),
                question.answer.as_deref(),
                question.explanation.as_deref(),
                question.answer_source.as_str(),
            ])
            .map_err(|err| CommandError::db("写入题目", err))?;
            questions += 1;
        }
    } else {
        let mut stmt = tx
            .prepare(
                "INSERT INTO question (article_id, idx, stem, options_json, answer, explanation)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(article_id, idx) DO UPDATE SET
                   stem = excluded.stem,
                   options_json = excluded.options_json,
                   answer = excluded.answer,
                   explanation = excluded.explanation",
            )
            .map_err(|err| CommandError::db("准备题目写入（无 draft）", err))?;
        for question in &matched.questions {
            stmt.execute(params![
                article_id,
                question.no,
                question.stem.as_str(),
                serde_json::to_string(&question.options).unwrap_or_else(|_| "[]".to_string()),
                question.answer.as_deref(),
                question.explanation.as_deref(),
            ])
            .map_err(|err| CommandError::db("写入题目（无 draft）", err))?;
            questions += 1;
        }
    }

    // ③ blank：(article_id, blank_no) 唯一
    let mut blanks = 0i64;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO blank (article_id, blank_no, answer_key, answer_word, reason, distractors)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(article_id, blank_no) DO UPDATE SET
                   answer_key = excluded.answer_key,
                   answer_word = excluded.answer_word,
                   reason = excluded.reason,
                   distractors = excluded.distractors",
            )
            .map_err(|err| CommandError::db("准备逐空解析写入", err))?;
        for blank in &matched.blanks {
            let distractors = blank
                .distractors
                .as_ref()
                .map(|items| serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string()));
            stmt.execute(params![
                article_id,
                blank.no,
                blank.answer_key.as_deref(),
                blank.answer_word.as_str(),
                blank.reason.as_str(),
                distractors,
            ])
            .map_err(|err| CommandError::db("写入逐空解析", err))?;
            blanks += 1;
        }
    }

    // ④ lexicon：INSERT OR IGNORE（N9：不覆盖内置 1561 词库，冲突不报错）
    let mut lexicon = 0i64;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO lexicon
                   (normalized, word, phonetic, pos, sense, collocations_json, examples_json,
                    is_cet_high_freq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|err| CommandError::db("准备词条写入", err))?;
        for item in &matched.lexicon {
            let normalized = normalize_lexicon_key(&item.word);
            if normalized.is_empty() {
                continue;
            }
            let affected = stmt
                .execute(params![
                    normalized,
                    item.word.as_str(),
                    item.phonetic.as_deref(),
                    item.pos.as_deref(),
                    item.sense.as_str(),
                    json_array_text(item.collocations.as_deref()),
                    json_array_text(item.examples.as_deref()),
                    i32::from(item.is_cet4_high_freq.unwrap_or(false)),
                ])
                .map_err(|err| CommandError::db("写入词条", err))?;
            lexicon += affected as i64;
        }
    }

    Ok(WriteCounts {
        analysis,
        questions,
        blanks,
        lexicon,
    })
}

fn json_array_text(items: Option<&[String]>) -> String {
    match items {
        Some(values) => serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    }
}

fn json_array_text_components(items: &[AiComponent]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

/// `phrases_json` 的写入口径：字符串项投影成展示对象（零推断），对象项原样保留。
fn phrases_json_text(items: Option<&[Value]>) -> String {
    let Some(items) = items else {
        return "[]".to_string();
    };
    let normalized: Vec<Value> = items
        .iter()
        .map(|item| match item {
            Value::String(text) => serde_json::json!({
                "text": text,
                "meaning": Value::Null,
                "usage": Value::Null,
                "example": Value::Null,
            }),
            other => other.clone(),
        })
        .collect();
    serde_json::to_string(&normalized).unwrap_or_else(|_| "[]".to_string())
}

fn ensure_article(db: &Db, article_id: i64) -> Result<(), CommandError> {
    let exists = db.read(|conn| {
        conn.query_row("SELECT EXISTS(SELECT 1 FROM article WHERE id = ?1)", [article_id], |row| {
            row.get::<_, bool>(0)
        })
        .map_err(|err| CommandError::db("查篇目存在性", err))
    })?;
    if exists {
        Ok(())
    } else {
        Err(CommandError {
            code: "article_not_found".to_string(),
            message: format!("文章 #{article_id} 不存在。"),
            path: None,
        })
    }
}

/// 覆盖率回读：解析 x/y 句（分母 = 库里句数）、题目/空 n、词条 n（正文里出现过的词条数）
pub fn get_ai_import_stats(db: &Db, article_id: i64) -> Result<AiImportStats, CommandError> {
    db.read(|conn| {
        conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM sentence WHERE article_id = ?1),
               (SELECT COUNT(*) FROM sentence_analysis sa
                  JOIN sentence s ON s.id = sa.sentence_id WHERE s.article_id = ?1),
               (SELECT COUNT(*) FROM question WHERE article_id = ?1),
               (SELECT COUNT(*) FROM blank WHERE article_id = ?1),
               (SELECT COUNT(DISTINCT t.normalized) FROM token t
                  JOIN sentence s ON s.id = t.sentence_id
                 WHERE s.article_id = ?1 AND t.is_word = 1
                   AND t.normalized IN (SELECT normalized FROM lexicon))",
            [article_id],
            |row| {
                Ok(AiImportStats {
                    sentences: row.get(0)?,
                    analysis_covered: row.get(1)?,
                    questions: row.get(2)?,
                    blanks: row.get(3)?,
                    lexicon: row.get(4)?,
                })
            },
        )
        .map_err(|err| CommandError::db("读取 AI 导入覆盖率", err))
    })
}

/// 把库里已入库的文章读成 `ImportPreview`（补解析用；bin 与 patch 分支的入参来源）。
/// 第二项是 `article.section_type` 原样值——为 `NULL` 或不在枚举内时由前端要求用户选。
pub fn preview_from_article(
    db: &Db,
    article_id: i64,
) -> Result<(ImportPreview, Option<String>), CommandError> {
    db.read(|conn| {
        let title: String = conn
            .query_row("SELECT title FROM article WHERE id = ?1", [article_id], |row| row.get(0))
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => CommandError {
                    code: "article_not_found".to_string(),
                    message: format!("文章 #{article_id} 不存在。"),
                    path: None,
                },
                other => CommandError::db("查询文章", other),
            })?;
        let section_type: Option<String> = conn
            .query_row("SELECT section_type FROM article WHERE id = ?1", [article_id], |row| row.get(0))
            .map_err(|err| CommandError::db("查询题型", err))?;

        let mut paragraphs: Vec<ImportParagraph> = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT idx, text FROM paragraph WHERE article_id = ?1 ORDER BY idx")
                .map_err(|err| CommandError::db("准备段落查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .map_err(|err| CommandError::db("查询段落", err))?;
            for row in rows {
                let (idx, text) = row.map_err(|err| CommandError::db("读取段落", err))?;
                paragraphs.push(ImportParagraph {
                    idx,
                    text,
                    sentences: Vec::new(),
                });
            }
        }

        let mut order: HashMap<i64, usize> = HashMap::new();
        for (position, paragraph) in paragraphs.iter().enumerate() {
            order.insert(paragraph.idx, position);
        }

        let mut stats = ImportStats {
            paragraph_count: paragraphs.len() as i64,
            ..ImportStats::default()
        };
        {
            let mut stmt = conn
                .prepare(
                    "SELECT p.idx, s.idx, s.start_offset, s.end_offset, s.text, s.id
                     FROM sentence s JOIN paragraph p ON p.id = s.paragraph_id
                     WHERE s.article_id = ?1 ORDER BY p.idx, s.idx",
                )
                .map_err(|err| CommandError::db("准备句子查询", err))?;
            let rows = stmt
                .query_map([article_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .map_err(|err| CommandError::db("查询句子", err))?;
            let mut collected: Vec<(i64, i64, i64, i64, String, i64)> = Vec::new();
            for row in rows {
                collected.push(row.map_err(|err| CommandError::db("读取句子", err))?);
            }
            drop(stmt);

            let mut token_stmt = conn
                .prepare(
                    "SELECT start_offset, end_offset, surface, normalized, is_word
                     FROM token WHERE sentence_id = ?1 ORDER BY idx",
                )
                .map_err(|err| CommandError::db("准备词查询", err))?;
            for (paragraph_idx, sentence_idx, start, end, text, sentence_id) in collected {
                let tokens: Vec<ImportToken> = token_stmt
                    .query_map([sentence_id], |row| {
                        let is_word: bool = row.get(4)?;
                        Ok(ImportToken {
                            start: row.get(0)?,
                            end: row.get(1)?,
                            surface: row.get(2)?,
                            normalized: if is_word { row.get::<_, Option<String>>(3)? } else { None },
                            is_word,
                        })
                    })
                    .map_err(|err| CommandError::db("查询词", err))?
                    .filter_map(Result::ok)
                    .collect();
                stats.sentence_count += 1;
                stats.token_count += tokens.len() as i64;
                stats.word_count += tokens.iter().filter(|token| token.is_word).count() as i64;
                if let Some(position) = order.get(&paragraph_idx).copied() {
                    paragraphs[position].sentences.push(ImportSentence {
                        idx: sentence_idx,
                        start,
                        end,
                        text,
                        tokens,
                    });
                }
            }
        }

        Ok((
            ImportPreview {
                title,
                paragraphs,
                stats,
            },
            section_type,
        ))
    })
}

/// `--dump` 读数：三结构表行数 + 解析/题目/空/词条数 + 三结构表内容哈希
pub fn article_counts(db: &Db, article_id: i64) -> Result<AiArticleCounts, CommandError> {
    db.read(|conn| {
        let scalar = |sql: &str| -> Result<i64, CommandError> {
            conn.query_row(sql, [article_id], |row| row.get::<_, i64>(0))
                .map_err(|err| CommandError::db("读取行数", err))
        };
        let paragraphs = scalar("SELECT COUNT(*) FROM paragraph WHERE article_id = ?1")?;
        let sentences = scalar("SELECT COUNT(*) FROM sentence WHERE article_id = ?1")?;
        let tokens = scalar(
            "SELECT COUNT(*) FROM token t JOIN sentence s ON s.id = t.sentence_id WHERE s.article_id = ?1",
        )?;
        let analyses = scalar(
            "SELECT COUNT(*) FROM sentence_analysis sa JOIN sentence s ON s.id = sa.sentence_id WHERE s.article_id = ?1",
        )?;
        let questions = scalar("SELECT COUNT(*) FROM question WHERE article_id = ?1")?;
        let blanks = scalar("SELECT COUNT(*) FROM blank WHERE article_id = ?1")?;
        // lexicon 是全局词库（无 article_id 列），不能带参数绑到这条查询上
        let lexicon = conn
            .query_row("SELECT COUNT(*) FROM lexicon", [], |row| row.get::<_, i64>(0))
            .map_err(|err| CommandError::db("读取词条行数", err))?;
        let structure_hash = structure_hash(conn, article_id)?;
        Ok(AiArticleCounts {
            article_id,
            paragraphs,
            sentences,
            tokens,
            analyses,
            questions,
            blanks,
            lexicon,
            structure_hash,
        })
    })
}

/// `paragraph`/`sentence`/`token` 三表内容哈希：AC9「补解析不改原文结构」的机械判据
fn structure_hash(conn: &rusqlite::Connection, article_id: i64) -> Result<String, CommandError> {
    let mut hasher = Sha256::new();
    {
        let mut stmt = conn
            .prepare("SELECT idx, text FROM paragraph WHERE article_id = ?1 ORDER BY idx")
            .map_err(|err| CommandError::db("准备段落哈希", err))?;
        let rows = stmt
            .query_map([article_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|err| CommandError::db("哈希段落", err))?;
        for row in rows {
            let (idx, text) = row.map_err(|err| CommandError::db("读取段落哈希", err))?;
            hasher.update(format!("P{idx}\u{1f}{text}\u{1e}").as_bytes());
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT p.idx, s.idx, s.start_offset, s.end_offset, s.text
                 FROM sentence s JOIN paragraph p ON p.id = s.paragraph_id
                 WHERE s.article_id = ?1 ORDER BY p.idx, s.idx",
            )
            .map_err(|err| CommandError::db("准备句子哈希", err))?;
        let rows = stmt
            .query_map([article_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|err| CommandError::db("哈希句子", err))?;
        for row in rows {
            let (paragraph_idx, sentence_idx, start, end, text) =
                row.map_err(|err| CommandError::db("读取句子哈希", err))?;
            hasher.update(format!("S{paragraph_idx}.{sentence_idx}\u{1f}{start}\u{1f}{end}\u{1f}{text}\u{1e}").as_bytes());
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT p.idx, s.idx, t.idx, t.surface, t.normalized, t.is_word, t.start_offset, t.end_offset
                 FROM token t JOIN sentence s ON s.id = t.sentence_id
                 JOIN paragraph p ON p.id = s.paragraph_id
                 WHERE s.article_id = ?1 ORDER BY p.idx, s.idx, t.idx",
            )
            .map_err(|err| CommandError::db("准备词哈希", err))?;
        let rows = stmt
            .query_map([article_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|err| CommandError::db("哈希词", err))?;
        for row in rows {
            let (paragraph_idx, sentence_idx, token_idx, surface, normalized, is_word, start, end) =
                row.map_err(|err| CommandError::db("读取词哈希", err))?;
            hasher.update(
                format!(
                    "T{paragraph_idx}.{sentence_idx}.{token_idx}\u{1f}{surface}\u{1f}{normalized}\u{1f}{}\u{1f}{start}\u{1f}{end}\u{1e}",
                    i32::from(is_word)
                )
                .as_bytes(),
            );
        }
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

// ───────────────────────── 单测 ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_user::parse_import_preview;
    use serde_json::json;

    fn preview_of(text: &str) -> ImportPreview {
        parse_import_preview(text, None).expect("样例应能解析")
    }

    fn draft_of(text: &str, section: AiSection) -> AiDraft {
        AiDraft {
            preview: preview_of(text),
            section,
            mode: ImportMode::Full,
            question_text: None,
        }
    }

    fn analysis(markup: &str) -> Value {
        json!({
            "translationLiteral": "直译",
            "translationNatural": "意译",
            "structMarkup": markup,
            "structureSummary": "主谓宾",
            "components": [{"part": "People", "role": "主语", "note": "复数"}],
            "clauses": [],
            "phrases": [],
            "pitfalls": []
        })
    }

    fn payload_of(value: Value) -> AiPayload {
        serde_json::from_value(value).expect("payload 形状应合法")
    }

    fn cloze_options(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| json!({"key": ((b'A' + index as u8) as char).to_string(), "text": format!("w{index}")}))
            .collect()
    }

    // ── ① 空号提取：第一条就锁 "28,"（审核员建议，防 N2 回归） ──
    #[test]
    fn body_blank_nos_locks_comma_tail_and_range() {
        let preview = preview_of("Text 26. more 28, and 600,000 people 300 years.");
        let got: Vec<i64> = body_blank_nos(&preview, Some((26, 35))).into_iter().collect();
        assert_eq!(got, vec![26, 28], "\"28,\" 必须去尾逗号后计入；600,000/300 必须排除");
    }

    #[test]
    fn body_blank_nos_without_range_keeps_all_pure_numbers() {
        let preview = preview_of("Text 26. more 28, and 600,000 people 300 years.");
        let got: Vec<i64> = body_blank_nos(&preview, None).into_iter().collect();
        assert_eq!(got, vec![26, 28, 300]);
    }

    // ── AC13 容错解析 ──
    #[test]
    fn parse_strips_fence_and_prose() {
        let raw = format!(
            "这是说明文字\n```json\n{}\n```\n后面还有说明",
            json!({"section":"careful","sentences":[{"quote":"Hi.","analysis":analysis("")}]})
        );
        let parsed = parse_payload(&raw).expect("围栏 + 说明文字应能解析");
        assert_eq!(parsed.payload.sentences.len(), 1);
        assert!(parsed.ignored_chars > 0, "被丢弃的说明文字必须计数");
    }

    #[test]
    fn parse_rejects_not_json() {
        let err = parse_payload("我完全不是一个 JSON").unwrap_err();
        assert_eq!(err.code, "AI_PAYLOAD_INVALID");
        assert_eq!(err.path.as_deref(), Some("payload"));
    }

    #[test]
    fn parse_rejects_invalid_section() {
        let raw = json!({"section":"reading","sentences":[]}).to_string();
        let err = parse_payload(&raw).unwrap_err();
        assert_eq!(err.code, "AI_TYPE_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("section"));
    }

    // ── AC7 形态校验 ──
    #[test]
    fn validate_rejects_section_mismatch() {
        let payload = payload_of(json!({
            "section": "long",
            "sentences": [],
            "questions": [{"no": 46, "stem": "s", "options": [], "answer": "A"}]
        }));
        let err = validate_payload(AiSection::Careful, &payload).unwrap_err();
        assert_eq!(err.code, "AI_TYPE_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("section"));
    }

    #[test]
    fn validate_rejects_long_with_options() {
        let payload = payload_of(json!({
            "section": "long",
            "sentences": [],
            "questions": [{"no": 36, "stem": "s", "options": [{"key":"A","text":"a"}], "answer": "A"}]
        }));
        let err = validate_payload(AiSection::Long, &payload).unwrap_err();
        assert_eq!(err.code, "AI_TYPE_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("questions[0].options"));
    }

    #[test]
    fn validate_rejects_careful_three_options() {
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [],
            "questions": [{"no": 46, "stem": "s", "options": [{"key":"A","text":"a"}], "answer": "A"}]
        }));
        let err = validate_payload(AiSection::Careful, &payload).unwrap_err();
        assert_eq!(err.path.as_deref(), Some("questions[0].options"));
    }

    #[test]
    fn validate_rejects_cloze_fourteen_options() {
        let payload = payload_of(json!({
            "section": "cloze",
            "sentences": [],
            "questions": [{"no": 26, "stem": "第 26 空", "options": cloze_options(14), "answer": "A"}]
        }));
        let err = validate_payload(AiSection::Cloze, &payload).unwrap_err();
        assert_eq!(err.path.as_deref(), Some("questions[0].options"));
    }

    /// AC7④：`blankAnalyses[].no` 有不在正文空号集合里的号 → 拒收
    // ── M5c 优化轮 AC1：suggest_section 三推断 + 不敢猜 ──
    #[test]
    fn suggest_long_when_every_question_is_blank_with_letter() {
        // 用户实测的真实形态：选「仔细阅读」但粘的是长篇阅读卷面（43~45 题、答案段落字母）
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [],
            "questions": [
                {"no": 43, "stem": "s1", "options": [], "answer": "L"},
                {"no": 44, "stem": "s2", "options": [], "answer": "B"},
                {"no": 45, "stem": "s3", "options": [], "answer": "G"}
            ]
        }));
        assert_eq!(suggest_section(&payload), Some(AiSection::Long));
    }

    #[test]
    fn suggest_cloze_when_any_question_has_fifteen_options() {
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [],
            "questions": [
                {"no": 26, "stem": "s", "options": cloze_options(15), "answer": "A"}
            ]
        }));
        assert_eq!(suggest_section(&payload), Some(AiSection::Cloze));
    }

    #[test]
    fn suggest_careful_when_any_question_has_four_options() {
        let payload = payload_of(json!({
            "section": "long",
            "sentences": [],
            "questions": [
                {"no": 46, "stem": "s", "options": four_options(["a", "b", "c", "d"]), "answer": "A"}
            ]
        }));
        assert_eq!(suggest_section(&payload), Some(AiSection::Careful));
    }

    #[test]
    fn suggest_none_without_questions() {
        // 无题 / 空数组：没有可判形态，猜了也只能猜错
        let no_field = payload_of(json!({"section": "careful", "sentences": []}));
        assert_eq!(suggest_section(&no_field), None);
        let empty = payload_of(json!({"section": "careful", "sentences": [], "questions": []}));
        assert_eq!(suggest_section(&empty), None);
    }

    #[test]
    fn suggest_none_when_shape_is_unrecognized() {
        // 选项数既非 4 也非 15、且不是「空选项 + 字母答案」→ 不敢猜
        let odd_options = payload_of(json!({
            "section": "careful",
            "sentences": [],
            "questions": [{"no": 46, "stem": "s", "options": four_options(["a", "b", "c", "d"])[..3].to_vec(), "answer": "A"}]
        }));
        assert_eq!(suggest_section(&odd_options), None);
        // 空选项但答案不是单字母（如 "AB"）→ 也不构成长篇形态
        let long_answer = payload_of(json!({
            "section": "long",
            "sentences": [],
            "questions": [{"no": 43, "stem": "s", "options": [], "answer": "AB"}]
        }));
        assert_eq!(suggest_section(&long_answer), None);
    }

    #[test]
    fn match_rejects_cloze_blank_no_outside_body() {
        let draft = draft_of("Text 26. more 28, and 30 years.", AiSection::Cloze);
        let payload = payload_of(json!({
            "section": "cloze",
            "sentences": [],
            "questions": [
                {"no": 26, "stem": "第 26 空", "options": cloze_options(15), "answer": "A"},
                {"no": 28, "stem": "第 28 空", "options": cloze_options(15), "answer": "A"},
                {"no": 30, "stem": "第 30 空", "options": cloze_options(15), "answer": "A"}
            ],
            "blankAnalyses": [{"no": 99, "answerWord": "w0", "reason": "r"}]
        }));
        let err = match_payload(&draft, &payload).unwrap_err();
        assert_eq!(err.code, "AI_TYPE_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("blankAnalyses"));
    }

    /// R2（AC7④「重号」）：同一题号出现两次必须拒收；`BTreeSet` 的去重不得把重号吃掉
    #[test]
    fn match_rejects_cloze_duplicate_question_no() {
        let draft = draft_of("Text 26. more 28, and 30 years.", AiSection::Cloze);
        let payload = payload_of(json!({
            "section": "cloze",
            "sentences": [],
            "questions": [
                {"no": 26, "stem": "第 26 空", "options": cloze_options(15), "answer": "A"},
                {"no": 28, "stem": "第 28 空", "options": cloze_options(15), "answer": "A"},
                {"no": 30, "stem": "第 30 空", "options": cloze_options(15), "answer": "A"},
                {"no": 30, "stem": "第 30 空（重复）", "options": cloze_options(15), "answer": "A"}
            ]
        }));
        let err = match_payload(&draft, &payload).unwrap_err();
        assert_eq!(err.code, "AI_TYPE_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("blankAnalyses"));
        assert!(err.message.contains("重复"), "错误文案要点明重号：{}", err.message);
    }

    /// R3（02 §三.1 缺省口径）：cloze 无 `questions` → ④ 跳过、不拒收，逐空只显示已解析数
    #[test]
    fn cloze_without_questions_is_accepted() {
        let draft = draft_of("Text 26. more 28, and 30 years.", AiSection::Cloze);
        let payload = payload_of(json!({
            "section": "cloze",
            "sentences": [],
            "blankAnalyses": [
                {"no": 26, "answerWord": "w0", "reason": "r"},
                {"no": 28, "answerWord": "w1", "reason": "r"},
                {"no": 30, "answerWord": "w2", "reason": "r"}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("cloze 缺 questions 必须放行（AC7④ 跳过）");
        assert_eq!(matched.blanks.len(), 3);
        assert_eq!(matched.coverage.questions, "-", "无题时题目覆盖率显示 -");
        assert_eq!(matched.coverage.blanks, "3", "分母未知时只显示已解析数 k");
    }

    // ── AC6 markup ──
    #[test]
    fn markup_unbalanced_is_rejected() {
        let raw = json!({"section":"careful","sentences":[{"quote":"Hi.","analysis":analysis("_主语_ _谓语")}]}).to_string();
        let err = parse_payload(&raw).unwrap_err();
        assert_eq!(err.code, "AI_MARKUP_UNBALANCED");
        assert_eq!(err.path.as_deref(), Some("sentences[0].analysis.structMarkup"));
    }

    // ── AC5 / AC18 / AC8 / AC15 / AC16 ──
    #[test]
    fn quote_match_takes_first_unused_and_reports_partial_coverage() {
        let text = "Same line. Other line.";
        let draft = draft_of(text, AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Same line.", "analysis": analysis("")}]
        }));
        let matched = match_payload(&draft, &payload).expect("部分覆盖不拒收");
        assert_eq!(matched.matched.len(), 1);
        assert_eq!(matched.coverage.analysis, "1/2");
        assert_eq!(matched.matched[0].sentence_idx, 0);
    }

    #[test]
    fn unmatched_quote_is_listed_not_dropped() {
        let draft = draft_of("Alpha beta. Gamma delta.", AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [
                {"quote": "Alpha beta.", "analysis": analysis("")},
                {"quote": "AI 改写的句子。", "analysis": analysis("")}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("≥1 句命中不是错误");
        assert_eq!(matched.matched.len(), 1);
        assert_eq!(matched.unmatched.len(), 1, "未匹配句必须进 unmatched，不得静默丢弃");
    }

    #[test]
    fn zero_match_is_ai_no_match() {
        let draft = draft_of("Alpha beta.", AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "完全不相关的句子。", "analysis": analysis("")}]
        }));
        let err = match_payload(&draft, &payload).unwrap_err();
        assert_eq!(err.code, "AI_NO_MATCH");
    }

    #[test]
    fn sno_conflict_is_corrected_by_quote() {
        let draft = draft_of("One two. Three four. Five six.", AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Five six.", "analysis": analysis(""), "sNo": "S1"}]
        }));
        let matched = match_payload(&draft, &payload).expect("编号冲突以 quote 为准");
        assert_eq!(matched.matched[0].sentence_idx, 2);
        assert_eq!(matched.sno_fixed, 1);
    }

    #[test]
    fn ai_offsets_are_ignored() {
        let draft = draft_of("Alpha beta. Gamma delta.", AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{
                "quote": "Gamma delta.",
                "start": 999, "end": 1000, "offset": 7,
                "tokens": [{"surface": "Gamma", "start": 500}],
                "analysis": analysis("")
            }],
            "paragraphs": []
        }));
        let matched = match_payload(&draft, &payload).expect("偏移字段一律忽略");
        assert_eq!(matched.matched[0].sentence_idx, 1, "偏移必须用 App 自算的句序，不读 AI 数字");
        assert_eq!(matched.matched[0].paragraph_idx, 0);
    }

    #[test]
    fn answer_out_of_options_becomes_missing() {
        let draft = draft_of("Alpha beta gamma.", AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [],
            "questions": [{
                "no": 46, "stem": "s",
                "options": [{"key":"A","text":"a"},{"key":"B","text":"b"},{"key":"C","text":"c"},{"key":"D","text":"d"}],
                "answer": "Z"
            }]
        }));
        let matched = match_payload(&draft, &payload).expect("答案不合法不报错");
        assert!(matched.questions[0].answer.is_none(), "答案必须归一为无答案，不得编造");
        assert!(matched.questions[0].missing_answer);
        assert_eq!(matched.missing_answer, 1);
    }

    #[test]
    fn lexicon_absent_from_body_goes_unmatched() {
        let draft = draft_of("Alpha beta gamma.", AiSection::Careful);
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [],
            "lexicon": [
                {"word": "alpha", "sense": "阿尔法"},
                {"word": "zebra", "sense": "斑马"}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("词条缺失不报错");
        assert_eq!(matched.lexicon.len(), 1);
        assert_eq!(matched.unmatched_lexicon.len(), 1);
        assert_eq!(matched.unmatched_lexicon[0].word, "zebra");
        assert_eq!(matched.coverage.lexicon, 1);
    }

    #[test]
    fn blank_distractors_string_is_ignored() {
        let draft = draft_of("Text 26. more 28, and 30 years.", AiSection::Cloze);
        let payload = payload_of(json!({
            "section": "cloze",
            "sentences": [],
            "questions": [
                {"no": 26, "stem": "第 26 空", "options": cloze_options(15), "answer": "A"},
                {"no": 28, "stem": "第 28 空", "options": cloze_options(15), "answer": "A"},
                {"no": 30, "stem": "第 30 空", "options": cloze_options(15), "answer": "A"}
            ],
            "blankAnalyses": [{"no": 26, "answerWord": "w0", "reason": "r", "distractors": "字符串形态"}]
        }));
        let matched = match_payload(&draft, &payload).expect("字符串 distractors 按非必填忽略");
        assert_eq!(matched.blanks.len(), 1);
        assert!(matched.blanks[0].distractors.is_none());
        assert_eq!(matched.coverage.blanks, "1/3");
    }

    /// 短语两形态：契约 `string[]` 与仓库内容包的对象形态都要能进库，且展示形状统一为对象
    #[test]
    fn phrases_string_is_projected_to_display_object() {
        let projected = phrases_json_text(Some(&[
            json!("the ability to do sth"),
            json!({"text": "under control", "meaning": "在控制中", "usage": null, "example": null}),
        ]));
        let parsed: Value = serde_json::from_str(&projected).expect("投影结果必须是合法 JSON");
        assert_eq!(parsed[0]["text"], json!("the ability to do sth"));
        assert_eq!(parsed[0]["meaning"], Value::Null);
        assert_eq!(parsed[1]["meaning"], json!("在控制中"));
        assert_eq!(phrases_json_text(None), "[]");
    }

    /// AC12 / AC9：入库只写 8 张表；patch 不动三结构表；词条二次提交不新增
    #[test]
    fn commit_then_patch_keeps_structure_and_dedupes_lexicon() {
        let text = "Reading builds a habit over time. Practice makes the habit stronger every day.";
        let draft = draft_of(text, AiSection::Careful);
        let first = draft.preview.paragraphs[0].sentences[0].text.clone();
        let second = draft.preview.paragraphs[0].sentences[1].text.clone();
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [
                {"quote": first, "analysis": analysis("")},
                {"quote": second, "analysis": analysis("")}
            ],
            "questions": [{
                "no": 46, "stem": "s",
                "options": [{"key":"A","text":"a"},{"key":"B","text":"b"},{"key":"C","text":"c"},{"key":"D","text":"d"}],
                "answer": "B"
            }],
            "lexicon": [{"word": "Reading", "sense": "阅读"}]
        }));
        let matched = match_payload(&draft, &payload).expect("匹配应成功");

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-ai-import-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("迁移应成功");

        let report = commit_ai_import(&db, &draft, &matched, &AiCommitMeta::default()).expect("入库应成功");
        assert_eq!(report.analysis_written, 2);
        assert_eq!(report.questions_written, 1);
        assert_eq!(report.lexicon_inserted, 1);

        let before = article_counts(&db, report.article_id).expect("读数应成功");
        assert_eq!(before.analyses, 2);
        assert_eq!(before.sentences, 2);

        // 二次提交同一批 → 解析行数不变、词条不新增（INSERT OR IGNORE）
        let again = patch_ai_analysis(&db, report.article_id, Some(&draft), &matched).expect("补解析应成功");
        assert_eq!(again.analysis_written, 2);
        assert_eq!(again.lexicon_inserted, 0, "同批词条二次提交不得新增行");
        let after = article_counts(&db, report.article_id).expect("读数应成功");
        assert_eq!(after.sentences, before.sentences);
        assert_eq!(after.tokens, before.tokens);
        assert_eq!(after.structure_hash, before.structure_hash, "patch 不得改动三结构表");
        assert_eq!(after.analyses, 2, "同句再给解析视为修订，不新增行");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// R1（既有 19 表约定 `import.rs:505` / `types.ts:96`）：`question.idx` 写试卷题号，
    /// 不写批内数组下标——否则「内容包导入篇」题号 46~50 与「AI 导入篇」题号 0~4 语义分叉，
    /// `blank.blank_no` 与 `question.idx` 也不再同源。
    #[test]
    fn question_rows_use_paper_no_not_batch_index() {
        let text = "Reading builds a habit over time. Practice makes the habit stronger every day.";
        let draft = draft_of(text, AiSection::Careful);
        let first = draft.preview.paragraphs[0].sentences[0].text.clone();
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": first, "analysis": analysis("")}],
            "questions": [
                {"no": 46, "stem": "第 46 题", "options": [
                    {"key":"A","text":"a"},{"key":"B","text":"b"},{"key":"C","text":"c"},{"key":"D","text":"d"}], "answer": "A"},
                {"no": 47, "stem": "第 47 题", "options": [
                    {"key":"A","text":"a"},{"key":"B","text":"b"},{"key":"C","text":"c"},{"key":"D","text":"d"}], "answer": "B"}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("匹配应成功");

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-ai-import-no-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("迁移应成功");

        let report = commit_ai_import(&db, &draft, &matched, &AiCommitMeta::default()).expect("入库应成功");
        let idx: Vec<i64> = db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT idx FROM question WHERE article_id = ?1 ORDER BY idx")
                    .map_err(|err| CommandError::db("准备题号查询", err))?;
                let rows = stmt
                    .query_map([report.article_id], |row| row.get::<_, i64>(0))
                    .map_err(|err| CommandError::db("查询题号", err))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(|err| CommandError::db("读取题号", err))?);
                }
                Ok(out)
            })
            .expect("题号回读应成功");

        assert_eq!(
            idx,
            vec![46, 47],
            "question.idx 必须是试卷题号（payload questions[].no），不是批内下标 0..N"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ──────────── M5c · D0 新增（切分 4 / 三档提示词 3 / 题目一致性 2 / 答案来源 1） ────────────

    fn draft_with(text: &str, section: AiSection, mode: ImportMode, questions: Option<&str>) -> AiDraft {
        AiDraft {
            preview: preview_of(text),
            section,
            mode,
            question_text: questions.map(str::to_string),
        }
    }

    fn strip_ws(text: &str) -> String {
        text.chars().filter(|c| !c.is_whitespace()).collect()
    }

    #[test]
    fn split_detects_question_area_and_keeps_body_clean() {
        let raw = "Reading builds a habit.\nPractice helps a lot.\n\n46. What is the main idea?\n47. Why does practice matter?\n48. What does the author suggest?\n";
        let split = split_user_input(raw);
        assert!(split.detected, "题目区应被识别：{}", split.reason);
        assert_eq!(split.question_start_line, Some(4), "1-based 行号（第 3 行是空行，题目区从第 4 行起）");
        assert!(split.body_text.contains("Reading builds a habit."));
        assert!(!split.body_text.contains("46."), "正文不得含题目行");
        assert!(split.question_text.starts_with("46."));
        assert_eq!(split.question_count, 3);
    }

    #[test]
    fn split_without_question_area_does_not_guess() {
        let raw = "Reading builds a habit. Practice helps a lot.";
        let split = split_user_input(raw);
        assert!(!split.detected, "没有题号区时不得瞎猜");
        assert_eq!(split.question_text, "", "切不中时题目区为空串");
        assert_eq!(split.question_start_line, None);
        assert_eq!(split.body_text, raw);
    }

    #[test]
    fn split_ignores_lone_numbered_line_in_body() {
        let raw = "2024. was a hard year.\nStudents complained a lot.\nTeachers agreed.\nNobody smiled.\nIt rained.\nWe left.";
        let split = split_user_input(raw);
        assert!(!split.detected, "单个疑似行不得确认：{}", split.reason);
    }

    #[test]
    fn split_uses_section_title_as_question_start() {
        let raw = "Reading builds a habit.\n\nDirections: read the passage.\n46. First?\n47. Second?\n";
        let split = split_user_input(raw);
        assert!(split.detected);
        assert_eq!(split.question_start_line, Some(3));
        assert_eq!(split.question_count, 2, "题型标题行本身不计题数");
    }

    /// D-M5c-1 红样：真实卷面「题干 1 行 + A/B/C/D 四个分行选项 + 答案行」，下一题号在第 7 行
    #[test]
    fn split_confirms_question_area_with_split_options() {
        let raw = "Reading builds a habit over time.\n\nDirections: Read the passage and answer the questions below.\n\n46. What does the author say about willpower?\nA. Keep it under control.\nB. Apply it continuously.\nC. Learn from entrepreneurs.\nD. Aim at success determinedly.\n答案 B\n\n47. How are daily actions performed?\nA. Out of habit.\nB. With determination.\nC. Like muscle building.\nD. By self-discipline.\n答案 A\n";
        let split = split_user_input(raw);
        assert!(split.detected, "题干 + 4 分行选项的卷面应被识别：{}", split.reason);
        assert_eq!(split.question_start_line, Some(3), "最靠前候选是题型标题行（第 3 行）");
        assert_eq!(split.question_count, 2);
        assert!(!split.body_text.contains("46."), "正文不得含题目行");
        assert!(split.question_text.starts_with("Directions:"));
    }

    /// D-M5c-1 同族：选词填空一道题有 15 个选项（A~O），选项字母不能只认 A~D
    #[test]
    fn split_confirms_cloze_question_area_with_fifteen_options() {
        let mut raw = String::from("A team of researchers examined communicative abstraction.\n\nDirections: Read the passage and answer the questions below.\n\n");
        for no in 26..=28 {
            raw.push_str(&format!("{no}. 第 {no} 空\n"));
            for letter in 'A'..='O' {
                raw.push_str(&format!("{letter}. option {letter}\n"));
            }
            raw.push_str("答案 O\n\n");
        }
        let split = split_user_input(&raw);
        assert!(split.detected, "15 个选项一题的选词填空卷面应被识别：{}", split.reason);
        assert_eq!(split.question_start_line, Some(3), "最靠前候选是题型标题行（第 3 行）");
        assert_eq!(split.question_count, 3);
    }

    /// D-M5c-1 同族：选项与题干之间、题与题之间的空行（含连续多个）不得吃掉确认额度
    #[test]
    fn split_window_ignores_blank_lines_within_question_block() {
        let raw = "Reading builds a habit.\n\n\n46. What is the main idea?\n\n\nA. Habit\n\nB. Practice\nC. Reading\nD. Time\n\n答案 A\n\n48. Why does practice matter?\nA. Habit\nB. Practice\nC. Reading\nD. Time\n答案 B\n\n49. What does the author suggest?\nA. Habit\nB. Practice\nC. Reading\nD. Time\n答案 C\n";
        let split = split_user_input(raw);
        assert!(split.detected, "空行不得吃掉确认额度：{}", split.reason);
        assert_eq!(split.question_start_line, Some(4));
        assert_eq!(split.question_count, 3);
    }

    /// D-M5c-1 反例：正文里孤立的「2024.」即使前后都是空行，也不得确认（不猜是硬边界）
    #[test]
    fn split_still_rejects_lone_numbered_line_between_blank_lines() {
        let raw = "2024. was a hard year.\n\nStudents complained a lot.\n\nTeachers agreed.\n\nNobody smiled.\n\nIt rained.\n\nWe left.\n";
        let split = split_user_input(raw);
        assert!(!split.detected, "孤立题号行 + 空行不得确认：{}", split.reason);
        assert_eq!(split.question_text, "", "切不中时题目区为空串");
        assert_eq!(split.question_start_line, None);
    }

    #[test]
    fn prompt_full_embeds_whole_body_and_questions() {
        let text = "Reading builds a habit over time.\n\nPractice makes the habit stronger every single day.";
        let questions = "46. What is the main idea?\nA. Habit\nB. Practice\nC. Reading\nD. Time";
        let draft = draft_with(text, AiSection::Careful, ImportMode::Full, Some(questions));
        let prompt = build_prompt(&draft, 15);
        let body: String = draft
            .preview
            .paragraphs
            .iter()
            .map(|paragraph| paragraph.text.as_str())
            .collect::<Vec<_>>()
            .join("");
        assert!(
            strip_ws(&prompt.text).contains(&strip_ws(&body)),
            "档 C 提示词必须内嵌正文全文（判据：去空白后 contains）"
        );
        assert!(prompt.text.contains("46. What is the main idea?"), "档 C 必须带题目区原文");
        assert!(prompt.text.contains("answerSource"), "档 C 必须声明 answerSource 口径");
        assert!(
            !prompt.text.contains("正文请把你手上这篇原文整段粘给我"),
            "L464 的旧文案（让用户自己粘正文）必须消除"
        );
    }

    #[test]
    fn prompt_analysis_has_body_but_no_questions() {
        let text = "Reading builds a habit over time.";
        let draft = draft_with(text, AiSection::Careful, ImportMode::Analysis, Some("46. 不应出现"));
        let prompt = build_prompt(&draft, 15);
        assert!(strip_ws(&prompt.text).contains("Readingbuildsahabit"));
        assert!(!prompt.text.contains("46. 不应出现"), "档 B 不得带题目区");
    }

    #[test]
    fn prompt_plain_requires_no_analysis() {
        let draft = draft_with("Reading builds a habit.", AiSection::Careful, ImportMode::Plain, None);
        let prompt = build_prompt(&draft, 15);
        assert!(!prompt.text.contains("\"sentences\""), "档 A 不得要求 sentences[]");
        assert!(!prompt.text.contains("structMarkup"), "档 A 不得要求解析字段");
        assert!(prompt.text.contains("不需要"), "档 A 必须声明不需要 AI 产出");
    }

    /// AC2：档 A（`mode=plain`）**不要求任何解析** → `matched` 为空也必须能入库
    #[test]
    fn plain_mode_commits_with_empty_matched() {
        let text = "Reading builds a habit over time. Practice makes the habit stronger every single day.";
        let draft = draft_with(text, AiSection::Careful, ImportMode::Plain, None);
        let matched = empty_matched_for_test(AiSection::Careful);

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-plain-mode-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("迁移应成功");

        let report = commit_ai_import(&db, &draft, &matched, &AiCommitMeta::default())
            .expect("档 A 的空 matched 必须能入库（否则「只要原文」这条路径不通）");
        assert_eq!(report.analysis_written, 0);
        assert_eq!(report.questions_written, 0);
        let counts = article_counts(&db, report.article_id).expect("读数应成功");
        assert_eq!(counts.sentences, 2, "原文结构照常入库（2 句）");

        // 反证：档 B/C 不允许空 matched（同一份空包必须被拒）
        let strict = draft_with(text, AiSection::Careful, ImportMode::Analysis, None);
        let err = commit_ai_import(&db, &strict, &matched, &AiCommitMeta::default()).unwrap_err();
        assert_eq!(err.code, "AI_NO_MATCH", "档 B 空 matched 必须拒收");

        std::fs::remove_dir_all(&dir).ok();
    }

    fn empty_matched_for_test(section: AiSection) -> AiMatched {
        AiMatched {
            section,
            matched: Vec::new(),
            unmatched: Vec::new(),
            unmatched_lexicon: Vec::new(),
            questions: Vec::new(),
            blanks: Vec::new(),
            lexicon: Vec::new(),
            coverage: AiCoverage {
                analysis: "-".to_string(),
                questions: "-".to_string(),
                blanks: "-".to_string(),
                lexicon: 0,
            },
            sno_fixed: 0,
            missing_answer: 0,
        }
    }

    fn full_draft() -> AiDraft {
        let text = "Reading builds a habit over time. Practice makes it stronger every day.";
        let questions = "46. What is the main idea?\nA. Habit\nB. Practice\nC. Reading\nD. Time\n\
47. Why practice?\nA. grows\nB. stops\nC. hides\nD. waits\n答案 B\n\
48. What follows?\nA. rest\nB. work\nC. play\nD. sleep";
        draft_with(text, AiSection::Careful, ImportMode::Full, Some(questions))
    }

    fn four_options(texts: [&str; 4]) -> Vec<Value> {
        texts
            .iter()
            .enumerate()
            .map(|(index, text)| json!({"key": ((b'A' + index as u8) as char).to_string(), "text": text}))
            .collect()
    }

    #[test]
    fn question_stem_mismatch_is_rejected() {
        let draft = full_draft();
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Reading builds a habit over time.", "analysis": analysis("")}],
            "questions": [{
                "no": 46, "stem": "AI 自己编的题干", "options": four_options(["Habit", "Practice", "Reading", "Time"])
            }]
        }));
        let err = match_payload(&draft, &payload).unwrap_err();
        assert_eq!(err.code, "AI_QUESTION_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("questions[0].stem"));
    }

    #[test]
    fn question_options_and_answer_mismatch_are_rejected() {
        let draft = full_draft();
        let bad_options = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Reading builds a habit over time.", "analysis": analysis("")}],
            "questions": [{
                "no": 46, "stem": "What is the main idea?", "options": four_options(["习惯", "练习", "阅读", "时间"])
            }]
        }));
        let err = match_payload(&draft, &bad_options).unwrap_err();
        assert_eq!(err.code, "AI_QUESTION_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("questions[0].options"));

        let bad_answer = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Reading builds a habit over time.", "analysis": analysis("")}],
            "questions": [{
                "no": 47, "stem": "Why practice?", "options": four_options(["grows", "stops", "hides", "waits"]),
                "answer": "A"
            }]
        }));
        let err = match_payload(&draft, &bad_answer).unwrap_err();
        assert_eq!(err.code, "AI_QUESTION_MISMATCH");
        assert_eq!(err.path.as_deref(), Some("questions[0].answer"));
    }

    /// AC8：三值 `user` / `ai` / `none` 由「用户题目区有没有答案 + payload 是否一致」判定
    #[test]
    fn answer_source_three_values_from_user_question_area() {
        let draft = full_draft();
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Reading builds a habit over time.", "analysis": analysis("")}],
            "questions": [
                {"no": 46, "stem": "What is the main idea?", "options": four_options(["Habit", "Practice", "Reading", "Time"]), "answer": "B"},
                {"no": 47, "stem": "Why practice?", "options": four_options(["grows", "stops", "hides", "waits"]), "answer": "B"},
                {"no": 48, "stem": "What follows?", "options": four_options(["rest", "work", "play", "sleep"]), "answer": null}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("档 C 一致时不得拒收");
        let sources: Vec<&str> = matched.questions.iter().map(|q| q.answer_source.as_str()).collect();
        assert_eq!(sources, vec!["ai", "user", "none"], "46 AI 补 / 47 用户给 / 48 都没有");
    }

    /// AC8：`commit_ai_import` 与 `patch_ai_analysis` 两条路径都写 `question.answer_source`
    #[test]
    fn answer_source_written_on_both_commit_and_patch() {
        let draft = full_draft();
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Reading builds a habit over time.", "analysis": analysis("")}],
            "questions": [
                {"no": 46, "stem": "What is the main idea?", "options": four_options(["Habit", "Practice", "Reading", "Time"]), "answer": "B"},
                {"no": 47, "stem": "Why practice?", "options": four_options(["grows", "stops", "hides", "waits"]), "answer": "B"}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("匹配应成功");

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-answer-source-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("迁移应成功");

        let report = commit_ai_import(&db, &draft, &matched, &AiCommitMeta::default()).expect("入库应成功");
        let read_sources = |article_id: i64| -> Vec<String> {
            db.read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT answer_source FROM question WHERE article_id = ?1 ORDER BY idx")
                    .map_err(|err| CommandError::db("准备答案来源查询", err))?;
                let rows = stmt
                    .query_map([article_id], |row| row.get::<_, String>(0))
                    .map_err(|err| CommandError::db("查询答案来源", err))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(|err| CommandError::db("读取答案来源", err))?);
                }
                Ok(out)
            })
            .expect("答案来源回读应成功")
        };
        assert_eq!(read_sources(report.article_id), vec!["ai", "user"], "commit 路径必须写三值");

        patch_ai_analysis(&db, report.article_id, Some(&draft), &matched).expect("补解析应成功");
        assert_eq!(
            read_sources(report.article_id),
            vec!["ai", "user"],
            "patch 路径同样必须写 answer_source"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// M5c 回退兼容：`draft = None`（M5b 版导入页只传 matched）时
    /// **跳过** `answer_source` 写入（保持列默认 `'none'`）与档 C 逐字比对，
    /// 且不做题型复核 / 不回写 `article.section_type`，其余行为不变。
    #[test]
    fn patch_without_draft_skips_answer_source_and_section_check() {
        let draft = full_draft();
        let payload = payload_of(json!({
            "section": "careful",
            "sentences": [{"quote": "Reading builds a habit over time.", "analysis": analysis("")}],
            "questions": [
                {"no": 46, "stem": "What is the main idea?", "options": four_options(["Habit", "Practice", "Reading", "Time"]), "answer": "B"},
                {"no": 47, "stem": "Why practice?", "options": four_options(["grows", "stops", "hides", "waits"]), "answer": "B"}
            ]
        }));
        let matched = match_payload(&draft, &payload).expect("匹配应成功");

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-patch-no-draft-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("迁移应成功");

        let report = commit_ai_import(&db, &draft, &matched, &AiCommitMeta::default()).expect("入库应成功");
        // 把库恢复成「列默认」状态：answer_source 回 'none'，题型改成与本次 matched 不一致
        db.write(|tx| {
            tx.execute("UPDATE question SET answer_source = 'none' WHERE article_id = ?1", [report.article_id])
                .map_err(|err| CommandError::db("重置答案来源", err))?;
            tx.execute("UPDATE article SET section_type = 'long' WHERE id = ?1", [report.article_id])
                .map(|_| ())
                .map_err(|err| CommandError::db("改题型", err))
        })
        .expect("重置库状态应成功");

        // 无 draft：不得因 matched.section != article.section_type 而拒收
        patch_ai_analysis(&db, report.article_id, None, &matched).expect("无 draft 的补解析不得拒收");

        let sources: Vec<String> = db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT answer_source FROM question WHERE article_id = ?1 ORDER BY idx")
                    .map_err(|err| CommandError::db("准备答案来源查询", err))?;
                let rows = stmt
                    .query_map([report.article_id], |row| row.get::<_, String>(0))
                    .map_err(|err| CommandError::db("查询答案来源", err))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(|err| CommandError::db("读取答案来源", err))?);
                }
                Ok(out)
            })
            .expect("答案来源回读应成功");
        assert_eq!(sources, vec!["none", "none"], "无 draft 时不得写 answer_source（保持列默认 'none'）");

        let section_type: String = db
            .read(|conn| {
                conn.query_row("SELECT section_type FROM article WHERE id = ?1", [report.article_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|err| CommandError::db("读题型", err))
            })
            .expect("题型回读应成功");
        assert_eq!(section_type, "long", "无 draft 时不回写 article.section_type");

        std::fs::remove_dir_all(&dir).ok();
    }
}

/// D-M5c-2（02 §八 AC4）：整卷多篇切分的纯函数读数。
///
/// 单独成 mod 而不是挤进上面的 `mod tests`：本组用例只碰 `split_passages`，
/// 与「AI 导入 + 真库」那批用例没有共享夹具（`cargo test --lib --bins` 一样收）。
#[cfg(test)]
mod passage_tests {
    use super::*;

    /// 4 篇整卷（真实形态：Section A 选词填空 / Section B 长篇 / Passage Two 仔细 / Section C 仔细）
    /// 注意 `Section B` 紧接 `Passage One`（中间无正文）→ 必须合并成一处边界，不切空壳篇。
    const VOLUME: &str = "Section A\nDirections: fill in the blanks.\n\nThe market of the town changed.\n\nSection B\nPassage One\nQuestions 46 to 50 are based on the following passage.\n\nSome long text one.\n\nPassage Two\nSome careful text two.\n\nSection C\nPassage Three\nSome careful text three.\n";

    #[test]
    fn volume_of_four_splits_into_four_contiguous_spans() {
        let spans = split_passages(VOLUME);
        assert_eq!(spans.len(), 4, "整卷 4 篇应切成 4 段：{spans:?}");
        // 首篇从文件头起（1-based 行 1）
        assert_eq!(spans[0].start_line, 1);
        assert_eq!(spans[0].label, "Section A");
        assert_eq!(spans[0].preview, "Section A");
        // 相邻小标题合并：第 2 篇的标签取 `Section B`，不是 `Passage One`
        assert_eq!(spans[1].label, "Section B");
        assert_eq!(spans[2].label, "Passage Two");
        assert_eq!(spans[3].label, "Section C");
        // 篇序 1..N 且首尾相接（无空洞、无重叠）
        let total = VOLUME.lines().count();
        let mut expected = 1usize;
        for (i, span) in spans.iter().enumerate() {
            assert_eq!(span.index, i + 1);
            assert_eq!(span.start_line, expected, "第 {} 篇起点应接上上一篇末尾", i + 1);
            assert!(span.end_line >= span.start_line);
            expected = span.end_line + 1;
        }
        assert_eq!(spans[3].end_line, total, "最后一篇应覆盖到文件尾");
    }

    #[test]
    fn single_passage_returns_one_span_covering_whole_text() {
        let raw = "Just one passage.\n\nNo headings at all.";
        let spans = split_passages(raw);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_line, 1);
        assert_eq!(spans[0].end_line, 3);
        assert_eq!(spans[0].preview, "Just one passage.");
        assert!(spans[0].label.contains("全文"), "单篇的标签应表明「全文」：{}", spans[0].label);
    }

    #[test]
    fn empty_input_returns_no_span() {
        assert!(split_passages("").is_empty());
        assert!(split_passages("   \n\n\t\n").is_empty(), "纯空白也按空输入处理");
    }

    /// 误切防护（AC4 点名的反例）：正文里的短语不得当边界。
    #[test]
    fn body_phrases_are_not_treated_as_boundaries() {
        let raw = "Part of the reason is clear.\n\nSection of the market grew fast.\n\nPassages of text are long.\n\nQuestions remain.\n";
        let spans = split_passages(raw);
        assert_eq!(spans.len(), 1, "正文短语被误切成了篇边界：{spans:?}");
        // `Questions 46 to 50`（用 to 而不是连字符）同样不是区间行 → 不切
        let raw2 = "Questions 46 to 50 are based on the following passage.\n\nBody.\n";
        assert_eq!(split_passages(raw2).len(), 1);
    }

    #[test]
    fn full_width_roman_part_and_questions_range_are_boundaries() {
        let raw = "Part Ⅰ\nFirst part body.\n\nQuestions 1-5\nSecond part body.\n";
        let spans = split_passages(raw);
        assert_eq!(spans.len(), 2, "全角罗马数字 Part 与 Questions N-M 都应算边界：{spans:?}");
        assert_eq!(spans[0].label, "Part Ⅰ");
        assert_eq!(spans[1].label, "Questions 1-5");
        assert_eq!(spans[1].preview, "Questions 1-5");
    }
}