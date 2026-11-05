//! 内置内容包幂等导入（02 D3）：完整性核对 → 单事务 upsert 9 张内容表 → `ImportReport`。
//!
//! 红线（裁决 #8，代码审查专项）：**只允许 INSERT / UPDATE，禁止 DELETE 任何内容表行**。
//! `article` 被 5 张用户表 `ON DELETE CASCADE` 引用，删一篇会连带删掉用户的句子笔记/生词/复习记录，
//! 并把 `vocab_entry.source_article_id` 置 NULL——这是不可恢复的数据损失。下架一篇只能
//! `UPDATE article SET status='draft'`，永不做「先删后插」。
//!
//! 为什么必须 upsert 而不是重灌：`sentence_id` / `token_id` 是 M2 起用户笔记的挂载点，
//! 重排 id 会让用户挂在旧 id 上的笔记全部错位（01 §一）。
//!
//! 为什么版本相等也要核完整性：删掉的篇不会改变 `schema_meta.pack_version`，
//! 纯版本短路会让「删一篇能补回」（AC3）永久不可达。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::commands::CommandError;
use crate::db::Db;
use crate::pack::{self, ArticlePack, Manifest, ManifestArticle, Scalar, StartupErrorInfo};

/// 导入结果（IPC 形态 §三.0：imported / skipped / elapsedMs）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 本次实际写入/更新的篇数
    pub imported: i64,
    /// 本次判定为「已完整、零写入」的篇数
    pub skipped: i64,
    pub elapsed_ms: u64,
}

/// 9 张内容表（完整性核对与统计用的固定表名清单，不来自任何外部输入）
const CONTENT_TABLES: [&str; 9] = [
    "article",
    "paragraph",
    "sentence",
    "token",
    "sentence_analysis",
    "token_analysis",
    "lexicon",
    "blank",
    "question",
];

/// 启动时自动跑一次（lib.rs setup），也可由 `import_content_pack` 命令手动触发。
pub fn run(db: &Db, pack_dir: &Path, manifest: &Manifest) -> Result<ImportReport, StartupErrorInfo> {
    let started = Instant::now();
    let total = manifest.articles.len() as i64;

    // ── 第 0 步：完整性核对（**只读**，不碰任何行） ──
    let changes_before = db.total_changes().map_err(|err| err.startup_info())?;
    let targets = plan(db, manifest)?;

    if targets.is_empty() {
        // 完整 → 零写入返回（连 updated_at 都不动）
        let delta = db.total_changes().map_err(|err| err.startup_info())? - changes_before;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        println!(
            "[judou][import] pack={} imported=0 skipped={total} elapsed={elapsed_ms}ms total_changes_delta={delta}",
            manifest.pack_version
        );
        if delta != 0 {
            eprintln!("[judou][import] warning: 判定为完整但仍写入 {delta} 行（完整性核对必须是只读的）");
        }
        return Ok(ImportReport {
            imported: 0,
            skipped: total,
            elapsed_ms,
        });
    }

    // 内容包先全部解析完再开事务：包坏了就不该动库（避免「解到第 5 篇才炸」留下中间态）
    let mut loaded: Vec<(usize, ArticlePack)> = Vec::with_capacity(targets.len());
    for index in &targets {
        let article = &manifest.articles[*index];
        let pack = pack::load_article(pack_dir, &article.file).map_err(StartupErrorInfo::from)?;
        if pack.source_key != article.source_key {
            eprintln!(
                "[judou][import] warning: {} 的篇内 sourceKey={} 与 manifest 不一致，以 manifest 为准",
                article.file, pack.source_key
            );
        }
        loaded.push((*index, pack));
    }

    // ── 单事务写入：任何错误整体回滚（旧数据仍可用） ──
    let imported = db
        .write(|tx| write_all(tx, manifest, &loaded))
        .map_err(|err| err.startup_info())?;

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let delta = db.total_changes().map_err(|err| err.startup_info())? - changes_before;
    println!(
        "[judou][import] pack={} imported={imported} skipped={} elapsed={elapsed_ms}ms total_changes_delta={delta}",
        manifest.pack_version,
        total - imported
    );
    Ok(ImportReport {
        imported,
        skipped: total - imported,
        elapsed_ms,
    })
}

