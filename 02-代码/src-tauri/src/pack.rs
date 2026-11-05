//! 内容包（`content-pack/`）：目录定位、manifest 解析与校验、篇目 JSON 读取。
//!
//! 本文件承担三条纪律（02 D2 / 承接债务 T1·T2 / 05 §二 规则 6）：
//! 1. **错误类型叫 `StartupError`**（不另起 `PackError`），变体 `PackMissing` / `PackCorrupt{file}`，
//!    且 `impl std::error::Error`——`lib.rs` 的 setup 闭包要能 `?` 转换。
//! 2. **路径限域（T1）**：`articles[].file` 只接受包目录内的普通文件名；绝对路径、`..`、
//!    符号链逃逸一律 `PackCorrupt`，**不打开该文件**。
//! 3. **错误只带 basename（T2）**：错误页会展示给用户，绝不放绝对路径（会泄漏本地用户名）。
//!
//! 启动态语义（O2）：`StartupState::Running` = 成功启动 → `get_startup_error` 返回 `None`；
//! `StartupState::Failed` = 初始化失败 → 返回其中的 `StartupErrorInfo`。

use std::collections::HashMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 内容包目录名（`bundle.resources` 的映射目标与开发期回落路径同名）
pub const PACK_DIR_NAME: &str = "content-pack";
/// manifest 文件名（唯一版本权威所在）
pub const MANIFEST_FILE: &str = "manifest.json";

/// 启动期内容包错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupError {
    /// 找不到内容包（目录或 manifest 缺失）
    PackMissing,
    /// 包内某个文件损坏/越界；`file` 只存 basename
    PackCorrupt { file: String },
}

impl fmt::Display for StartupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartupError::PackMissing => write!(f, "内置内容包缺失"),
            StartupError::PackCorrupt { file } => write!(f, "内置内容包文件损坏：{file}"),
        }
    }
}

impl std::error::Error for StartupError {}

/// 错误页的数据形态（§三.0 口径表）：IPC 字段 `kind` / `message` / `file`（camelCase 后同名）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupErrorInfo {
    pub kind: String,
    pub message: String,
    /// 只带 basename；非文件类错误为 null（前端按 `file` 是否为空决定要不要显示文件名）
    pub file: Option<String>,
}

impl StartupErrorInfo {
    pub fn new(kind: impl Into<String>, message: impl Into<String>, file: Option<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            file,
        }
    }
}

impl StartupError {
    /// 转成错误页可展示的形态
    pub fn info(&self) -> StartupErrorInfo {
        match self {
            StartupError::PackMissing => StartupErrorInfo::new(
                "pack_missing",
                "内置内容包缺失，无法加载文章。请重新安装应用。",
                None,
            ),
            StartupError::PackCorrupt { file } => StartupErrorInfo::new(
                "pack_corrupt",
                "内置内容包文件损坏，无法加载文章。请重新安装应用。",
                Some(file.clone()),
            ),
        }
    }
}

impl From<StartupError> for StartupErrorInfo {
    fn from(err: StartupError) -> Self {
        err.info()
    }
}

/// 启动态（O2）：`manage` 一份到 app state，供 `get_startup_error` 读取。
///
/// 为什么不用 `Option<StartupErrorInfo>` 直接 manage：`Option` 的「未注册」与「成功」会混为一谈，
/// 命令层还得区分；用枚举后成功态语义显式（`Running` → 命令返回 `None`）。
#[derive(Debug, Clone)]
pub enum StartupState {
    /// 启动成功（库与内容包都就绪，导入已跑完）——`get_startup_error` 返回 `None`
    Running,
    /// 初始化失败——错误页显示这里的信息
    Failed(StartupErrorInfo),
}

impl StartupState {
    /// 成功启动返回 `None`（这是错误页判据的「无错误」语义）
    pub fn error(&self) -> Option<StartupErrorInfo> {
        match self {
            StartupState::Running => None,
            StartupState::Failed(info) => Some(info.clone()),
        }
    }
}

/// manifest 里的标量：内置包跨篇存在「数字」与「字符串」两种写法
/// （`examYear: 2023` vs `"2023"`、`examSet: 1` vs `"1"`），统一按标量接收再转。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Scalar {
    Int(i64),
    Str(String),
}

