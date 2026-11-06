#!/usr/bin/env node
/**
 * AC8 断言（笔记持久化的 **schema 侧**）：在临时库上复现「upsert → 读回 → 三栏清空删行 → updated_at 刷新」。
 *
 * 为什么另开一个门禁（与 `analysis.rs` 的 4 条单测互补）：
 * - Rust 单测验**实现**（命令、事务、错误映射）；
 * - 本脚本验 **001_init.sql 的 schema 事实**：`sentence_note.updated_at` / `word_note.updated_at`
 *   是 `NOT NULL` **且无 DEFAULT**（所以 INSERT 必须显式给值，漏了首跑必红——评审 N-6），
 *   以及 `UNIQUE(sentence_id)` / `UNIQUE(token_id)` 是 `ON CONFLICT` 的前提。
 *
 * **schema 单一来源**：直接 `readFileSync` 执行 `src-tauri/migrations/*.sql`（001 建表 + 002 三列，
 * 与 `db.rs` 的 `MIGRATIONS` 同序）建库，**不手抄两张表的 DDL**（手抄会与迁移漂移，评审 N-7）。
 * 只跑 001 会缺 `token.is_word`（002 才加），所以两条都必须执行。
 *
 * 用法：node scripts/verify-note.mjs
 * 退出码：0 通过 / 1 断言不成立
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = ["001_init.sql", "002_add_import_columns.sql"].map((name) =>
  path.join(root, "src-tauri", "migrations", name),
);

for (const file of MIGRATIONS) {
  if (!existsSync(file)) {
    console.error(`FAIL: 迁移文件不存在：${file}`);
    process.exit(1);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "judou-note-"));
const dbPath = path.join(dir, "judou-note.db");
const db = new DatabaseSync(dbPath);

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

try {
  // ── 建库：直接执行迁移文件（单一 schema 来源） ──
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(file, "utf8"));
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  console.log(`临时库: ${dbPath}`);
  console.log(`表数 ${tables.length}（期望 19：18 业务 + schema_meta）`);
  if (tables.length !== 19) fail(`001_init.sql 应建 19 张表，实测 ${tables.length}`);

  // ── schema 事实：updated_at NOT NULL 无 DEFAULT；UNIQUE 约束存在 ──
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all();
  for (const table of ["sentence_note", "word_note"]) {
    const updatedAt = columns(table).find((column) => column.name === "updated_at");
    if (!updatedAt) {
      fail(`${table} 缺 updated_at 列`);
      continue;
    }
    console.log(`${table}.updated_at: type=${updatedAt.type} notnull=${updatedAt.notnull} default=${updatedAt.dflt_value}`);
    if (updatedAt.notnull !== 1) fail(`${table}.updated_at 应为 NOT NULL`);
    if (updatedAt.dflt_value !== null) fail(`${table}.updated_at 不应有 DEFAULT（INSERT 必须显式给值）`);
  }
  // UNIQUE(sentence_id) / UNIQUE(token_id) 是 ON CONFLICT 的前提。
  // 注意：SQLite 把表级 UNIQUE 实现为 sqlite_autoindex（sqlite_master.sql 为 NULL），
  // 所以只能用 PRAGMA index_list/index_info 查，不能靠匹配建表 SQL 文本。
  const uniqueOn = (table, column) => {
    for (const index of db.prepare(`PRAGMA index_list(${table})`).all()) {
      if (!index.unique) continue;
      const columns = db
        .prepare(`PRAGMA index_info(${index.name})`)
        .all()
        .map((info) => info.name);
      if (columns.length === 1 && columns[0] === column) return index.name;
    }
    return null;
  };
  const sentenceUnique = uniqueOn("sentence_note", "sentence_id");
  const wordUnique = uniqueOn("word_note", "token_id");
  console.log(`sentence_note UNIQUE(sentence_id) = ${sentenceUnique ?? "缺失"}`);
  console.log(`word_note UNIQUE(token_id) = ${wordUnique ?? "缺失"}`);
  if (!sentenceUnique) fail("sentence_note 缺 UNIQUE(sentence_id)（ON CONFLICT 前提）");
  if (!wordUnique) fail("word_note 缺 UNIQUE(token_id)（ON CONFLICT 前提）");

  // ── 种子：1 article / 1 paragraph / 1 sentence / 1 token ──
  db.prepare("INSERT INTO article (source_key, title, exam_type, visibility) VALUES ('t-1', '测试篇', 'cet4', 'system')").run();
  const articleId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
  db.prepare("INSERT INTO paragraph (article_id, idx, text) VALUES (?, 0, 'He runs.')").run(articleId);
  const paragraphId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
  db.prepare(
    "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset) VALUES (?, ?, 0, 'He runs.', 'hash', 0, 8)",
  ).run(articleId, paragraphId);
  const sentenceId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
  db.prepare(
    "INSERT INTO token (sentence_id, idx, surface, normalized, start_offset, end_offset, is_word) VALUES (?, 0, 'runs', 'run', 3, 7, 1)",
  ).run(sentenceId);
  const tokenId = db.prepare("SELECT last_insert_rowid() AS id").get().id;

  // ── 与 analysis.rs 同口径的 upsert（INSERT 分支显式给 updated_at） ──
  const UPSERT_SENTENCE = `INSERT INTO sentence_note (sentence_id, translation, grammar_note, phrase_note, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sentence_id) DO UPDATE SET
      translation = excluded.translation,
      grammar_note = excluded.grammar_note,
      phrase_note = excluded.phrase_note,
      updated_at = datetime('now')`;
  const UPSERT_WORD = `INSERT INTO word_note (token_id, context_meaning, collocation, example, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(token_id) DO UPDATE SET
      context_meaning = excluded.context_meaning,
      collocation = excluded.collocation,
      example = excluded.example,
      updated_at = datetime('now')`;
  const TRIM = (value) => {
    const text = (value ?? "").trim();
    return text === "" ? null : text;
  };
  const readSentenceNote = (id) => db.prepare("SELECT * FROM sentence_note WHERE sentence_id = ?").get(id);
  const readWordNote = (id) => db.prepare("SELECT * FROM word_note WHERE token_id = ?").get(id);

  /** 与 Rust `upsert_sentence_note` 同语义：三栏 TRIM 后全空 → DELETE；否则 upsert */
  const upsertSentence = (id, [translation, grammarNote, phraseNote]) => {
    const values = [TRIM(translation), TRIM(grammarNote), TRIM(phraseNote)];
    if (values.every((value) => value === null)) {
      db.prepare("DELETE FROM sentence_note WHERE sentence_id = ?").run(id);
      return { deleted: true };
    }
    db.prepare(UPSERT_SENTENCE).run(id, ...values);
    return { deleted: false };
  };
  const upsertWord = (id, [contextMeaning, collocation, example]) => {
    const values = [TRIM(contextMeaning), TRIM(collocation), TRIM(example)];
    if (values.every((value) => value === null)) {
      db.prepare("DELETE FROM word_note WHERE token_id = ?").run(id);
      return { deleted: true };
    }
    db.prepare(UPSERT_WORD).run(id, ...values);
    return { deleted: false };
  };

  // ── 句子笔记：空 → 写 → 读回 → 刷新 → 清空删行 ──
  if (readSentenceNote(sentenceId)) fail("初始不应有句子笔记");
  const created = upsertSentence(sentenceId, ["译文", "语法点", "短语"]);
  if (created.deleted) fail("非空写入不应判为删除");
  const first = readSentenceNote(sentenceId);
  console.log(`句子笔记读回: translation=${first?.translation} grammar=${first?.grammar_note} phrase=${first?.phrase_note} updated_at=${first?.updated_at}`);
  if (first?.translation !== "译文") fail("translation 未落库");
  if (first?.grammar_note !== "语法点") fail("grammar_note 未落库");
  if (first?.phrase_note !== "短语") fail("phrase_note 未落库");
  if (!first?.updated_at) fail("updated_at 应非空");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  upsertSentence(sentenceId, ["译文2", null, "  "]);
  const second = readSentenceNote(sentenceId);
  console.log(`二次写入 updated_at: ${first?.updated_at} → ${second?.updated_at}`);
  if (second?.translation !== "译文2") fail("二次写入未更新 translation");
  if (second?.grammar_note !== null) fail("空栏应落 NULL");
  if (second?.phrase_note !== null) fail("纯空白串应落 NULL");
  if (second?.updated_at === first?.updated_at) fail("updated_at 应刷新（UPDATE 分支漏写会与旧值相同）");

  const cleared = upsertSentence(sentenceId, ["  ", "", null]);
  if (!cleared.deleted) fail("三栏全空应判为删除");
  if (readSentenceNote(sentenceId)) fail("三栏全空后行应被删除");

  // ── 词笔记：同构 ──
  if (readWordNote(tokenId)) fail("初始不应有词笔记");
  upsertWord(tokenId, ["语境义", "搭配", "例句"]);
  const wordFirst = readWordNote(tokenId);
  console.log(`词笔记读回: context=${wordFirst?.context_meaning} collocation=${wordFirst?.collocation} example=${wordFirst?.example}`);
  if (wordFirst?.context_meaning !== "语境义") fail("context_meaning 未落库");
  if (!wordFirst?.updated_at) fail("word_note.updated_at 应非空");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  upsertWord(tokenId, ["语境义2", null, null]);
  const wordSecond = readWordNote(tokenId);
  console.log(`词笔记二次 updated_at: ${wordFirst?.updated_at} → ${wordSecond?.updated_at}`);
  if (wordSecond?.updated_at === wordFirst?.updated_at) fail("word_note.updated_at 应刷新");

  const wordCleared = upsertWord(tokenId, [null, "", "   "]);
  if (!wordCleared.deleted) fail("词笔记三栏全空应判为删除");
  if (readWordNote(tokenId)) fail("词笔记三栏全空后行应被删除");

  // ── 红线：临时库里只写了这两张笔记表 ──
  const counts = Object.fromEntries(
    ["sentence_note", "word_note", "sentence_analysis", "token_analysis", "lexicon", "blank", "vocab_entry"].map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c,
    ]),
  );
  console.log(`行数快照: ${JSON.stringify(counts)}`);
  for (const table of ["sentence_analysis", "token_analysis", "lexicon", "blank", "vocab_entry"]) {
    if (counts[table] !== 0) fail(`${table} 不应被本门禁写入（实测 ${counts[table]} 行）`);
  }
  if (counts.sentence_note !== 0 || counts.word_note !== 0) fail("清空后两张笔记表都应为 0 行");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error("FAIL: 笔记 schema 侧断言未通过");
  process.exit(1);
}
console.log(
  "PASS: 001_init.sql 建 19 表 / updated_at NOT NULL 且无 DEFAULT / UNIQUE 约束在位 / upsert 读回 / updated_at 刷新 / 三栏清空删行 / 两笔记表以外零写",
);