// ───────────────────────── 第 0 步：完整性核对 ─────────────────────────

/// 返回「需要写入的篇目索引」；空 = 已完整、应零写入。
fn plan(db: &Db, manifest: &Manifest) -> Result<Vec<usize>, StartupErrorInfo> {
    let all: Vec<usize> = (0..manifest.articles.len()).collect();

    let stored: Option<String> = db
        .read(|conn| {
            conn.query_row("SELECT value FROM schema_meta WHERE key = 'pack_version'", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|err| CommandError::db("读取内容包版本", err))
        })
        .map_err(|err| err.startup_info())?;

    if stored.as_deref() != Some(manifest.pack_version.as_str()) {
        println!(
            "[judou][import] 版本不一致：库内 {} → 包 {}（全量导入 {} 篇）",
            stored.unwrap_or_else(|| "<空>".to_string()),
            manifest.pack_version,
            all.len()
        );
        return Ok(all);
    }

    // 版本相等 → 先核完整性（① 缺篇差集 ② totals 计数）
    let existing: HashSet<String> = db
        .read(|conn| {
            let mut stmt = conn
                .prepare("SELECT source_key FROM article")
                .map_err(|err| CommandError::db("准备篇目查询", err))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| CommandError::db("读取篇目", err))?;
            let mut set = HashSet::new();
            for row in rows {
                set.insert(row.map_err(|err| CommandError::db("读取篇目", err))?);
            }
            Ok(set)
        })
        .map_err(|err| err.startup_info())?;

    let missing: Vec<usize> = all
        .iter()
        .copied()
        .filter(|index| !existing.contains(&manifest.articles[*index].source_key))
        .collect();

    let counts_ok = counts_match(db, manifest)?;

    if missing.is_empty() && counts_ok {
        return Ok(Vec::new());
    }
    if !missing.is_empty() {
        println!("[judou][import] 完整性核对：缺 {} 篇，只补缺失篇", missing.len());
        return Ok(missing);
    }

    // 差集空但计数不符（篇在、子表缺行）→ 定位受影响篇，整篇重导（S3）
    let affected = affected_articles(db, manifest)?;
    if affected.is_empty() {
        println!("[judou][import] warning: 计数不符但定位不出受影响篇 → 回退全量重导 {} 篇", all.len());
        return Ok(all);
    }
    println!("[judou][import] 计数不符，整篇重导 {} 篇：{:?}", affected.len(), affected);
    Ok(affected)
}

fn count_rows(db: &Db, table: &str) -> Result<i64, StartupErrorInfo> {
    debug_assert!(CONTENT_TABLES.contains(&table), "只允许查白名单内的内容表");
    db.read(|conn| {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(|err| CommandError::db("统计内容行数", err))
    })
    .map_err(|err| err.startup_info())
}

fn expected_total(totals: &pack::Totals, table: &str) -> i64 {
    match table {
        "article" => totals.articles,
        "paragraph" => totals.paragraphs,
        "sentence" => totals.sentences,
        "token" => totals.tokens,
        "sentence_analysis" => totals.sentence_analysis,
        "token_analysis" => totals.token_analysis,
        "lexicon" => totals.lexicon,
        "blank" => totals.blanks,
        "question" => totals.questions,
        _ => -1,
    }
}

fn counts_match(db: &Db, manifest: &Manifest) -> Result<bool, StartupErrorInfo> {
    for table in CONTENT_TABLES {
        let actual = count_rows(db, table)?;
        let expected = expected_total(&manifest.totals, table);
        if actual != expected {
            println!("[judou][import] 计数不符：{table} 实测 {actual} / 期望 {expected}");
            return Ok(false);
        }
    }
    Ok(true)
}