impl Scalar {
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Scalar::Int(v) => Some(*v),
            Scalar::Str(s) => s.trim().parse().ok(),
        }
    }

    /// 统一按 TEXT 落库（R12：内容包 `examSet` 是数字，也要写成文本）
    pub fn as_text(&self) -> String {
        match self {
            Scalar::Int(v) => v.to_string(),
            Scalar::Str(s) => s.clone(),
        }
    }
}

/// 包内 9 张内容表的期望总行数（完整性核对的第二道判据）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub articles: i64,
    pub paragraphs: i64,
    pub sentences: i64,
    pub tokens: i64,
    pub sentence_analysis: i64,
    pub token_analysis: i64,
    pub blanks: i64,
    pub questions: i64,
    pub lexicon: i64,
}

/// `manifest.json`（调度员生成，字段名不改）
///
/// 只声明**本包真正用到**的字段：`contentVersion` / `generatedAt` / `schemaVersion` / `note`
/// 是给人和工具看的元信息，进口径里没有任何消费者（读进来即死代码），serde 默认忽略未知字段。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// **唯一版本权威**（篇内残留的 `packVersion` 不入库、不参与比较）
    pub pack_version: String,
    pub articles: Vec<ManifestArticle>,
    pub totals: Totals,
}

/// manifest 里的单篇声明
///
/// `articleId` / `visibility` 也不声明：前者是包内编号（DB 用 `source_key` 定位），
/// 后者本包按 D3 固定写 `'system'`（用户导入篇走 M5 的另一条路径）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestArticle {
    pub source_key: String,
    /// 包内文件名（**必须限域**）
    pub file: String,
    pub title: String,
    pub exam_type: String,
    #[serde(default)]
    pub exam_year: Option<Scalar>,
    #[serde(default)]
    pub exam_set: Option<Scalar>,
    pub section_type: String,
    #[serde(default)]
    pub section_label: Option<String>,
    #[serde(default)]
    pub passage_label: Option<String>,
    #[serde(default)]
    pub word_count: Option<Scalar>,
    #[serde(default)]
    pub paragraph_count: Option<Scalar>,
    #[serde(default)]
    pub sentence_count: Option<Scalar>,
    #[serde(default)]
    pub token_count: Option<Scalar>,
    #[serde(default)]
    pub question_count: Option<Scalar>,
    #[serde(default)]
    pub blank_count: Option<Scalar>,
}

impl ManifestArticle {
    pub fn exam_year_i64(&self) -> Option<i64> {
        self.exam_year.as_ref().and_then(Scalar::as_i64)
    }
    pub fn count_of(value: &Option<Scalar>) -> i64 {
        value.as_ref().and_then(Scalar::as_i64).unwrap_or(0)
    }
}

// ─────────────────────────── 篇目 JSON ───────────────────────────

