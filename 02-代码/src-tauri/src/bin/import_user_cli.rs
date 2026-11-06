//! M5 D8 门禁契约：把 `import_user.rs` 的纯函数与两阶段入库跑一遍，输出**一行 JSON** 给
//! `scripts/verify-import-user.mjs` 断言。
//!
//! 为什么是 bin 而不是只靠 `#[cfg(test)]`：门禁要同时验「Rust 纯函数口径」和「Node 侧 `node:sqlite`
//! 同序迁移后的真实库行为」，走一个显式契约比在两边各写一份切句器更不容易漂移（02 §四 AC2~AC6）。
//!
//! 用法：`cargo run --offline --bin import_user_cli -- all <dbPath>`
//!   给了 `<dbPath>`（门禁传 `node:sqlite` 建好的同序迁移库）→ **直接用那个库**跑入库，
//!   门禁随后能直查同一份数据；不给 → 自建临时库（人工排查用）。
//! 输出：stdout 一行 JSON；业务失败不写 stderr、退出码恒为 0（错误码在 JSON 里）。

use std::path::PathBuf;

use judou_lib::import_user::{
    clean_text, commit_import, map_unique, parse_import_preview, split_paragraphs, split_sentences, tokenize,
    ImportMeta, ImportPreview,
};
use serde_json::{json, Value};

fn main() {
    let mut args = std::env::args().skip(1);
    let case = args.next().unwrap_or_else(|| "all".to_string());
    let db_path = args.next();
    let report = match case.as_str() {
        "debug" => debug_cases(),
        "all" => all(db_path),
        other => json!({ "fatal": format!("未知 case：{other}") }),
    };
    println!("{}", serde_json::to_string(&report).expect("序列化报告失败"));
}

/// 含 emoji / 中文标点的样本（UTF-16 偏移专项）
const UTF16_SAMPLES: [(&str, &str); 2] = [
    ("emoji", "I love 😀 fun. Next one."),
    ("cjk_punct", "他说：“好。” She smiled. Done."),
];

fn all(db_path: Option<String>) -> Value {
    json!({
        "clean": clean_cases(),
        "segment": segment_cases(),
        "sentence": sentence_cases(),
        "token": token_cases(),
        "numbers": number_cases(),
        "utf16": utf16_cases(),
        "offsets": offset_cases(),
        "parse": parse_cases(),
        "errors": error_cases(),
        "commit": commit_cases(db_path),
    })
}

// ───────────────────────── AC2 ─────────────────────────
fn clean_cases() -> Value {
    let raw = "\u{feff}First line.\u{200b}\r\nSecond\u{200c} line.\u{200d}\r\r\n\n\n\nThird line.\u{feff}\r";
    let cleaned = clean_text(raw);
    let zero_width: Vec<String> = cleaned
        .chars()
        .filter(|c| matches!(c, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}'))
        .map(|c| format!("U+{:04X}", c as u32))
        .collect();
    json!({
        "cleaned": cleaned,
        "hasBom": cleaned.contains('\u{feff}'),
        "hasCr": cleaned.contains('\r'),
        "zeroWidth": zero_width,
        "blankRun": if cleaned.contains("\n\n\n") { "\n\n\n" } else { "\n\n" },
        "lineEndings": [clean_text("a\r\nb"), clean_text("a\rb")],
    })
}

// ───────────────────────── AC3 ─────────────────────────
fn segment_cases() -> Value {
    let text = "P1 line1.\nP1 line2.\n\n\n\n   \n\nP2 here.\n\nP3 there.";
    let paras = split_paragraphs(&clean_text(text));
    json!({
        "paragraphs": paras,
        "count": paras.len(),
        "idxs": (0..paras.len()).collect::<Vec<usize>>(),
    })
}

// ───────────────────────── AC4 ─────────────────────────
fn sentence_texts(text: &str) -> Vec<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    split_sentences(text)
        .into_iter()
        .map(|(s, e)| String::from_utf16_lossy(&units[s..e]).to_string())
        .collect()
}