/// 差集为空但计数不符时，按篇反查受影响篇（分析表/词库无法归属 → 返回空 = 交给全量重导）
fn affected_articles(db: &Db, manifest: &Manifest) -> Result<Vec<usize>, StartupErrorInfo> {
    let sentence_analysis = count_rows(db, "sentence_analysis")?;
    let token_analysis = count_rows(db, "token_analysis")?;
    let lexicon = count_rows(db, "lexicon")?;
    if sentence_analysis != manifest.totals.sentence_analysis
        || token_analysis != manifest.totals.token_analysis
        || lexicon != manifest.totals.lexicon
    {
        return Ok(Vec::new());
    }

    db.read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT
                   (SELECT COUNT(*) FROM paragraph WHERE article_id = a.id),
                   (SELECT COUNT(*) FROM sentence WHERE article_id = a.id),
                   (SELECT COUNT(*) FROM token t JOIN sentence s ON s.id = t.sentence_id WHERE s.article_id = a.id),
                   (SELECT COUNT(*) FROM question WHERE article_id = a.id),
                   (SELECT COUNT(*) FROM blank WHERE article_id = a.id)
                 FROM article a WHERE a.source_key = ?1",
            )
            .map_err(|err| CommandError::db("准备完整性核对", err))?;

        let mut affected = Vec::new();
        for (index, article) in manifest.articles.iter().enumerate() {
            let row = stmt
                .query_row([&article.source_key], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .optional()
                .map_err(|err| CommandError::db("完整性核对", err))?;
            let Some((paragraphs, sentences, tokens, questions, blanks)) = row else {
                affected.push(index);
                continue;
            };
            if paragraphs != ManifestArticle::count_of(&article.paragraph_count)
                || sentences != ManifestArticle::count_of(&article.sentence_count)
                || tokens != ManifestArticle::count_of(&article.token_count)
                || questions != ManifestArticle::count_of(&article.question_count)
                || blanks != ManifestArticle::count_of(&article.blank_count)
            {
                affected.push(index);
            }
        }
        Ok(affected)
    })
    .map_err(|err| err.startup_info())
}

// ───────────────────────── 单事务写入 ─────────────────────────

/// ponytail: 每篇现 prepare 9 条语句（12 篇 = 108 次 prepare，全量导入实测 252ms），不引语句缓存；
/// 天花板 = prepare 次数与篇数成正比，等单篇上万 token 或内容包翻几倍，再改成全局 prepare 复用（节点口径不变）。
fn write_all(tx: &Transaction<'_>, manifest: &Manifest, loaded: &[(usize, ArticlePack)]) -> Result<i64, CommandError> {
    for (index, article_pack) in loaded {
        let meta = &manifest.articles[*index];
        write_article(tx, meta, article_pack, &manifest.pack_version)?;
    }
    write_lexicon(tx, loaded)?;

    // R11：`schema_meta.pack_version` 与 `article.pack_version` 同一事务写同一个值
    tx.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('pack_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [manifest.pack_version.as_str()],
    )
    .map_err(|err| CommandError::db("写回内容包版本", err))?;

    Ok(loaded.len() as i64)
}

