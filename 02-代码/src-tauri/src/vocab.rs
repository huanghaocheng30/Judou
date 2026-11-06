//! M3 · 生词本查询/写入层（第 1 批 D0）——只碰三张用户表：`vocab_entry` / `tag` / `vocab_tag`。
//!
//! 分工（02 D0 / D1）：本文件是**实现**；`commands.rs` 只做薄包装（`#[tauri::command]` 在那里），
//! 注册点只在 `lib.rs` 的 `generate_handler!`。
//!
//! ## 红线（02 AC9 / 01 §五）
//! - 只写 `vocab_entry` / `tag` / `vocab_tag`；
//! - 对解析四表（`sentence_analysis` / `token_analysis` / `lexicon` / `blank`）、
//!   内容四表（`article` / `paragraph` / `sentence` / `token`）、`review_plan` / `review_log`（归 M4）、
//!   `reading_record`（归 M6）**只有 SELECT**；
//! - `001_init.sql` 零改动（三张表 M0 已建好，不需要 003 迁移）；
//! - `review_count` / `last_reviewed_at` 是 M4 的两列，本文件任何路径都不写它们。
//!
//! 级联（`ON DELETE SET NULL` / `ON DELETE CASCADE`）由 `scripts/verify-vocab.mjs` 的临时库证明——
//! **本文件（含测试）不写内容表**，因为 AC9 的 grep 范围含测试代码（评审 N-2 只给 `scripts/` 开口子）。
//!
//! ponytail: 不建 Repository/DAO 抽象——8 个命令对 3 张表，写 SQL 最短；等出现第二个数据源再抽。
//! 生词量级「百~千」，`list_vocab` 一次全量返回（含标签）绰绰有余；上万时再把 filter 下推成 SQL
//! （命令签名不变，见 `list_vocab` 里的 ponytail 注释）。

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::commands::CommandError;
use crate::db::Db;

/// `mastery` 三档（DB `CHECK (mastery IN ('new','fuzzy','known'))`，02 §三.0）
const MASTERY_VALUES: [&str; 3] = ["new", "fuzzy", "known"];

// ───────────────────────────── 返回体（camelCase 边界，02 §三.0） ─────────────────────────────

/// 生词条目：`vocab_entry` 全列 + 来源文章标题 + 标签名。
///
/// `tagNames` / `articleTitle` 是 D0 明确要求的「平铺行带标签」，也是 D3 渲染「标签 chips +
/// 来源文章标题」的唯一数据源（第二处查询就为了避开 N+1）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabEntry {
    pub id: i64,
    pub normalized: String,
    pub surface: String,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub context_meaning: Option<String>,
    pub source_sentence_id: Option<i64>,
    pub source_article_id: Option<i64>,
    pub mastery: String,
    /// M4 写、M3 只读
    pub review_count: i64,
    /// M4 写、M3 只读
    pub last_reviewed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 该词的标签名（升序；与条目**同批**取出，不逐条查）
    pub tag_names: Vec<String>,
    /// 来源文章标题（`source_article_id` 被 `SET NULL` 后自然为 `None`）
    pub article_title: Option<String>,
}

/// `list_vocab` 返回体：包一层而不是裸数组——将来加分页/统计字段时不必改命令契约。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabList {
    pub entries: Vec<VocabEntry>,
}

/// 标签（`tag` 全列）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

/// `add_vocab_from_token` 返回体：`created = false` 表示该词已在生词本（按钮文案「已在生词本」用）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabAddResult {
    pub entry: VocabEntry,
    pub created: bool,
}

/// `update_vocab` 的补丁：**只这四个字段**（02 裁定 1：表里没有搭配/例句列，也不许加列）。
///
/// 双层 `Option` 表达三态：字段缺省 = 不改（`None`）；显式 `null` = 清空（`Some(None)`）；
/// 有值 = 改成该值（`Some(Some(v))`）。`mastery` 只有两态——列 NOT NULL + CHECK，清空不合法。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabPatch {
    #[serde(default)]
    pub context_meaning: Option<Option<String>>,
    #[serde(default)]
    pub phonetic: Option<Option<String>>,
    #[serde(default)]
    pub pos: Option<Option<String>>,
    #[serde(default)]
    pub mastery: Option<String>,
}