fn sentence_cases() -> Value {
    let others = [
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
    ];
    let mut others_pass = 0;
    let mut pairs = Vec::new();
    for line in others {
        let got = sentence_texts(line);
        pairs.push(json!({ "in": line, "out": got }));
        if got.len() == 1 {
            others_pass += 1;
        }
    }
    json!({
        "basic": sentence_texts("One end. Next one."),
        "mrSmith": sentence_texts("Mr. Smith said."),
        "usEconomy": sentence_texts("The U.S. economy grew."),
        "decimal": sentence_texts("Pi is 3.14 now."),
        "quoted": sentence_texts("He said \"Done.\""),
        "interrobang": sentence_texts("What?! Really?"),
        "others": others_pass,
        "othersDetail": pairs,
        "abbreviationCount": 18,
    })
}

// ───────────────────────── AC5 ─────────────────────────
fn token_cases() -> Value {
    let apostrophe = tokenize("Students' work is done.")[0].clone();
    let hyphen = tokenize("A day-to-day job.")[1].clone();
    let space_in_token = tokenize("a b").iter().any(|t| t.surface.trim().is_empty());
    let surface_has_space = tokenize("a b").iter().any(|t| t.surface.contains(' '));
    json!({
        "apostrophe": apostrophe,
        "hyphen": hyphen,
        "noSpaceTokens": !space_in_token && !surface_has_space,
    })
}

fn number_cases() -> Value {
    ["1997", "150", "88,000"]
        .iter()
        .map(|s| {
            let tokens = tokenize(s);
            json!({
                "input": s,
                "count": tokens.len(),
                "surface": tokens.first().map(|t| t.surface.clone()),
                "isWord": tokens.first().map(|t| t.is_word),
                "normalized": tokens.first().and_then(|t| t.normalized.clone()),
            })
        })
        .collect::<Vec<Value>>()
        .into()
}

fn utf16_cases() -> Value {
    UTF16_SAMPLES
        .iter()
        .map(|(label, text)| {
            let units: Vec<u16> = text.encode_utf16().collect();
            let mut token_slices_equal = true;
            let mut coverage_equal = true;
            let mut token_detail: Vec<Value> = Vec::new();
            let mut sentence_slices_equal = true;
            for (s, e) in split_sentences(text) {
                let sentence_text = String::from_utf16_lossy(&units[s..e]).to_string();
                if sentence_text != String::from_utf16_lossy(&units[s..e]) {
                    sentence_slices_equal = false;
                }
                let sent_units: Vec<u16> = sentence_text.encode_utf16().collect();
                let tokens = tokenize(&sentence_text);
                let mut covered = vec![false; sent_units.len()];
                for token in &tokens {
                    let slice = String::from_utf16_lossy(&sent_units[token.start as usize..token.end as usize])
                        .to_string();
                    if slice != token.surface {
                        token_slices_equal = false;
                    }
                    for slot in covered.iter_mut().take(token.end as usize).skip(token.start as usize) {
                        *slot = true;
                    }
                    token_detail.push(json!({
                        "surface": token.surface,
                        "start": token.start,
                        "end": token.end,
                        "slice": slice,
                    }));
                }
                // 覆盖：除空格外的单位都必须被覆盖
                for (index, unit) in sent_units.iter().enumerate() {
                    let is_space = char::from_u32(*unit as u32).is_some_and(char::is_whitespace);
                    if !is_space && !covered[index] {
                        coverage_equal = false;
                    }
                }
            }
            json!({
                "label": label,
                "text": text,
                "utf16Length": units.len(),
                "utf16Measured": text.chars().map(char::len_utf16).sum::<usize>(),
                "byteLength": text.len(),
                "sentenceSlicesEqual": sentence_slices_equal,
                "tokenSlicesEqual": token_slices_equal,
                "coverageEqual": coverage_equal,
                "tokens": token_detail,
            })
        })
        .collect::<Vec<Value>>()
        .into()
}