fn write_article(
    tx: &Transaction<'_>,
    meta: &ManifestArticle,
    pack: &ArticlePack,
    pack_version: &str,
) -> Result<(), CommandError> {
    // B4 / 裁决 #11：source 取值规则（examMonth 取篇内 meta）
    let source = article_source(meta, pack.meta.exam_month.as_ref().and_then(Scalar::as_i64));
    let exam_set = meta.exam_set.as_ref().map(Scalar::as_text); // R12：数字也按 TEXT 写
    let word_count = meta.word_count.as_ref().and_then(Scalar::as_i64);
    let sentence_count = ManifestArticle::count_of(&meta.sentence_count);

    let mut st_article = tx
        .prepare(
            "INSERT INTO article
               (source_key, title, source, exam_type, exam_year, exam_set, section_type,
                word_count, visibility, sentence_count, pack_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'system', ?9, ?10)
             ON CONFLICT(source_key) DO UPDATE SET
               title = excluded.title,
               source = excluded.source,
               exam_type = excluded.exam_type,
               exam_year = excluded.exam_year,
               exam_set = excluded.exam_set,
               section_type = excluded.section_type,
               word_count = excluded.word_count,
               visibility = excluded.visibility,
               sentence_count = excluded.sentence_count,
               pack_version = excluded.pack_version,
               updated_at = datetime('now')
             RETURNING id",
        )
        .map_err(|err| CommandError::db("准备篇目写入", err))?;
    let article_id: i64 = st_article
        .query_row(
            params![
                meta.source_key.as_str(),
                meta.title.as_str(),
                source,
                meta.exam_type.as_str(),
                meta.exam_year_i64(),
                exam_set,
                meta.section_type.as_str(),
                word_count,
                sentence_count,
                pack_version
            ],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::db("写入篇目", err))?;

    let mut st_paragraph = tx
        .prepare(
            "INSERT INTO paragraph (article_id, idx, text) VALUES (?1, ?2, ?3)
             ON CONFLICT(article_id, idx) DO UPDATE SET text = excluded.text
             RETURNING id",
        )
        .map_err(|err| CommandError::db("准备段落写入", err))?;
    let mut st_sentence = tx
        .prepare(
            "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(paragraph_id, idx) DO UPDATE SET
               text = excluded.text, text_hash = excluded.text_hash,
               start_offset = excluded.start_offset, end_offset = excluded.end_offset
             RETURNING id",
        )
        .map_err(|err| CommandError::db("准备句子写入", err))?;
    let mut st_token = tx
        .prepare(
            "INSERT INTO token (sentence_id, idx, surface, normalized, is_word, start_offset, end_offset)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(sentence_id, idx) DO UPDATE SET
               surface = excluded.surface, normalized = excluded.normalized,
               is_word = excluded.is_word,
               start_offset = excluded.start_offset, end_offset = excluded.end_offset
             RETURNING id",
        )
        .map_err(|err| CommandError::db("准备词写入", err))?;
    let mut st_sentence_analysis = tx
        .prepare(
            "INSERT INTO sentence_analysis
               (sentence_id, translation_literal, translation_natural, struct_markup, structure_summary,
                paragraph_role, components_json, clauses_json, phrases_json, pitfalls_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(sentence_id) DO UPDATE SET
               translation_literal = excluded.translation_literal,
               translation_natural = excluded.translation_natural,
               struct_markup = excluded.struct_markup,
               structure_summary = excluded.structure_summary,
               paragraph_role = excluded.paragraph_role,
               components_json = excluded.components_json,
               clauses_json = excluded.clauses_json,
               phrases_json = excluded.phrases_json,
               pitfalls_json = excluded.pitfalls_json",
        )
        .map_err(|err| CommandError::db("准备句子解析写入", err))?;
    let mut st_token_analysis = tx
        .prepare(
            "INSERT INTO token_analysis
               (token_id, phonetic, pos, sense_in_context, collocations_json, examples_json,
                is_cet4_high_freq, more_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(token_id) DO UPDATE SET
               phonetic = excluded.phonetic, pos = excluded.pos,
               sense_in_context = excluded.sense_in_context,
               collocations_json = excluded.collocations_json,
               examples_json = excluded.examples_json,
               is_cet4_high_freq = excluded.is_cet4_high_freq,
               more_json = excluded.more_json",
        )
        .map_err(|err| CommandError::db("准备词解析写入", err))?;

    for paragraph in &pack.paragraphs {
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

            if let Some(analysis) = &sentence.analysis {
                st_sentence_analysis
                    .execute(params![
                        sentence_id,
                        analysis.translation_literal.as_deref(),
                        analysis.translation_natural.as_deref(),
                        analysis.struct_markup.as_deref(),
                        analysis.structure_summary.as_deref(),
                        analysis.paragraph_role.as_deref(),
                        json_or_null(&analysis.components)?,
                        json_or_null(&analysis.clauses)?,
                        json_or_null(&analysis.phrases)?,
                        json_or_null(&analysis.pitfalls)?
                    ])
                    .map_err(|err| CommandError::db("写入句子解析", err))?;
            }

            for (index, token) in sentence.tokens.iter().enumerate() {
                // 非词 token（标点/数字）的 normalized 在包里是 null，而列是 NOT NULL：
                // 回落 surface（is_word=0 已标明它不是词，M3 聚合生词只取 is_word=1）。
                let normalized = token.normalized.clone().unwrap_or_else(|| token.surface.clone());
                let token_id: i64 = st_token
                    .query_row(
                        params![
                            sentence_id,
                            index as i64,
                            token.surface.as_str(),
                            normalized,
                            // 内容包权威 isWord：true→1 / false→0（**禁止用 normalized 推导**）
                            i32::from(token.is_word),
                            token.start,
                            token.end
                        ],
                        |row| row.get(0),
                    )
                    .map_err(|err| CommandError::db("写入词", err))?;

                if let Some(analysis) = &token.analysis {
                    st_token_analysis
                        .execute(params![
                            token_id,
                            analysis.phonetic.as_deref(),
                            analysis.pos.as_deref(),
                            analysis.sense_in_context.as_deref(),
                            json_or_null(&analysis.collocations)?,
                            json_or_null(&analysis.examples)?,
                            i32::from(analysis.is_cet4_high_freq),
                            more_json(&analysis.more)?
                        ])
                        .map_err(|err| CommandError::db("写入词解析", err))?;
                }
            }
        }
    }

    // 题目：idx = 内容包 questions[].no（与 blank_no 同源，是 explanation 的配对键）
    let mut st_question = tx
        .prepare(
            "INSERT INTO question (article_id, idx, stem, options_json, answer, explanation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(article_id, idx) DO UPDATE SET
               stem = excluded.stem, options_json = excluded.options_json,
               answer = excluded.answer, explanation = excluded.explanation",
        )
        .map_err(|err| CommandError::db("准备题目写入", err))?;
    for question in &pack.questions {
        let options_json = serde_json::to_string(&question.options)
            .map_err(|err| CommandError::db_io("序列化题目选项", err))?;
        // explanation 只是 cloze 篇 blank.reason 的投影；无对应空格的篇写空串（05 §二 L76）
        let explanation = pack
            .blanks
            .get(&question.no.to_string())
            .and_then(|blank| blank.reason.clone())
            .unwrap_or_default();
        st_question
            .execute(params![
                article_id,
                question.no,
                question.stem.as_str(),
                options_json,
                question.answer.as_deref(),
                explanation
            ])
            .map_err(|err| CommandError::db("写入题目", err))?;
    }

    // 空格：`blank_nos` 是权威清单（渲染要 `blank` 行存在才认得出空格位），`blanks` 提供解析。
    // 只遍历 `blank_nos`：包里若出现「有解析没编号」的键，它本来就不该被渲染成空格（不猜）。
    let mut st_blank = tx
        .prepare(
            "INSERT INTO blank (article_id, blank_no, answer_key, answer_word, reason, distractors)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(article_id, blank_no) DO UPDATE SET
               answer_key = excluded.answer_key, answer_word = excluded.answer_word,
               reason = excluded.reason, distractors = excluded.distractors",
        )
        .map_err(|err| CommandError::db("准备空格写入", err))?;
    for blank_no in &pack.blank_nos {
        let blank = pack.blanks.get(&blank_no.to_string());
        st_blank
            .execute(params![
                article_id,
                blank_no,
                blank.and_then(|b| b.answer_key.as_deref()),
                blank.and_then(|b| b.answer_word.as_deref()),
                blank.and_then(|b| b.reason.as_deref()),
                blank.and_then(|b| b.distractors.as_ref().map(pack::Distractors::to_stored))
            ])
            .map_err(|err| CommandError::db("写入空格", err))?;
    }

    Ok(())
}

/// 词库：12 篇切片合并去重（normalized 主键）
///
/// `word` = 该 normalized **首次出现** token 的 surface（先到优先、**不覆盖**）：
/// 首次导入时按 manifest → 段落 → 句子 → token 顺序扫描，先写进去的就是权威值；
/// 后续补导/重导时 `ON CONFLICT` 不更新 `word`，已有值不会被后到的篇改写。
fn write_lexicon(tx: &Transaction<'_>, loaded: &[(usize, ArticlePack)]) -> Result<(), CommandError> {
    let mut st_lexicon = tx
        .prepare(
            "INSERT INTO lexicon
               (normalized, word, phonetic, pos, sense, lemma, collocations_json, examples_json,
                is_cet_high_freq, more_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(normalized) DO UPDATE SET
               phonetic = excluded.phonetic, pos = excluded.pos, sense = excluded.sense,
               lemma = excluded.lemma,
               collocations_json = excluded.collocations_json,
               examples_json = excluded.examples_json,
               is_cet_high_freq = excluded.is_cet_high_freq,
               more_json = excluded.more_json",
        )
        .map_err(|err| CommandError::db("准备词库写入", err))?;

    for (_, pack) in loaded {
        let surfaces = first_surfaces(pack);
        for (normalized, entry) in &pack.lexicon {
            let word = surfaces
                .get(normalized)
                .cloned()
                .unwrap_or_else(|| normalized.clone());
            st_lexicon
                .execute(params![
                    normalized.as_str(),
                    word,
                    entry.phonetic.as_deref(),
                    entry.pos.as_deref(),
                    entry.sense.as_deref(),
                    entry.lemma.as_deref(),
                    json_or_null(&entry.collocations)?,
                    json_or_null(&entry.examples)?,
                    i32::from(entry.is_cet4_high_freq),
                    more_json(&entry.more)?
                ])
                .map_err(|err| CommandError::db("写入词库", err))?;
        }
    }
    Ok(())
}

/// 本篇 normalized → 首次出现 surface（段落/句子/token 顺序，先到优先）
fn first_surfaces(pack: &ArticlePack) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    for paragraph in &pack.paragraphs {
        for sentence in &paragraph.sentences {
            for token in &sentence.tokens {
                if let Some(normalized) = &token.normalized {
                    map.entry(normalized.clone()).or_insert_with(|| token.surface.clone());
                }
            }
        }
    }
    map
}

/// `article.source` 取值规则（B4 / 裁决 #11）：`CET-<N> <年>年<月>月真题`
///
/// 现行内置包 12 篇实测全为 `CET-4 2023年12月真题`；缺 `examMonth` 时退化为 `…年真题` 并记 warning。
fn article_source(meta: &ManifestArticle, exam_month: Option<i64>) -> String {
    let level: String = meta.exam_type.chars().filter(char::is_ascii_digit).collect();
    let prefix = if level.is_empty() {
        meta.exam_type.to_uppercase()
    } else {
        format!("CET-{level}")
    };
    match (meta.exam_year_i64(), exam_month) {
        (Some(year), Some(month)) => format!("{prefix} {year}年{month}月真题"),
        (Some(year), None) => {
            eprintln!("[judou][import] warning: {} 缺 meta.examMonth，source 退化为「{prefix} {year}年真题」", meta.source_key);
            format!("{prefix} {year}年真题")
        }
        (None, _) => {
            eprintln!("[judou][import] warning: {} 缺 examYear，source 无法成句", meta.source_key);
            format!("{prefix} 真题")
        }
    }
}

/// `sentence.text_hash` = sha256(text) 前 16 位十六进制（8 字节）
fn text_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 空数组写 `[]`（不是 NULL）：读取侧按 JSON 解析，NULL 会多一种分支
fn json_or_null<T: serde::Serialize>(value: &T) -> Result<String, CommandError> {
    serde_json::to_string(value).map_err(|err| CommandError::db_io("序列化 JSON 列", err))
}

/// `more` 是可选对象：无值写 NULL（与 `[]` 区分开）
fn more_json(value: &Option<serde_json::Value>) -> Result<Option<String>, CommandError> {
    match value {
        Some(value) => Ok(Some(
            serde_json::to_string(value).map_err(|err| CommandError::db_io("序列化 more 列", err))?,
        )),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间异常")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("judou-import-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        dir.join("judou.db")
    }

    fn pack_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(pack::PACK_DIR_NAME)
    }

    /// 首启导入 12 篇 → 九表计数逐项对上；二启零写入（total_changes 差值 = 0、MAX(id) 不变）。
    /// 这条用例能证明失败：导入前九表全空（本包实测 0/12）。
    #[test]
    fn import_is_idempotent_and_counts_match_totals() {
        let path = temp_db("idem");
        let db = Db::open(path.clone()).expect("建库失败");
        let dir = pack_dir();
        let manifest = pack::load_manifest(&dir).expect("manifest 应能解析");

        let first = run(&db, &dir, &manifest).expect("首启导入应成功");
        assert_eq!(first.imported, 12, "首启应导入 12 篇");
        assert_eq!(first.skipped, 0);

        let counts = |db: &Db| -> Vec<(String, i64)> {
            db.read(|conn| {
                let mut out = Vec::new();
                for table in CONTENT_TABLES {
                    let n: i64 = conn
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                        .expect("计数失败");
                    out.push((table.to_string(), n));
                }
                Ok(out)
            })
            .expect("读计数失败")
        };
        let after_first = counts(&db);
        let expected = [12, 90, 274, 6699, 274, 213, 1561, 30, 90];
        for (index, (table, actual)) in after_first.iter().enumerate() {
            assert_eq!(*actual, expected[index], "{table} 行数应为 {}", expected[index]);
        }

        let max_article_id: i64 = db
            .read(|conn| {
                conn.query_row("SELECT MAX(id) FROM article", [], |row| row.get(0))
                    .map_err(|err| CommandError::db("读 id", err))
            })
            .expect("读 id 失败");

        // 二启：版本相同且完整 → 零写入
        let before = db.total_changes().expect("读写入计数失败");
        let second = run(&db, &dir, &manifest).expect("二启应成功");
        let delta = db.total_changes().expect("读写入计数失败") - before;
        assert_eq!(second.imported, 0, "二启不应再写");
        assert_eq!(second.skipped, 12);
        assert_eq!(delta, 0, "二启必须零写入，实测写入 {delta} 行");
        assert_eq!(counts(&db), after_first, "二启后行数不应变化");
        let max_article_id_again: i64 = db
            .read(|conn| {
                conn.query_row("SELECT MAX(id) FROM article", [], |row| row.get(0))
                    .map_err(|err| CommandError::db("读 id", err))
            })
            .expect("读 id 失败");
        assert_eq!(max_article_id, max_article_id_again, "id 不应重排");

        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// 删一篇（模拟下架/误删）后重启：只补回那一篇，九表计数回到全量。
    /// 证明「完整性核对」真的生效（纯版本短路会让这条永远不可达）。
    #[test]
    fn missing_article_is_restored_by_source_key() {
        let path = temp_db("restore");
        let db = Db::open(path.clone()).expect("建库失败");
        let dir = pack_dir();
        let manifest = pack::load_manifest(&dir).expect("manifest 应能解析");
        run(&db, &dir, &manifest).expect("首启导入应成功");

        // 删掉 set2A（AC3 的手工删篇同口径）；级联会带走它的子表行
        db.write(|tx| {
            tx.execute("DELETE FROM article WHERE source_key = ?1", ["cet4-2023-12-set2A"])
                .map_err(|err| CommandError::db("删测试篇", err))?;
            Ok(())
        })
        .expect("删测试篇失败");

        let report = run(&db, &dir, &manifest).expect("补导应成功");
        assert_eq!(report.imported, 1, "应只补 1 篇");
        assert_eq!(report.skipped, 11);

        let article = count_rows(&db, "article").expect("计数失败");
        let sentence = count_rows(&db, "sentence").expect("计数失败");
        let token = count_rows(&db, "token").expect("计数失败");
        assert_eq!(article, 12);
        assert_eq!(sentence, 274);
        assert_eq!(token, 6699);

        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// D3 第三态（篇都在、子表缺行）：定位受影响篇 → **整篇重导**，不是跳过、也不是全量。
    /// 造场：删 set2A 的 2 行 `question`（不删篇，且不碰 `sentence_analysis` / `token_analysis` /
    /// `lexicon`——这三张表无法归属到篇，一旦缺失只能回退全量重导，见第二段）。
    #[test]
    fn missing_child_rows_are_restored_by_reimporting_that_article() {
        let path = temp_db("child-rows");
        let db = Db::open(path.clone()).expect("建库失败");
        let dir = pack_dir();
        let manifest = pack::load_manifest(&dir).expect("manifest 应能解析");
        run(&db, &dir, &manifest).expect("首启导入应成功");

        // 第一段：子表缺行 + 分析表完整 → 能归属到篇 → 只重导这 1 篇
        db.write(|tx| {
            tx.execute(
                "DELETE FROM question WHERE id IN (
                   SELECT q.id FROM question q JOIN article a ON a.id = q.article_id
                   WHERE a.source_key = ?1 ORDER BY q.idx LIMIT 2)",
                ["cet4-2023-12-set2A"],
            )
            .map_err(|err| CommandError::db("删测试题目", err))?;
            Ok(())
        })
        .expect("删测试题目失败");
        assert_eq!(count_rows(&db, "question").expect("计数失败"), 88, "删 2 行后应剩 88 行");

        let report = run(&db, &dir, &manifest).expect("整篇重导应成功");
        assert_eq!(report.imported, 1, "应只重导受影响的 1 篇（第三态而非全量/跳过）");
        assert_eq!(report.skipped, 11);
        assert_eq!(count_rows(&db, "question").expect("计数失败"), 90, "该篇题目应回全量");

        // 第二段：删 sentence 行会级联带走 sentence_analysis / token_analysis（无法归属到篇）
        // → 回退全量重导（D3 的安全兜底），九表计数同样必须回全量
        db.write(|tx| {
            tx.execute(
                "DELETE FROM sentence WHERE id IN (
                   SELECT s.id FROM sentence s JOIN article a ON a.id = s.article_id
                   WHERE a.source_key = ?1 ORDER BY s.idx LIMIT 2)",
                ["cet4-2023-12-set2A"],
            )
            .map_err(|err| CommandError::db("删测试句子", err))?;
            Ok(())
        })
        .expect("删测试句子失败");
        assert_eq!(count_rows(&db, "sentence").expect("计数失败"), 272);

        let fallback = run(&db, &dir, &manifest).expect("全量重导应成功");
        assert_eq!(fallback.imported, 12, "分析表缺行无法归属 → 回退全量重导");
        assert_eq!(count_rows(&db, "sentence").expect("计数失败"), 274);
        assert_eq!(count_rows(&db, "token").expect("计数失败"), 6699);

        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// 重导（upsert 路径，非删后重建）不得重排 id：
    /// 用户笔记挂在 `sentence_id` / `token_id` 上（M2 起是真实数据），id 一漂全部错位。
    /// 做法：把 `schema_meta.pack_version` 改成旧值 → 触发全量重导 → id 必须一一对应。
    #[test]
    fn reimport_keeps_sentence_ids_stable() {
        let path = temp_db("stable");
        let db = Db::open(path.clone()).expect("建库失败");
        let dir = pack_dir();
        let manifest = pack::load_manifest(&dir).expect("manifest 应能解析");
        run(&db, &dir, &manifest).expect("首启导入应成功");

        let ids = |db: &Db| -> Vec<i64> {
            db.read(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT s.id FROM sentence s JOIN article a ON a.id = s.article_id
                         WHERE a.source_key = 'cet4-2023-12-set2A' ORDER BY s.id",
                    )
                    .map_err(|err| CommandError::db("读句子 id", err))?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, i64>(0))
                    .map_err(|err| CommandError::db("读句子 id", err))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(|err| CommandError::db("读句子 id", err))?);
                }
                Ok(out)
            })
            .expect("读句子 id 失败")
        };
        let ids_before = ids(&db);
        assert_eq!(ids_before.len(), 15, "set2A 应有 15 句");

        // 把版本游标改成旧值，强制走「全量重导」分支（等价于内容包升级）
        db.write(|tx| {
            tx.execute("UPDATE schema_meta SET value = 'old-pack' WHERE key = 'pack_version'", [])
                .map_err(|err| CommandError::db("改测试版本", err))?;
            Ok(())
        })
        .expect("改测试版本失败");

        let report = run(&db, &dir, &manifest).expect("重导应成功");
        assert_eq!(report.imported, 12, "版本不一致应全量重导");
        assert_eq!(ids(&db), ids_before, "重导不得重排 sentence_id（用户笔记挂在这里）");
        assert_eq!(count_rows(&db, "sentence").expect("计数失败"), 274, "重导不得产生重复句子");

        std::fs::remove_dir_all(path.parent().expect("有父目录")).ok();
    }

    /// `article.source` 规则与 `text_hash` 口径
    #[test]
    fn source_and_hash_follow_the_rule() {
        let meta = ManifestArticle {
            source_key: "k".into(),
            file: "f.json".into(),
            title: "t".into(),
            exam_type: "cet4".into(),
            exam_year: Some(Scalar::Int(2023)),
            exam_set: Some(Scalar::Int(1)),
            section_type: "careful".into(),
            section_label: None,
            passage_label: None,
            word_count: None,
            paragraph_count: None,
            sentence_count: None,
            token_count: None,
            question_count: None,
            blank_count: None,
        };
        assert_eq!(article_source(&meta, Some(12)), "CET-4 2023年12月真题");
        assert_eq!(article_source(&meta, None), "CET-4 2023年真题");
        assert_eq!(text_hash("abc").len(), 16);
        assert_eq!(text_hash("abc"), text_hash("abc"));
        assert_ne!(text_hash("abc"), text_hash("abd"));
    }
}