/// `list_vocab` 的筛选参数：**本包只做形状占位，不下推 SQL**。
///
/// 分组与筛选的唯一真源是纯函数层 `src/lib/vocab.ts`（AC3 断言在 `verify-vocab.mjs` F 段）；
/// 若这里再实现一遍，两处规则必然漂移——见 `list_vocab` 里的 ponytail 注释。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
// 三个字段本包只「接收不消费」（筛选真源在纯函数层）——保留字段是为了契约稳定，
// 所以按「已知未读」显式放行，而不是删字段让前端与 Rust 两边形状漂移。
#[allow(dead_code)]
pub struct VocabFilter {
    pub mastery: Option<String>,
    #[serde(default)]
    pub tag_names: Vec<String>,
    pub keyword: Option<String>,
}

// ───────────────────────────── 共用半成品 ─────────────────────────────

/// 条目列清单：**三处读取共用一份文本**（列表 / 按 id / 按 normalized），改列只改这里。
///
/// `LEFT JOIN article` 只为取来源标题；来源被删后 `v.source_article_id` 已是 NULL，标题自然为 NULL。
const ENTRY_SELECT: &str = "SELECT v.id, v.normalized, v.surface, v.phonetic, v.pos, v.context_meaning,
              v.source_sentence_id, v.source_article_id, v.mastery, v.review_count,
              v.last_reviewed_at, v.created_at, v.updated_at, a.title
         FROM vocab_entry v
         LEFT JOIN article a ON a.id = v.source_article_id";

/// 行 → `VocabEntry`（`tag_names` 留空，由调用方按 id 批量补；`article_title` 是第 14 列）
fn map_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<VocabEntry> {
    Ok(VocabEntry {
        id: row.get(0)?,
        normalized: row.get(1)?,
        surface: row.get(2)?,
        phonetic: row.get(3)?,
        pos: row.get(4)?,
        context_meaning: row.get(5)?,
        source_sentence_id: row.get(6)?,
        source_article_id: row.get(7)?,
        mastery: row.get(8)?,
        review_count: row.get(9)?,
        last_reviewed_at: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        tag_names: Vec::new(),
        article_title: row.get(13)?,
    })
}

/// 单个词的标签名（升序）。仅用于「单条回读」——列表走 [`tags_by_vocab`] 批量取。
fn tags_of(conn: &Connection, vocab_id: i64) -> Result<Vec<String>, CommandError> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name
               FROM vocab_tag vt
               JOIN tag t ON t.id = vt.tag_id
              WHERE vt.vocab_id = ?1
           ORDER BY t.name",
        )
        .map_err(|err| CommandError::db("准备查询生词标签", err))?;
    let rows = stmt
        .query_map([vocab_id], |row| row.get::<_, String>(0))
        .map_err(|err| CommandError::db("查询生词标签", err))?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|err| CommandError::db("读取生词标签", err))
}

/// 全表标签归并：**一次查询**拿全部（vocab_id, name）对，再按 id 归拢（列表页不做 N+1 的关键）。
fn tags_by_vocab(conn: &Connection) -> Result<HashMap<i64, Vec<String>>, CommandError> {
    let mut stmt = conn
        .prepare(
            "SELECT vt.vocab_id, t.name
               FROM vocab_tag vt
               JOIN tag t ON t.id = vt.tag_id
           ORDER BY vt.vocab_id, t.name",
        )
        .map_err(|err| CommandError::db("准备查询标签索引", err))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|err| CommandError::db("查询标签索引", err))?;
    let mut map: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        let (vocab_id, name) = row.map_err(|err| CommandError::db("读取标签索引", err))?;
        map.entry(vocab_id).or_default().push(name);
    }
    Ok(map)
}

/// 按 id 回读单条（含标签）；不存在 → `None`
fn entry_by_id(conn: &Connection, id: i64) -> Result<Option<VocabEntry>, CommandError> {
    let entry = conn
        .query_row(&format!("{ENTRY_SELECT} WHERE v.id = ?1"), [id], map_entry)
        .optional()
        .map_err(|err| CommandError::db("查询生词条目", err))?;
    match entry {
        Some(mut entry) => {
            entry.tag_names = tags_of(conn, entry.id)?;
            Ok(Some(entry))
        }
        None => Ok(None),
    }
}

/// 补丁文本值 → SQL 值：`None`（显式 null）与纯空白都落成 NULL（与笔记「空串即清空」同口径）
fn patch_text(raw: Option<String>) -> Value {
    match raw
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
    {
        Some(text) => Value::Text(text),
        None => Value::Null,
    }
}