fn offset_cases() -> Value {
    // 句偏移相对段：第二句的 start 必须 = 第一句 end + 1（一空格）
    let paragraph = "I love 😀 fun. Next one.";
    let sentences = split_sentences(paragraph);
    let units: Vec<u16> = paragraph.encode_utf16().collect();
    let first = sentences.first().copied().unwrap_or((0, 0));
    let second = sentences.get(1).copied().unwrap_or((0, 0));
    json!([
        {
            "label": "sentence2.start（emoji 占 2 个 UTF-16 单位）",
            "start": second.0,
            "end": second.1,
            "expectStart": first.1 + 1,
            "expectEnd": units.len(),
        },
        {
            "label": "sentence1.end（含句点）",
            "start": first.0,
            "end": first.1,
            "expectStart": 0,
            // "I love 😀 fun." = 14 个 UTF-16 单位（I/空格/love/空格/😀(2)/空格/fun/句点）；
            // 字节口径会是 17、字符口径会是 13——写死是为了让口径差在门禁里立刻暴露
            "expectEnd": 14,
        }
    ])
}

// ───────────────────────── AC1 预览不写库 ─────────────────────────
const SAMPLE: &str = "Reading is a habit that builds over time. \
Many people read slowly at first.\n\n\
Practice makes the habit stronger every single day. \
Keep a notebook beside you while you read.";

fn parse_cases() -> Value {
    let preview = match parse_import_preview(SAMPLE, Some("样例")) {
        Ok(preview) => preview,
        Err(err) => return json!({ "error": err.code }),
    };
    json!({
        "stats": preview.stats,
        "title": preview.title,
        "paragraphs": preview.paragraphs.len(),
    })
}

// ───────────────────────── AC6 四层校验 + 六错误码 ─────────────────────────
fn valid_preview() -> ImportPreview {
    parse_import_preview(SAMPLE, Some("我的第一篇")).expect("样例应能解析")
}

fn expect_code(result: Result<(), judou_lib::commands::CommandError>) -> Value {
    match result {
        Ok(()) => json!({ "code": "OK" }),
        Err(err) => json!({ "code": err.code, "message": err.message }),
    }
}

fn debug_cases() -> Value {
    let cleaned = clean_text(SAMPLE);
    let paragraphs = split_paragraphs(&cleaned);
    let mut detail = Vec::new();
    for p in &paragraphs {
        let sents = split_sentences(p);
        detail.push(json!({ "para": p, "units": p.encode_utf16().count(), "sents": sents }));
    }
    let direct = split_sentences("It is fine. Really.");
    json!({ "cleaned": cleaned, "paragraphs": paragraphs, "detail": detail, "direct": direct })
}

fn error_cases() -> Value {
    // L1：idx 不连续
    let mut l1 = valid_preview();
    l1.paragraphs[0].idx = 3;
    let l1_code = expect_code(judou_lib::import_user::validate_l1(&l1));

    // L2：句子偏移错位（start 挪 1）
    let mut l2 = valid_preview();
    l2.paragraphs[0].sentences[0].start += 1;
    let l2_code = expect_code(judou_lib::import_user::validate_l2(&l2));

    // L3：第一句最后一个 token 少覆盖最后一个字母
    let mut l3 = valid_preview();
    if let Some(token) = l3.paragraphs[0].sentences[0].tokens.last_mut() {
        token.end -= 1;
    }
    let l3_code = expect_code(judou_lib::import_user::validate_l3(&l3));

    // L4：只有 3 个词
    let mut l4 = parse_import_preview("Short text here.", Some("短")).expect("短文本可解析");
    l4.paragraphs[0].sentences[0].tokens.truncate(3);
    let l4_code = expect_code(judou_lib::import_user::validate_l4(&l4));

    // L4 第二形态：控制字符（BEL）
    let mut l4c = valid_preview();
    l4c.paragraphs[0].text.push('\u{7}');
    let l4c_code = expect_code(judou_lib::import_user::validate_l4(&l4c));

    // TOO_LARGE：20001 字符
    let too_large = parse_import_preview(&"a ".repeat(10_001), None);
    let too_large_code = match too_large {
        Ok(_) => json!({ "code": "OK" }),
        Err(err) => json!({ "code": err.code, "message": err.message }),
    };

    json!({
        "L1": l1_code,
        "L2": l2_code,
        "L3": l3_code,
        "L4": l4_code,
        "L4_control": l4c_code,
        "TOO_LARGE": too_large_code,
    })
}