/// 单篇内容包（`cet4-2023-12-*.json`）
///
/// 篇内残留的 `packVersion`（实测 12 篇全为 `2023-12-set1-v0.9`）**故意不声明**：
/// serde 默认忽略未知字段，即「不入库、不参与比较」。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticlePack {
    pub source_key: String,
    #[serde(default)]
    pub meta: ArticleMeta,
    pub paragraphs: Vec<ParagraphPack>,
    #[serde(default)]
    pub questions: Vec<QuestionPack>,
    #[serde(default)]
    pub blank_nos: Vec<i64>,
    #[serde(default)]
    pub blanks: HashMap<String, BlankPack>,
    #[serde(default)]
    pub lexicon: HashMap<String, LexiconPack>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleMeta {
    /// `article.source` 取值规则要用（B4）：缺省时退化为「…年真题」并记 warning
    #[serde(default)]
    pub exam_month: Option<Scalar>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphPack {
    pub idx: i64,
    pub text: String,
    #[serde(default)]
    pub sentences: Vec<SentencePack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentencePack {
    pub idx: i64,
    /// 相对**段落**文本（内容包已按此口径，ADR-008 UTF-16 code unit）
    pub start: i64,
    pub end: i64,
    pub text: String,
    #[serde(default)]
    pub tokens: Vec<TokenPack>,
    #[serde(default)]
    pub analysis: Option<SentenceAnalysisPack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPack {
    /// 相对**句子**文本
    pub start: i64,
    pub end: i64,
    pub surface: String,
    /// 非词 token（标点/数字）为 null
    #[serde(default)]
    pub normalized: Option<String>,
    /// **空格判定的唯一权威**（不得用 normalized 推导）
    pub is_word: bool,
    #[serde(default)]
    pub analysis: Option<TokenAnalysisPack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPack {
    /// 题号 = `blank_no` 同源（cloze 26~35 / long 36~45 / careful 46~55）
    pub no: i64,
    pub stem: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub answer: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub key: String,
    pub text: String,
}

/// 排除项：有的篇是字符串、有的篇是数组 → 统一存成**字符串**（数组则序列化为 JSON 文本）
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Distractors {
    Text(String),
    List(Vec<String>),
}

impl Distractors {
    pub fn to_stored(&self) -> String {
        match self {
            Distractors::Text(text) => text.clone(),
            Distractors::List(list) => serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlankPack {
    #[serde(default)]
    pub answer_key: Option<String>,
    #[serde(default)]
    pub answer_word: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub distractors: Option<Distractors>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceAnalysisPack {
    #[serde(default)]
    pub translation_literal: Option<String>,
    #[serde(default)]
    pub translation_natural: Option<String>,
    #[serde(default)]
    pub struct_markup: Option<String>,
    #[serde(default)]
    pub structure_summary: Option<String>,
    #[serde(default)]
    pub paragraph_role: Option<String>,
    #[serde(default)]
    pub components: Vec<serde_json::Value>,
    #[serde(default)]
    pub clauses: Vec<serde_json::Value>,
    #[serde(default)]
    pub phrases: Vec<serde_json::Value>,
    #[serde(default)]
    pub pitfalls: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAnalysisPack {
    #[serde(default)]
    pub phonetic: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
    #[serde(default)]
    pub sense_in_context: Option<String>,
    #[serde(default)]
    pub collocations: Vec<String>,
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(default)]
    pub is_cet4_high_freq: bool,
    #[serde(default)]
    pub more: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LexiconPack {
    #[serde(default)]
    pub phonetic: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
    #[serde(default)]
    pub sense: Option<String>,
    #[serde(default)]
    pub lemma: Option<String>,
    #[serde(default)]
    pub collocations: Vec<String>,
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(default)]
    pub is_cet4_high_freq: bool,
    #[serde(default)]
    pub more: Option<serde_json::Value>,
}

// ─────────────────────── 定位 / 读取 / 限域 ───────────────────────

/// 包目录定位：优先 `resource_dir()/content-pack`（安装后），回落
/// `CARGO_MANIFEST_DIR/../content-pack`（`tauri dev` 下资源未拷进 target，02 D2 双路径回落）。
pub fn resolve_pack_dir(resource_dir: Option<&Path>) -> Result<PathBuf, StartupError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(PACK_DIR_NAME));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(PACK_DIR_NAME));

    let found = first_with_manifest(candidates)?;
    // 打印解析路径（AC1 的「日志打印解析路径」，复用现有 println 通道，不新造日志层）
    println!("[judou] content-pack dir = {}", found.display());
    Ok(found)
}

/// 取第一个「含 manifest.json」的候选目录；都不含 → `PackMissing`。
/// 抽出来是为了让「包缺失」这条分支可被单测（真实开发目录存在时 resolve_pack_dir 必然成功）。
fn first_with_manifest(candidates: impl IntoIterator<Item = PathBuf>) -> Result<PathBuf, StartupError> {
    for candidate in candidates {
        if candidate.join(MANIFEST_FILE).is_file() {
            return Ok(candidate);
        }
        eprintln!("[judou][pack] 候选目录不含 manifest：{}", candidate.display());
    }
    Err(StartupError::PackMissing)
}

/// 读 manifest：缺失 → `PackMissing`；解析失败 → `PackCorrupt{manifest.json}`
pub fn load_manifest(pack_dir: &Path) -> Result<Manifest, StartupError> {
    let path = pack_dir.join(MANIFEST_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Err(StartupError::PackMissing),
    };
    serde_json::from_str(&raw).map_err(|err| {
        eprintln!("[judou][pack] manifest 解析失败：{err}");
        StartupError::PackCorrupt {
            file: MANIFEST_FILE.to_string(),
        }
    })
}

/// 读单篇 JSON：**先限域再打开**（越界即拒，不碰文件）
pub fn load_article(pack_dir: &Path, file: &str) -> Result<ArticlePack, StartupError> {
    let path = safe_join(pack_dir, file)?;
    let raw = std::fs::read_to_string(&path).map_err(|err| {
        eprintln!("[judou][pack] 读取失败 {}：{err}", path.display());
        StartupError::PackCorrupt { file: basename(file) }
    })?;
    serde_json::from_str(&raw).map_err(|err| {
        eprintln!("[judou][pack] 解析失败 {}：{err}", path.display());
        StartupError::PackCorrupt { file: basename(file) }
    })
}

/// 只取 basename（T2）：`a/b/c.json` → `c.json`；没有文件名时用原文
pub fn basename(file: &str) -> String {
    Path::new(file)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| file.to_string())
}

/// 把 `manifest.articles[].file` 落成包目录内的绝对路径，越界一律 `PackCorrupt`。
///
/// 三层防护：① 组件必须是 `Normal`（拒绝对路径、`..`、根前缀）；② `canonicalize` 后再比父目录
/// （拒符号链逃逸）；③ 失败时只回 basename。
///
/// ponytail: 限域用 `std::path::Component` + `canonicalize`（标准库够用），未引 `path-clean`；
/// 天花板 = 只接受「包目录下的一层普通文件名」，内容包若真要嵌套子目录，再改成逐段校验的实现。
fn safe_join(pack_dir: &Path, file: &str) -> Result<PathBuf, StartupError> {
    let name = basename(file);
    let rel = Path::new(file);
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(StartupError::PackCorrupt { file: name });
    }

    let joined = pack_dir.join(rel);
    let canonical = joined
        .canonicalize()
        .map_err(|_| StartupError::PackCorrupt { file: name.clone() })?;
    let pack_root = pack_dir
        .canonicalize()
        .map_err(|_| StartupError::PackMissing)?;
    if canonical.parent() != Some(pack_root.as_path()) {
        return Err(StartupError::PackCorrupt { file: name });
    }
    Ok(canonical)
}

// ─────────────────────── 展示标签（D4 的两个字段） ───────────────────────

/// 一篇的展示标签（manifest 是权威）
#[derive(Debug, Clone, Default)]
pub struct ArticleLabels {
    /// 中文题型名（卡片第三项字段 / 页头元信息）
    pub section_label: Option<String>,
    /// 篇序标签（"Passage One" / "Banked Cloze" / "信息匹配"）
    pub passage_label: Option<String>,
}

/// `source_key → 展示标签` 查表。
///
/// 为什么不在 `article` 表加列：002 只允许加三列（AC2 逐列断言）、且标签是**随包发布的展示名**
/// （可再生），存进库等于把同一份内容存两遍。所以这里按 manifest 建 12 条内存映射，
/// 命令层 `list_articles` / `get_article_content` 从它取 `sectionLabel` / `passageLabel`（D4 字段清单）。
#[derive(Debug, Clone, Default)]
pub struct PackLabels {
    map: HashMap<String, ArticleLabels>,
}

impl PackLabels {
    pub fn from_manifest(manifest: &Manifest) -> Self {
        let map = manifest
            .articles
            .iter()
            .map(|article| {
                (
                    article.source_key.clone(),
                    ArticleLabels {
                        section_label: article.section_label.clone(),
                        passage_label: article.passage_label.clone(),
                    },
                )
            })
            .collect();
        Self { map }
    }

    /// 未收录（M5 用户导入篇）时返回 `None`，调用方走 `section_label_of` 回落
    pub fn labels(&self, source_key: &str) -> Option<&ArticleLabels> {
        self.map.get(source_key)
    }

    /// 题型中文名：manifest 有则用 manifest，否则按 `section_type` 映射
    pub fn section_label(&self, source_key: &str, section_type: Option<&str>) -> Option<String> {
        self.labels(source_key)
            .and_then(|labels| labels.section_label.clone())
            .or_else(|| section_type.and_then(section_label_of).map(str::to_string))
    }

    pub fn passage_label(&self, source_key: &str) -> Option<String> {
        self.labels(source_key)
            .and_then(|labels| labels.passage_label.clone())
    }
}

/// `section_type` → 中文题型名（M5 用户导入篇没有 manifest 标签时的回落；内置 12 篇走 manifest）
pub fn section_label_of(section_type: &str) -> Option<&'static str> {
    match section_type {
        "careful" => Some("仔细阅读"),
        "long" => Some("长篇阅读"),
        "cloze" => Some("选词填空"),
        _ => None,
    }
}

/// 运行期解析出的内容包目录（`lib.rs` setup 里 manage；`import_content_pack` 手动触发时要用）
#[derive(Debug, Clone)]
pub struct PackPath(pub PathBuf);

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(PACK_DIR_NAME)
    }

    /// 13 个数据文件必须都能被解析（AC1 的解析面；SHA-256 由 verify-pack.mjs 守）
    #[test]
    fn manifest_and_all_articles_parse() {
        let dir = pack_dir();
        let manifest = load_manifest(&dir).expect("manifest 应能解析");
        assert_eq!(manifest.pack_version, "2026.11.05-1");
        assert_eq!(manifest.articles.len(), 12, "manifest 应声明 12 篇");

        let mut paragraphs = 0;
        let mut sentences = 0;
        let mut tokens = 0;
        let mut blanks = 0;
        let mut questions = 0;
        let mut token_analysis = 0;
        let mut lexicon = HashMap::new();
        for article in &manifest.articles {
            let pack = load_article(&dir, &article.file).expect("篇目应能解析");
            assert_eq!(pack.source_key, article.source_key);
            questions += pack.questions.len() as i64;
            blanks += pack.blanks.len() as i64;
            for (key, _) in pack.lexicon.iter() {
                lexicon.insert(key.clone(), ());
            }
            for paragraph in &pack.paragraphs {
                paragraphs += 1;
                for sentence in &paragraph.sentences {
                    sentences += 1;
                    tokens += sentence.tokens.len() as i64;
                    token_analysis += sentence.tokens.iter().filter(|t| t.analysis.is_some()).count() as i64;
                }
            }
        }
        assert_eq!(paragraphs, manifest.totals.paragraphs);
        assert_eq!(sentences, manifest.totals.sentences);
        assert_eq!(tokens, manifest.totals.tokens);
        assert_eq!(questions, manifest.totals.questions);
        assert_eq!(blanks, manifest.totals.blanks);
        assert_eq!(token_analysis, manifest.totals.token_analysis);
        assert_eq!(lexicon.len() as i64, manifest.totals.lexicon);
    }

    /// T1：路径越界一律 `PackCorrupt`，且不得打开文件（`../`、绝对路径、子目录）
    #[test]
    fn article_path_escape_is_rejected_with_basename() {
        let dir = pack_dir();
        for evil in ["../manifest.json", "/etc/passwd", "sub/dir.json", "..", "."] {
            let err = load_article(&dir, evil).expect_err("越界路径必须被拒");
            match err {
                StartupError::PackCorrupt { file } => {
                    assert!(!file.contains('/'), "错误里的 file 只能是 basename，实测 {file}");
                    assert!(!file.contains('\\'), "错误里的 file 只能是 basename，实测 {file}");
                }
                other => panic!("应为 PackCorrupt，实测 {other:?}"),
            }
        }
    }

    /// T2 + 出错场景：错误信息里不得出现包目录绝对路径
    #[test]
    fn missing_article_error_carries_basename_only() {
        let dir = pack_dir();
        let err = load_article(&dir, "cet4-2023-12-nope.json").expect_err("不存在的文件应报损坏");
        let info = err.info();
        assert_eq!(info.kind, "pack_corrupt");
        assert_eq!(info.file.as_deref(), Some("cet4-2023-12-nope.json"));
        assert!(!info.message.contains(&dir.display().to_string()), "错误文案不得含绝对路径");
    }

    /// 包缺失 → PackMissing（不 panic），且 info 无 file
    #[test]
    fn missing_pack_reports_pack_missing() {
        let err = first_with_manifest(vec![PathBuf::from("Z:\\no-such-resource-dir\\content-pack")])
            .expect_err("候选目录都不含 manifest 时应报缺失");
        assert_eq!(err, StartupError::PackMissing);
        let info = err.info();
        assert_eq!(info.kind, "pack_missing");
        assert!(info.file.is_none());
        assert!(!info.message.contains("Z:\\"), "错误文案不得含探测到的绝对路径");
    }

    /// 标签查询：内置 12 篇全部有中文题型名与篇序标签
    #[test]
    fn labels_cover_all_articles() {
        let manifest = load_manifest(&pack_dir()).expect("manifest 应能解析");
        let labels = PackLabels::from_manifest(&manifest);
        for article in &manifest.articles {
            assert_eq!(
                labels.section_label(&article.source_key, Some(&article.section_type)),
                article.section_label.clone(),
                "{} 的 sectionLabel 应取 manifest 值",
                article.source_key
            );
            assert_eq!(
                labels.passage_label(&article.source_key),
                article.passage_label.clone(),
                "{} 的 passageLabel 应取 manifest 值",
                article.source_key
            );
        }
        assert_eq!(labels.passage_label("user-unknown"), None);
    }
}