/// 标签名归一：trim → 去空 → 去重（保序）。**与 `src/lib/vocab.ts` 的 `normalizeTagNames` 同口径**
/// （两处都各自被断言覆盖，口径漂移由测试抓）。
fn normalize_tag_names(raw: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for item in raw {
        let name = item.trim();
        if name.is_empty() || names.iter().any(|existing| existing == name) {
            continue;
        }
        names.push(name.to_string());
    }
    names
}

// ───────────────────────────── ① list_vocab ─────────────────────────────

/// 生词列表：**一次**查条目（含来源标题）+ **一次**查标签索引 → 平铺行，分组在纯函数层做。
pub fn list_vocab(
    db: &Db,
    group_by: Option<String>,
    filter: Option<VocabFilter>,
) -> Result<VocabList, CommandError> {
    // ponytail: 契约签名保留 groupBy/filter（AC1 与 D0 一致），但本包**不做服务端分组/筛选**——
    // 分组（三轴）与筛选（mastery/标签 AND/关键词）的唯一真源是 `src/lib/vocab.ts`
    // （AC3 的断言在 verify-vocab.mjs F 段）。这里再做一遍只会让两处规则漂移。
    // 天花板：单用户生词上万时把 filter 下推成 SQL 并删掉前端筛选——命令签名不变。
    let _ = (&group_by, &filter);

    db.read(|conn| {
        let entries = {
            let mut stmt = conn
                .prepare(&format!("{ENTRY_SELECT} ORDER BY v.updated_at DESC, v.id DESC"))
                .map_err(|err| CommandError::db("准备查询生词列表", err))?;
            let rows = stmt
                .query_map([], map_entry)
                .map_err(|err| CommandError::db("查询生词列表", err))?;
            rows.collect::<rusqlite::Result<Vec<VocabEntry>>>()
                .map_err(|err| CommandError::db("读取生词列表", err))?
        };

        let mut tag_index = tags_by_vocab(conn)?;
        let entries = entries
            .into_iter()
            .map(|mut entry| {
                entry.tag_names = tag_index.remove(&entry.id).unwrap_or_default();
                entry
            })
            .collect();

        Ok(VocabList { entries })
    })
}

// ───────────────────────────── ② add_vocab_from_token ─────────────────────────────