// ───────────────────────── AC7 入库 + 两篇 + 撞 UNIQUE ─────────────────────────
fn commit_cases(db_path: Option<String>) -> Value {
    let dir = temp_dir();
    let path = db_path.map(PathBuf::from).unwrap_or_else(|| dir.join("judou.db"));
    let db = match judou_lib::db::Db::open(path.clone()) {
        Ok(db) => db,
        Err(err) => return json!({ "fatal": format!("建库失败：{}", err.code) }),
    };
    let meta = ImportMeta {
        exam_type: Some("cet6".to_string()),
        exam_year: Some(2022),
    };

    // 零写入探针最先跑：此时库里还没有本批写入，任何差值都只能来自 parse
    let changes_before = db.total_changes().unwrap_or(-1);
    let _preview_stats = match parse_import_preview(SAMPLE, Some("我的第一篇")) {
        Ok(preview) => preview.stats,
        Err(err) => return json!({ "fatal": format!("parse 失败：{}", err.code) }),
    };
    let parse_delta = db.total_changes().unwrap_or(0) - changes_before;

    // 第一次 commit
    let first = valid_preview();
    let first_result = match commit_import(&db, &first, &meta) {
        Ok(result) => result,
        Err(err) => return json!({ "fatal": format!("首次 commit 失败：{err:?}") }),
    };

    // 第二次 commit（同一 preview → 新文章，不是覆盖）
    let second_result = match commit_import(&db, &first, &meta) {
        Ok(result) => result,
        Err(err) => return json!({ "fatal": format!("二次 commit 失败：{err:?}") }),
    };

    
    // 错误路径的零写入：改坏 preview 后 commit → 必须报码且 total_changes 不动
    let mut broken = valid_preview();
    broken.paragraphs[0].sentences[0].start += 1;
    let err_before = db.total_changes().unwrap_or(0);
    let err_counts_before = counts(&db);
    let err_result = commit_import(&db, &broken, &meta);
    let err_delta = db.total_changes().unwrap_or(0) - err_before;
    let err_counts_after = counts(&db);

    // 撞 UNIQUE：直接伪造一条同 source_key 的文章，再让它被「下一次 commit」用到
    // （commit 的 uuid 是现生成的，无法预知；所以这里验证映射函数的行为：
    //   手工 INSERT 一行与 first_result.source_key 相同的文章 → 报 UNIQUE → 走 DUPLICATE 分支）
    let dup_before = db.total_changes().unwrap_or(0);
    let dup_counts_before = counts(&db);
    let dup_code = {
        use rusqlite::params;
        let res = db.write(|tx| {
            tx.execute(
                "INSERT INTO article (source_key, title, exam_type, visibility, sentence_count)
                 VALUES (?1, 'dup', 'other', 'user', 1)",
                params![first_result.source_key],
            )
            .map_err(map_unique)
        });
        match res {
            Ok(_) => json!({ "code": "OK" }),
            Err(err) => json!({ "code": err.code }),
        }
    };
    let dup_delta = db.total_changes().unwrap_or(0) - dup_before;
    let dup_counts_after = counts(&db);

    // 回读：库里落下的句子/词能否按偏移切片（L2 在库里的延伸）
    let readback = readback_mismatches(&db, first_result.article_id);

    // 剔除段落（用户可在预览页剔段）：删掉第 2 段后 commit → 库里 paragraph/sentence 计数跟着变。
    // **用独立临时库**：在同一个库上多写一篇会让「两次 commit = 两篇」的直查断言数到 3 行，
    // 门禁就得为这一个用例把后面所有绝对数字都改一遍（数字越多越容易写错）。
    let trimmed_row = match judou_lib::db::Db::open(dir.join("trimmed.db")) {
        Ok(trim_db) => {
            let mut trimmed = valid_preview();
            trimmed.paragraphs.truncate(1);
            trimmed.stats.paragraph_count = 1;
            trimmed.stats.sentence_count = trimmed.paragraphs[0].sentences.len() as i64;
            match commit_import(&trim_db, &trimmed, &meta) {
                Ok(result) => {
                    let row = trim_db
                        .read(|conn| {
                            conn.query_row(
                                "SELECT sentence_count, (SELECT COUNT(*) FROM paragraph p WHERE p.article_id = a.id)
                                 FROM article a WHERE a.id = ?1",
                                [result.article_id],
                                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                            )
                            .map_err(|err| judou_lib::commands::CommandError {
                                code: "db".into(),
                                message: err.to_string(),
                                path: None,
                            })
                        })
                        .unwrap_or((-1, -1));
                    json!({ "sentence_count": row.0, "paragraphs": row.1, "previewSentences": trimmed.stats.sentence_count })
                }
                Err(err) => json!({ "error": err.code }),
            }
        }
        Err(err) => json!({ "error": err.code }),
    };

    // 篇数是**实测**（不是写死的常量）：门禁拿它比 2，写死就等于自证
    let article_rows = counts(&db).get("article").copied().unwrap_or(-1);

    json!({
        "articleRowsAdded": article_rows,
        "parse": { "stats": first.stats },
        "sourceKeyShape": [
            is_user_key(&first_result.source_key),
            is_user_key(&second_result.source_key),
        ],
        "sourceKeyDistinct": first_result.source_key != second_result.source_key,
        "row": {
            "sentence_count": first.stats.sentence_count,
            "realSentences": count_sentences(&db, first_result.article_id),
            "realParagraphs": count_paragraphs(&db, first_result.article_id),
            "token_count": first.stats.token_count,
            "realTokens": count_tokens(&db, first_result.article_id),
            "word_count": first.stats.word_count,
            "realWords": count_words(&db, first_result.article_id),
            "exam_type": first_exam_type(&db, first_result.article_id),
            "exam_year": first_exam_year(&db, first_result.article_id),
        },
        "trimmed": trimmed_row,
        "titleFromUser": first.title,
        "titleFallback": {
            "got": parse_import_preview(SAMPLE, None).map(|p| p.title).unwrap_or_default(),
            "expect": SAMPLE.chars().take(40).collect::<String>(),
        },
        "titleEmpty": {
            "got": parse_import_preview("   \n\n  ", None).map(|p| p.title).unwrap_or_default(),
        },
        "readbackMismatches": readback,
        "errors": {
            "L2": {
                "code": err_result.as_ref().err().map(|e| e.code.clone()).unwrap_or_else(|| "OK".into()),
                "delta": err_delta,
                "countsBefore": err_counts_before,
                "countsAfter": err_counts_after,
            },
            "DUPLICATE": {
                "code": dup_code["code"],
                "delta": dup_delta,
                "countsBefore": dup_counts_before,
                "countsAfter": dup_counts_after,
            },
        },
        "totals": { "parseDelta": parse_delta },
    })
}