/// 从词节点收藏：`token` 取 `normalized`/`surface`/来源、`token_analysis` 取语境义快照 →
/// `INSERT ... ON CONFLICT(normalized) DO NOTHING` → 回读 → `{entry, created}`。
///
/// **重复收藏不改任何列**（保留首次来源与首次语境义，02 AC2 / 决策 #3 #4）：
/// `DO NOTHING` 之后回读的是**首次那条**，所以 `surface`/`source_*`/`context_meaning` 天然不变。
///
/// 实现补充（已在执行自测声明）：顺带把 `phonetic`/`pos` 也从 `token_analysis` 快照——
/// 同一行同一 INSERT、不新增列，D3 的「音标 + 词性」否则永远为空；若审查要求严格只取语境义，
/// 删掉这列的两个参数即可（`INSERT` 列清单同步少两列）。
pub fn add_vocab_from_token(db: &Db, token_id: i64) -> Result<VocabAddResult, CommandError> {
    /// 收藏瞬间要落到生词表里的快照（一次查询取全，不 N+1）
    struct Snapshot {
        normalized: String,
        surface: String,
        phonetic: Option<String>,
        pos: Option<String>,
        sense_in_context: Option<String>,
        sentence_id: i64,
        article_id: i64,
    }

    db.write(move |tx| {
        let snapshot = tx
            .query_row(
                "SELECT t.normalized, t.surface, ta.phonetic, ta.pos, ta.sense_in_context,
                        t.sentence_id, s.article_id
                   FROM token t
                   JOIN sentence s ON s.id = t.sentence_id
                   LEFT JOIN token_analysis ta ON ta.token_id = t.id
                  WHERE t.id = ?1",
                [token_id],
                |row| {
                    Ok(Snapshot {
                        normalized: row.get(0)?,
                        surface: row.get(1)?,
                        phonetic: row.get(2)?,
                        pos: row.get(3)?,
                        sense_in_context: row.get(4)?,
                        sentence_id: row.get(5)?,
                        article_id: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|err| CommandError::db("查询待收藏的词", err))?;
        let Some(snapshot) = snapshot else {
            return Err(CommandError::token_not_found(token_id));
        };

        let inserted = tx
            .execute(
                "INSERT INTO vocab_entry
                     (normalized, surface, phonetic, pos, context_meaning, source_sentence_id, source_article_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(normalized) DO NOTHING",
                params![
                    snapshot.normalized,
                    snapshot.surface,
                    snapshot.phonetic,
                    snapshot.pos,
                    snapshot.sense_in_context,
                    snapshot.sentence_id,
                    snapshot.article_id,
                ],
            )
            .map_err(|err| CommandError::db("加入生词本", err))?;

        let entry = tx
            .query_row(
                &format!("{ENTRY_SELECT} WHERE v.normalized = ?1"),
                [&snapshot.normalized],
                map_entry,
            )
            .optional()
            .map_err(|err| CommandError::db("回读生词条目", err))?
            .ok_or_else(|| CommandError::db_invariant("回读生词条目"))?;
        let mut entry = entry;
        entry.tag_names = tags_of(tx, entry.id)?;

        Ok(VocabAddResult {
            entry,
            created: inserted == 1,
        })
    })
}

// ───────────────────────────── ③ update_vocab ─────────────────────────────

/// 编辑生词：**只允许** `context_meaning` / `phonetic` / `pos` / `mastery` 四列 + `updated_at`。
///
/// `review_count` / `last_reviewed_at` 是 M4 的列，本函数连「不动」都要靠「不在 SET 里」保证——
/// 硬编码列名白名单就是这个作用（用户传什么键都进不来）。
pub fn update_vocab(db: &Db, vocab_id: i64, patch: VocabPatch) -> Result<VocabEntry, CommandError> {
    // 只拼列名常量与 `?` 占位符，用户数据一律走绑定参数（无注入面）
    let mut sets: Vec<&'static str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if let Some(raw) = patch.context_meaning {
        sets.push("context_meaning = ?");
        values.push(patch_text(raw));
    }
    if let Some(raw) = patch.phonetic {
        sets.push("phonetic = ?");
        values.push(patch_text(raw));
    }
    if let Some(raw) = patch.pos {
        sets.push("pos = ?");
        values.push(patch_text(raw));
    }
    if let Some(mastery) = patch.mastery {
        let mastery = mastery.trim().to_string();
        if !MASTERY_VALUES.contains(&mastery.as_str()) {
            return Err(CommandError::invalid_mastery(&mastery));
        }
        sets.push("mastery = ?");
        values.push(Value::Text(mastery));
    }
    if sets.is_empty() {
        return Err(CommandError::invalid_vocab_patch());
    }
    sets.push("updated_at = datetime('now')");

    let sql = format!("UPDATE vocab_entry SET {} WHERE id = ?", sets.join(", "));
    values.push(Value::Integer(vocab_id));

    db.write(move |tx| {
        let affected = tx
            .execute(&sql, params_from_iter(values.iter()))
            .map_err(|err| CommandError::db("更新生词条目", err))?;
        if affected == 0 {
            return Err(CommandError::vocab_not_found(vocab_id));
        }
        entry_by_id(tx, vocab_id)?.ok_or_else(|| CommandError::vocab_not_found(vocab_id))
    })
}

// ───────────────────────────── ④ delete_vocab ─────────────────────────────

/// 删生词：`vocab_tag` 靠外键 `ON DELETE CASCADE` 连带清（不手写第二条 DELETE，少一处漏删）。
/// 返回是否真的删掉了（`false` = 本来就没有）。
pub fn delete_vocab(db: &Db, vocab_id: i64) -> Result<bool, CommandError> {
    db.write(move |tx| {
        let affected = tx
            .execute("DELETE FROM vocab_entry WHERE id = ?1", [vocab_id])
            .map_err(|err| CommandError::db("删除生词", err))?;
        Ok(affected == 1)
    })
}

// ───────────────────────────── ⑤ get_vocab_by_normalized ─────────────────────────────

/// 按 `normalized` 查词（词卡判断「已在生词本」用）。空串/纯空白 → `None`（不打库）。
pub fn get_vocab_by_normalized(
    db: &Db,
    normalized: &str,
) -> Result<Option<VocabEntry>, CommandError> {
    let key = normalized.trim();
    if key.is_empty() {
        return Ok(None);
    }
    db.read(|conn| {
        let entry = conn
            .query_row(&format!("{ENTRY_SELECT} WHERE v.normalized = ?1"), [key], map_entry)
            .optional()
            .map_err(|err| CommandError::db("查询生词条目", err))?;
        match entry {
            Some(mut entry) => {
                entry.tag_names = tags_of(conn, entry.id)?;
                Ok(Some(entry))
            }
            None => Ok(None),
        }
    })
}

// ───────────────────────────── ⑥ list_tags ─────────────────────────────

/// 全部标签（按名升序）：D3 的标签筛选 chips 与第 2 批的标签编辑候选都用它。
pub fn list_tags(db: &Db) -> Result<Vec<Tag>, CommandError> {
    db.read(|conn| {
        let mut stmt = conn
            .prepare("SELECT id, name, color FROM tag ORDER BY name")
            .map_err(|err| CommandError::db("准备查询标签", err))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })
            .map_err(|err| CommandError::db("查询标签", err))?;
        rows.collect::<rusqlite::Result<Vec<Tag>>>()
            .map_err(|err| CommandError::db("读取标签", err))
    })
}

// ───────────────────────────── ⑦ set_vocab_tags ─────────────────────────────

/// 设置某词的标签：事务内「按名 upsert tag → 删该词旧关联 → 插新关联」= **全量替换**。
///
/// 语义（02 AC4 / 决策 #6）：「传进来的名单就是最终名单」——不传的标签即被解除关联；
/// 标签行本身不删（删标签是独立的 `delete_tag` 命令，可能还被别的词用着）。
pub fn set_vocab_tags(
    db: &Db,
    vocab_id: i64,
    tag_names: Vec<String>,
) -> Result<Vec<Tag>, CommandError> {
    let names = normalize_tag_names(tag_names);

    db.write(move |tx| {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM vocab_entry WHERE id = ?1)",
                [vocab_id],
                |row| row.get(0),
            )
            .map_err(|err| CommandError::db("确认生词条目", err))?;
        if !exists {
            return Err(CommandError::vocab_not_found(vocab_id));
        }

        tx.execute("DELETE FROM vocab_tag WHERE vocab_id = ?1", [vocab_id])
            .map_err(|err| CommandError::db("清除旧标签关联", err))?;

        for name in &names {
            tx.execute(
                "INSERT INTO tag (name) VALUES (?1) ON CONFLICT(name) DO NOTHING",
                [name],
            )
            .map_err(|err| CommandError::db("登记标签", err))?;
            let tag_id: i64 = tx
                .query_row("SELECT id FROM tag WHERE name = ?1", [name], |row| row.get(0))
                .map_err(|err| CommandError::db("查询标签编号", err))?;
            // 归一化已去重，PK (vocab_id, tag_id) 不会撞；ON CONFLICT 只是兜底
            tx.execute(
                "INSERT INTO vocab_tag (vocab_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                params![vocab_id, tag_id],
            )
            .map_err(|err| CommandError::db("建立标签关联", err))?;
        }

        let mut stmt = tx
            .prepare(
                "SELECT t.id, t.name, t.color
                   FROM vocab_tag vt
                   JOIN tag t ON t.id = vt.tag_id
                  WHERE vt.vocab_id = ?1
               ORDER BY t.name",
            )
            .map_err(|err| CommandError::db("准备回读生词标签", err))?;
        let rows = stmt
            .query_map([vocab_id], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })
            .map_err(|err| CommandError::db("回读生词标签", err))?;
        rows.collect::<rusqlite::Result<Vec<Tag>>>()
            .map_err(|err| CommandError::db("读取回读生词标签", err))
    })
}