fn temp_dir() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("judou-import-cli-{nanos}"));
    std::fs::create_dir_all(&dir).expect("建临时目录失败");
    dir
}

fn counts(db: &judou_lib::db::Db) -> std::collections::BTreeMap<String, i64> {
    let tables = [
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
    let mut out = std::collections::BTreeMap::new();
    for table in tables {
        let n = db
            .read(|conn| {
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
                    .map_err(|err| judou_lib::commands::CommandError {
                        code: "db".into(),
                        message: err.to_string(),
                        path: None,
                    })
            })
            .unwrap_or(-1);
        out.insert(table.to_string(), n);
    }
    out
}

fn scalar(db: &judou_lib::db::Db, sql: &str, article_id: i64) -> i64 {
    db.read(|conn| {
        conn.query_row(sql, [article_id], |row| row.get::<_, i64>(0))
            .map_err(|err| judou_lib::commands::CommandError {
                code: "db".into(),
                message: err.to_string(),
                path: None,
            })
    })
    .unwrap_or(-1)
}

fn count_sentences(db: &judou_lib::db::Db, id: i64) -> i64 {
    scalar(db, "SELECT COUNT(*) FROM sentence WHERE article_id = ?1", id)
}
fn count_paragraphs(db: &judou_lib::db::Db, id: i64) -> i64 {
    scalar(db, "SELECT COUNT(*) FROM paragraph WHERE article_id = ?1", id)
}
fn count_tokens(db: &judou_lib::db::Db, id: i64) -> i64 {
    scalar(
        db,
        "SELECT COUNT(*) FROM token t JOIN sentence s ON s.id = t.sentence_id WHERE s.article_id = ?1",
        id,
    )
}
fn count_words(db: &judou_lib::db::Db, id: i64) -> i64 {
    scalar(
        db,
        "SELECT COUNT(*) FROM token t JOIN sentence s ON s.id = t.sentence_id
         WHERE s.article_id = ?1 AND t.is_word = 1",
        id,
    )
}

fn first_exam_type(db: &judou_lib::db::Db, id: i64) -> String {
    db.read(|conn| {
        conn.query_row("SELECT exam_type FROM article WHERE id = ?1", [id], |row| row.get::<_, String>(0))
            .map_err(|err| judou_lib::commands::CommandError {
                code: "db".into(),
                message: err.to_string(),
                path: None,
            })
    })
    .unwrap_or_default()
}

fn first_exam_year(db: &judou_lib::db::Db, id: i64) -> i64 {
    db.read(|conn| {
        conn.query_row("SELECT exam_year FROM article WHERE id = ?1", [id], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(|err| judou_lib::commands::CommandError {
            code: "db".into(),
            message: err.to_string(),
            path: None,
        })
    })
    .unwrap_or(None)
    .unwrap_or(-1)
}

/// 回读：库里每句按 `start_offset/end_offset` 切段文本是否对得上；每个 token 同理
fn readback_mismatches(db: &judou_lib::db::Db, article_id: i64) -> Vec<String> {
    db.read(|conn| {
        let mut out = Vec::new();
        let mut stmt = conn
            .prepare("SELECT id, idx, text, start_offset, end_offset FROM sentence WHERE article_id = ?1 ORDER BY idx")
            .map_err(|err| judou_lib::commands::CommandError {
                code: "db".into(),
                message: err.to_string(),
                path: None,
            })?;
        let rows: Vec<(i64, i64, String, i64, i64)> = stmt
            .query_map([article_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .map_err(|err| judou_lib::commands::CommandError {
                code: "db".into(),
                message: err.to_string(),
                path: None,
            })?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);

        for (sentence_id, idx, text, start, end) in rows {
            let para_text: String = conn
                .query_row(
                    "SELECT p.text FROM paragraph p JOIN sentence s ON s.paragraph_id = p.id WHERE s.id = ?1",
                    [sentence_id],
                    |row| row.get(0),
                )
                .unwrap_or_default();
            let units: Vec<u16> = para_text.encode_utf16().collect();
            let slice = if start >= 0 && end >= start && (end as usize) <= units.len() {
                String::from_utf16_lossy(&units[start as usize..end as usize]).to_string()
            } else {
                String::new()
            };
            if slice != text {
                out.push(format!("sentence#{idx} 切片不符"));
            }
            let mut stmt_tok = conn
                .prepare("SELECT surface, start_offset, end_offset FROM token WHERE sentence_id = ?1 ORDER BY idx")
                .map_err(|err| judou_lib::commands::CommandError {
                    code: "db".into(),
                    message: err.to_string(),
                    path: None,
                })?;
            let toks: Vec<(String, i64, i64)> = stmt_tok
                .query_map([sentence_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|err| judou_lib::commands::CommandError {
                    code: "db".into(),
                    message: err.to_string(),
                    path: None,
                })?
                .filter_map(Result::ok)
                .collect();
            let sent_units: Vec<u16> = text.encode_utf16().collect();
            for (surface, ts, te) in toks {
                let s = if ts >= 0 && te >= ts && (te as usize) <= sent_units.len() {
                    String::from_utf16_lossy(&sent_units[ts as usize..te as usize]).to_string()
                } else {
                    String::new()
                };
                if s != surface {
                    out.push(format!("sentence#{idx} token「{surface}」切片不符"));
                }
            }
        }
        Ok(out)
    })
    .unwrap_or_else(|_| vec!["回读失败".to_string()])
}

fn is_user_key(key: &str) -> bool {
    key.starts_with("user-") && key.len() > 10 && key[5..].chars().all(|c| c.is_ascii_hexdigit())
}