// ───────────────────────────── ⑧ delete_tag ─────────────────────────────

/// 删标签：`vocab_tag` 靠外键 `ON DELETE CASCADE` 连带清，**生词条目一律保留**（AC6）。
pub fn delete_tag(db: &Db, tag_id: i64) -> Result<bool, CommandError> {
    db.write(move |tx| {
        let affected = tx
            .execute("DELETE FROM tag WHERE id = ?1", [tag_id])
            .map_err(|err| CommandError::db("删除标签", err))?;
        Ok(affected == 1)
    })
}

// ───────────────────────────── 测试 ─────────────────────────────

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
        let dir = std::env::temp_dir().join(format!("judou-vocab-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let db = Db::open(dir.join("judou.db")).expect("建库失败");
        (db, dir)
    }

    /// 一篇文章 + 一句 + 一个词；`sense` 为 `Some` 时补一条 `token_analysis`（收藏快照的来源）
    fn seed_article(db: &Db, key: &str, title: &str, surface: &str, normalized: &str, sense: Option<&str>) -> i64 {
        db.write(move |tx| {
            tx.execute(
                "INSERT INTO article (source_key, title, exam_type, visibility) VALUES (?1, ?2, 'cet4', 'system')",
                params![key, title],
            )
            .map_err(|err| CommandError::db("插 article", err))?;
            let article_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO paragraph (article_id, idx, text) VALUES (?1, 0, 'It provokes anger.')",
                [article_id],
            )
            .map_err(|err| CommandError::db("插 paragraph", err))?;
            let paragraph_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset)
                 VALUES (?1, ?2, 0, 'It provokes anger.', 'hash', 0, 17)",
                params![article_id, paragraph_id],
            )
            .map_err(|err| CommandError::db("插 sentence", err))?;
            let sentence_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO token (sentence_id, idx, surface, normalized, start_offset, end_offset, is_word)
                 VALUES (?1, 0, ?2, ?3, 3, 11, 1)",
                params![sentence_id, surface, normalized],
            )
            .map_err(|err| CommandError::db("插 token", err))?;
            let token_id = tx.last_insert_rowid();
            if let Some(sense) = sense {
                tx.execute(
                    "INSERT INTO token_analysis (token_id, phonetic, pos, sense_in_context)
                     VALUES (?1, '/prəˈvəʊk/', 'v.', ?2)",
                    params![token_id, sense],
                )
                .map_err(|err| CommandError::db("插 token_analysis", err))?;
            }
            Ok(token_id)
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
    fn add_from_token_snapshots_first_source_and_ignores_second() {
        let (db, dir) = temp_db("add");
        let token_a = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒；挑起"));
        let token_b = seed_article(&db, "b", "B 篇", "provoked", "provoke", Some("第二篇的语境义"));

        assert!(get_vocab_by_normalized(&db, "provoke").expect("查空").is_none());

        let first = add_vocab_from_token(&db, token_a).expect("首次收藏");
        assert!(first.created, "首次收藏应 created=true");
        assert_eq!(first.entry.normalized, "provoke");
        assert_eq!(first.entry.surface, "provokes", "surface 取首次加入形态");
        assert_eq!(first.entry.context_meaning.as_deref(), Some("激怒；挑起"));
        assert_eq!(first.entry.phonetic.as_deref(), Some("/prəˈvəʊk/"));
        assert_eq!(first.entry.pos.as_deref(), Some("v."));
        assert_eq!(first.entry.mastery, "new", "默认掌握状态 new");
        assert_eq!(first.entry.review_count, 0, "M4 两列保持初值");
        assert!(first.entry.last_reviewed_at.is_none());
        assert_eq!(first.entry.article_title.as_deref(), Some("A 篇"));
        assert!(first.entry.tag_names.is_empty(), "新收藏无标签");
        let (first_sentence, first_article) = (
            first.entry.source_sentence_id.expect("应有来源句"),
            first.entry.source_article_id.expect("应有来源文章"),
        );

        let second = add_vocab_from_token(&db, token_b).expect("二次收藏");
        assert!(!second.created, "已在生词本应 created=false");
        assert_eq!(count_rows(&db, "vocab_entry"), 1, "同词两篇只一条");
        assert_eq!(second.entry.surface, "provokes", "重复收藏不改 surface");
        assert_eq!(second.entry.source_sentence_id, Some(first_sentence), "不改来源句");
        assert_eq!(second.entry.source_article_id, Some(first_article), "不改来源文章");
        assert_eq!(
            second.entry.context_meaning.as_deref(),
            Some("激怒；挑起"),
            "不改首次语境义（不取第二篇的）"
        );

        let missing = add_vocab_from_token(&db, 9999);
        assert!(missing.is_err(), "不存在的词节点应报错");
        assert_eq!(missing.expect_err("应有错").code, "token_not_found");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn add_from_token_without_analysis_keeps_null_meaning() {
        let (db, dir) = temp_db("nul");
        let token = seed_article(&db, "a", "A 篇", "the", "the", None);

        let added = add_vocab_from_token(&db, token).expect("无解析词也能收藏");
        assert!(added.created);
        assert!(added.entry.context_meaning.is_none(), "无 token_analysis 时语境义为 NULL");
        assert!(added.entry.phonetic.is_none());
        assert!(added.entry.pos.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn update_vocab_touches_only_four_columns() {
        let (db, dir) = temp_db("upd");
        let token = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));
        let entry = add_vocab_from_token(&db, token).expect("收藏").entry;

        // M4 的列先摆上非默认值，用来证明 update_vocab 不碰它们
        db.write(|tx| {
            tx.execute(
                "UPDATE vocab_entry SET review_count = 7, last_reviewed_at = '2026-11-06 08:00:00' WHERE id = ?1",
                [entry.id],
            )
            .map_err(|err| CommandError::db("摆 M4 列", err))?;
            Ok(())
        })
        .expect("摆 M4 列失败");
        let stamp = entry.updated_at.clone();

        std::thread::sleep(std::time::Duration::from_millis(1100));
        let patched = update_vocab(
            &db,
            entry.id,
            VocabPatch {
                context_meaning: Some(Some("  激怒（改）  ".to_string())),
                phonetic: Some(Some("/prəˈvəʊk/".to_string())),
                pos: Some(Some("v.".to_string())),
                mastery: Some("fuzzy".to_string()),
            },
        )
        .expect("更新成功");
        assert_eq!(patched.context_meaning.as_deref(), Some("激怒（改）"), "应 trim 后落库");
        assert_eq!(patched.mastery, "fuzzy");
        assert_eq!(patched.review_count, 7, "review_count 不得被 M3 改动");
        assert_eq!(
            patched.last_reviewed_at.as_deref(),
            Some("2026-11-06 08:00:00"),
            "last_reviewed_at 不得被 M3 改动"
        );
        assert_ne!(patched.updated_at, stamp, "updated_at 应刷新");

        // 显式 null = 清空；纯空白也清空
        let cleared = update_vocab(
            &db,
            entry.id,
            VocabPatch {
                context_meaning: Some(None),
                phonetic: Some(Some("   ".to_string())),
                pos: None,
                mastery: None,
            },
        )
        .expect("清空成功");
        assert!(cleared.context_meaning.is_none(), "显式 null 应清空");
        assert!(cleared.phonetic.is_none(), "纯空白应落成 NULL");
        assert_eq!(cleared.pos.as_deref(), Some("v."), "未提供字段不得被清空");

        let bad = update_vocab(
            &db,
            entry.id,
            VocabPatch {
                mastery: Some("unknown".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(bad.expect_err("非法掌握状态应报错").code, "invalid_mastery");

        let empty = update_vocab(&db, entry.id, VocabPatch::default());
        assert_eq!(empty.expect_err("空补丁应报错").code, "invalid_vocab_patch");

        let ghost = update_vocab(
            &db,
            9999,
            VocabPatch {
                mastery: Some("known".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(ghost.expect_err("不存在的条目应报错").code, "vocab_not_found");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_vocab_tags_replaces_all_and_normalizes() {
        let (db, dir) = temp_db("tag");
        let token = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));
        let entry = add_vocab_from_token(&db, token).expect("收藏").entry;

        let tags = set_vocab_tags(
            &db,
            entry.id,
            vec![
                " 评估 ".to_string(),
                String::new(),
                "评估".to_string(),
                "雅思 ".to_string(),
            ],
        )
        .expect("全量设标签");
        let names: Vec<&str> = tags.iter().map(|tag| tag.name.as_str()).collect();
        // SQLite `ORDER BY name` 是 BINARY 排序（UTF-8 码点序）：「评估」U+8BC4 在「雅思」U+96C5 前
        assert_eq!(names, vec!["评估", "雅思"], "trim/去空/去重后按码点升序回读");

        let replaced = set_vocab_tags(&db, entry.id, vec!["雅思".to_string()]).expect("替换");
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].name, "雅思");
        assert_eq!(count_rows(&db, "vocab_tag"), 1, "旧关联应被解除");
        assert_eq!(count_rows(&db, "tag"), 2, "标签行本身不删（评估仍在）");
        assert_eq!(count_rows(&db, "vocab_entry"), 1, "改标签不动条目");

        let ghost = set_vocab_tags(&db, 9999, vec!["x".to_string()]);
        assert_eq!(ghost.expect_err("不存在的条目应报错").code, "vocab_not_found");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_tag_keeps_entries_and_clears_links() {
        let (db, dir) = temp_db("del");
        let token = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));
        let entry = add_vocab_from_token(&db, token).expect("收藏").entry;
        let tags = set_vocab_tags(&db, entry.id, vec!["评估".to_string()]).expect("设标签");

        assert!(delete_tag(&db, tags[0].id).expect("删标签"));
        assert_eq!(count_rows(&db, "vocab_entry"), 1, "删标签不得删词");
        assert_eq!(count_rows(&db, "vocab_tag"), 0, "关联连带清掉");
        assert!(list_tags(&db).expect("查标签").is_empty());
        assert!(!delete_tag(&db, 9999).expect("删不存在的标签"), "返回 false 而不是报错");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_vocab_cascades_links_only() {
        let (db, dir) = temp_db("delv");
        let token = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));
        let entry = add_vocab_from_token(&db, token).expect("收藏").entry;
        set_vocab_tags(&db, entry.id, vec!["评估".to_string()]).expect("设标签");

        assert!(delete_vocab(&db, entry.id).expect("删词"));
        assert_eq!(count_rows(&db, "vocab_entry"), 0);
        assert_eq!(count_rows(&db, "vocab_tag"), 0, "关联连带清掉");
        assert_eq!(count_rows(&db, "tag"), 1, "标签行保留");
        assert!(!delete_vocab(&db, entry.id).expect("重复删"), "第二次返回 false");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_vocab_returns_flat_rows_with_batched_tags() {
        let (db, dir) = temp_db("list");
        let token_a = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));
        let token_b = seed_article(&db, "b", "B 篇", "runs", "run", Some("跑"));
        let entry_a = add_vocab_from_token(&db, token_a).expect("收藏 A").entry;
        let entry_b = add_vocab_from_token(&db, token_b).expect("收藏 B").entry;
        set_vocab_tags(&db, entry_a.id, vec!["评估".to_string(), "雅思".to_string()]).expect("A 标签");
        set_vocab_tags(&db, entry_b.id, vec!["评估".to_string()]).expect("B 标签");

        let list = list_vocab(&db, Some("tag".to_string()), None).expect("列表");
        assert_eq!(list.entries.len(), 2);
        assert_eq!(
            list.entries[0].normalized, "run",
            "按 updated_at DESC、id DESC 排序，后收藏的在前"
        );
        assert_eq!(list.entries[0].tag_names, vec!["评估"], "标签不串味");
        assert_eq!(list.entries[1].tag_names, vec!["评估", "雅思"], "按码点升序");
        assert_eq!(list.entries[1].article_title.as_deref(), Some("A 篇"));

        // 无标签词也能出现在平铺行里（tagNames 空数组，而不是缺行）
        let token_c = seed_article(&db, "c", "C 篇", "the", "the", None);
        add_vocab_from_token(&db, token_c).expect("收藏 C");
        let list2 = list_vocab(&db, None, None).expect("列表2");
        assert_eq!(list2.entries.len(), 3);
        assert_eq!(list2.entries[0].tag_names, Vec::<String>::new());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_vocab_by_normalized_is_trimmed_and_safe() {
        let (db, dir) = temp_db("get");
        let token = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));
        add_vocab_from_token(&db, token).expect("收藏");

        assert!(get_vocab_by_normalized(&db, "provoke").expect("查").is_some());
        assert!(get_vocab_by_normalized(&db, "  provoke  ").expect("查 trim").is_some());
        assert!(get_vocab_by_normalized(&db, "missing").expect("查空").is_none());
        assert!(get_vocab_by_normalized(&db, "   ").expect("空白不打库").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// AC9 红线（Rust 侧）：整套生词写路径跑完，解析四表 / 内容四表 / M4-M6 表行数一格不动。
    ///
    /// 级联 `SET NULL` 要删文章，而本文件不许写内容表（门禁 grep 含测试代码）——
    /// 那条由 `scripts/verify-vocab.mjs` E-⑨ 证明。
    #[test]
    fn vocab_writes_never_touch_other_tables() {
        let (db, dir) = temp_db("red");
        let token = seed_article(&db, "a", "A 篇", "provokes", "provoke", Some("激怒"));

        const WATCHED: [&str; 10] = [
            "sentence_analysis",
            "token_analysis",
            "lexicon",
            "blank",
            "article",
            "paragraph",
            "sentence",
            "token",
            "review_plan",
            "review_log",
        ];
        let before: Vec<i64> = WATCHED.iter().map(|table| count_rows(&db, table)).collect();

        let entry = add_vocab_from_token(&db, token).expect("收藏").entry;
        update_vocab(
            &db,
            entry.id,
            VocabPatch {
                context_meaning: Some(Some("改".to_string())),
                ..Default::default()
            },
        )
        .expect("更新");
        let tags = set_vocab_tags(&db, entry.id, vec!["评估".to_string()]).expect("设标签");
        list_vocab(&db, None, None).expect("列表");
        delete_tag(&db, tags[0].id).expect("删标签");
        delete_vocab(&db, entry.id).expect("删词");

        let after: Vec<i64> = WATCHED.iter().map(|table| count_rows(&db, table)).collect();
        assert_eq!(before, after, "生词写路径不得改动解析/内容/M4-M6 表：{WATCHED:?}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
