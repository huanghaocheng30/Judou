#!/usr/bin/env node
/**
 * AC-R3 断言（TP-修复1 F4/F5）：「本篇笔记标记」的**命令契约 + SQL 语义**。
 *
 * 两段判据，缺一不可：
 * - **A 段（契约在位）**：`analysis.rs` 实现 / `commands.rs` 薄包装 / `lib.rs` `generate_handler!` 注册 /
 *   `types.ts` 的 `NoteMarks` / `api.ts` 的封装，以及两条 SQL 的**形态**（句子走 `sentence_note JOIN sentence`，
 *   词走 `word_note JOIN token JOIN sentence`）。漏注册会让前端 `invoke` 报 command not found（02 §四 风险行）。
 * - **B 段（SQL 语义）**：直接跑产品迁移建临时库（`001_init.sql` + 002，与 `db.rs` 的 `MIGRATIONS` 同序），
 *   插 2 条句笔记 + 1 条词笔记，断言 `get_article_note_marks` 的 **id 集合精确**（不是「非空」）；
 *   再插第二篇的笔记，断言**不串篇**（按 `article_id` 过滤）；清空后返回空。
 *
 * 为什么用 node 直跑 SQL 而不调 Rust：临时库秒级可建、可精确控制种子；Rust 侧另由
 * `analysis.rs` 单测 `article_note_marks_lists_only_this_articles_notes` 覆盖同一语义（双保险）。
 *
 * 红线（AC-R3）：本门禁只写 `sentence_note` / `word_note`，解析四表与 `vocab_entry` 零写。
 *
 * 用法：node scripts/verify-note-marks.mjs
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
const FILES = {
  analysis: path.join(root, "src-tauri", "src", "analysis.rs"),
  commands: path.join(root, "src-tauri", "src", "commands.rs"),
  lib: path.join(root, "src-tauri", "src", "lib.rs"),
  types: path.join(root, "src", "lib", "types.ts"),
  api: path.join(root, "src", "lib", "api.ts"),
};

for (const file of [...MIGRATIONS, ...Object.values(FILES)]) {
  if (!existsSync(file)) {
    console.error(`FAIL: 文件不存在：${file}`);
    process.exit(1);
  }
}

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};
const read = (file) => readFileSync(file, "utf8");

// ───────────────────────── A 段：命令契约在位 ─────────────────────────

/** [判据名, 文件, 正则] —— 正则故意写宽（容忍格式），但必须命中真实实现而不是注释里的字 */
const CONTRACT = [
  ["analysis.rs 定义 NoteMarks 结构", FILES.analysis, /pub struct NoteMarks\s*\{/],
  ["analysis.rs 实现 get_article_note_marks", FILES.analysis, /pub fn get_article_note_marks\s*\(/],
  [
    "analysis.rs 句子标记 SQL（sentence_note JOIN sentence，按 article_id 过滤）",
    FILES.analysis,
    /FROM\s+sentence_note\s+sn[\s\S]{0,160}JOIN\s+sentence\s+s\s+ON\s+s\.id\s*=\s*sn\.sentence_id[\s\S]{0,160}WHERE\s+s\.article_id\s*=\s*\?1/,
  ],
  [
    "analysis.rs 词标记 SQL（word_note JOIN token JOIN sentence，按 article_id 过滤）",
    FILES.analysis,
    /FROM\s+word_note\s+wn[\s\S]{0,200}JOIN\s+token\s+t\s+ON\s+t\.id\s*=\s*wn\.token_id[\s\S]{0,200}JOIN\s+sentence\s+s\s+ON\s+s\.id\s*=\s*t\.sentence_id[\s\S]{0,200}WHERE\s+s\.article_id\s*=\s*\?1/,
  ],
  ["commands.rs 薄包装 get_article_note_marks", FILES.commands, /pub fn get_article_note_marks\s*\(/],
  ["lib.rs generate_handler! 注册该命令", FILES.lib, /commands::get_article_note_marks/],
  ["types.ts 定义 NoteMarks", FILES.types, /export interface NoteMarks\s*\{/],
  ["api.ts 封装 getArticleNoteMarks", FILES.api, /export function getArticleNoteMarks\s*\(/],
];

let contractOk = 0;
for (const [label, file, pattern] of CONTRACT) {
  const hit = pattern.test(read(file));
  console.log(`${hit ? "PASS" : "FAIL"} | 契约 | ${label}`);
  if (hit) contractOk += 1;
  else fail(`契约缺失：${label}（${path.relative(root, file)}）`);
}
console.log(`契约判据: ${contractOk}/${CONTRACT.length} 在位`);

// ── 「一次 IPC」的可复算证据（AC-R3）──
// 运行时数 IPC 需要 Rust 侧计数钩子（本包不引入），改用**静态计数**：封装恰好一处、调用恰好一处。
// 一旦有人改成逐句调用（for 循环里调 getArticleNoteMarks）或加第二个入口，这里立刻红，且数字可复算。
const apiSource = read(FILES.api);
const readerSource = read(path.join(root, "src", "pages", "Reader.tsx"));
const invokeCount = (apiSource.match(/invoke<NoteMarks>\("get_article_note_marks"/g) || []).length;
const callCount = (readerSource.match(/getArticleNoteMarks\(/g) || []).length;
console.log(`IPC 计数: api.ts invoke=共 ${invokeCount} 处｜Reader.tsx 调用=共 ${callCount} 处`);
if (invokeCount !== 1) fail(`api.ts 应恰好 1 处 invoke<NoteMarks>("get_article_note_marks")，实测 ${invokeCount} 处`);
if (callCount !== 1) fail(`Reader.tsx 应恰好 1 处 getArticleNoteMarks( 调用（一次拉全篇），实测 ${callCount} 处`);

// ───────────────────────── B 段：SQL 语义（临时库） ─────────────────────────

const dir = mkdtempSync(path.join(tmpdir(), "judou-note-marks-"));
const dbPath = path.join(dir, "judou-note-marks.db");
const db = new DatabaseSync(dbPath);

try {
  for (const file of MIGRATIONS) db.exec(read(file));
  console.log(`临时库: ${dbPath}`);

  // ── 种子：A 篇（2 句，各有 1 token）/ B 篇（1 句 1 token） ──
  const insertArticle = (key, title) =>
    db
      .prepare("INSERT INTO article (source_key, title, exam_type, visibility) VALUES (?, ?, 'cet4', 'system')")
      .run(key, title).lastInsertRowid;
  const insertParagraph = (articleId, idx, text) =>
    db.prepare("INSERT INTO paragraph (article_id, idx, text) VALUES (?, ?, ?)").run(articleId, idx, text)
      .lastInsertRowid;
  const insertSentence = (articleId, paragraphId, idx, text, start, end) =>
    db
      .prepare(
        "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(articleId, paragraphId, idx, text, `hash-${idx}`, start, end).lastInsertRowid;
  const insertToken = (sentenceId, idx, surface, normalized, start, end) =>
    db
      .prepare(
        "INSERT INTO token (sentence_id, idx, surface, normalized, start_offset, end_offset, is_word) VALUES (?, ?, ?, ?, ?, ?, 1)",
      )
      .run(sentenceId, idx, surface, normalized, start, end).lastInsertRowid;

  const articleA = insertArticle("t-a", "A 篇");
  const paraA = insertParagraph(articleA, 0, "He runs. She walks.");
  const sentenceA1 = insertSentence(articleA, paraA, 0, "He runs.", 0, 8);
  const sentenceA2 = insertSentence(articleA, paraA, 1, " She walks.", 8, 19);
  const tokenA1 = insertToken(sentenceA1, 0, "runs", "run", 3, 7);
  const tokenA2 = insertToken(sentenceA2, 1, "walks", "walk", 13, 18);

  const articleB = insertArticle("t-b", "B 篇");
  const paraB = insertParagraph(articleB, 0, "They read.");
  const sentenceB1 = insertSentence(articleB, paraB, 0, "They read.", 0, 10);
  const tokenB1 = insertToken(sentenceB1, 0, "read", "read", 5, 9);

  /**
   * **与 `analysis.rs` 逐字同源的两条 SQL**（本脚本用同一份文本，漂移会被 A 段形态断言抓住）：
   * 句子只按 `sentence.article_id` 过滤；词经 `token.sentence_id → sentence.article_id` 过滤。
   */
  const SENTENCE_MARKS_SQL = `SELECT sn.sentence_id FROM sentence_note sn
      JOIN sentence s ON s.id = sn.sentence_id
     WHERE s.article_id = ?1
     ORDER BY sn.sentence_id`;
  const TOKEN_MARKS_SQL = `SELECT wn.token_id FROM word_note wn
      JOIN token t ON t.id = wn.token_id
      JOIN sentence s ON s.id = t.sentence_id
     WHERE s.article_id = ?1
     ORDER BY wn.token_id`;

  const marksOf = (articleId) => ({
    sentenceIds: db.prepare(SENTENCE_MARKS_SQL).all(articleId).map((row) => row.sentence_id),
    tokenIds: db.prepare(TOKEN_MARKS_SQL).all(articleId).map((row) => row.token_id),
  });

  const writeSentenceNote = (sentenceId, text) =>
    db
      .prepare(
        "INSERT INTO sentence_note (sentence_id, translation, grammar_note, phrase_note, updated_at) VALUES (?, ?, NULL, NULL, datetime('now'))",
      )
      .run(sentenceId, text);
  const writeWordNote = (tokenId, text) =>
    db
      .prepare(
        "INSERT INTO word_note (token_id, context_meaning, collocation, example, updated_at) VALUES (?, ?, NULL, NULL, datetime('now'))",
      )
      .run(tokenId, text);

  // ── 空库：两篇都应为空 ──
  const emptyA = marksOf(articleA);
  const emptyB = marksOf(articleB);
  console.log(`空库 A 篇: ${JSON.stringify(emptyA)}｜B 篇: ${JSON.stringify(emptyB)}`);
  if (emptyA.sentenceIds.length !== 0 || emptyA.tokenIds.length !== 0) fail("空库时 A 篇不应有标记");
  if (emptyB.sentenceIds.length !== 0 || emptyB.tokenIds.length !== 0) fail("空库时 B 篇不应有标记");

  // ── 写：A 篇 2 条句笔记 + 1 条词笔记 ──
  writeSentenceNote(sentenceA1, "A1 译");
  writeSentenceNote(sentenceA2, "A2 译");
  writeWordNote(tokenA1, "A1T 语境义");
  // 干扰项：A 篇另一个 token 不写、B 篇写全套（证明按篇过滤、不串篇）
  writeSentenceNote(sentenceB1, "B1 译");
  writeWordNote(tokenB1, "B1T 语境义");

  const marksA = marksOf(articleA);
  const marksB = marksOf(articleB);
  console.log(`写入后 A 篇: ${JSON.stringify(marksA)}（期望 sentenceIds=[${sentenceA1},${sentenceA2}], tokenIds=[${tokenA1}]）`);
  console.log(`写入后 B 篇: ${JSON.stringify(marksB)}（期望 sentenceIds=[${sentenceB1}], tokenIds=[${tokenB1}]）`);

  const sameIds = (actual, expected) =>
    actual.length === expected.length && actual.every((value, index) => value === expected[index]);

  if (!sameIds(marksA.sentenceIds, [sentenceA1, sentenceA2])) fail("A 篇句标记集合不精确（应恰为两条已写笔记的 sentence_id，且升序）");
  if (!sameIds(marksA.tokenIds, [tokenA1])) fail("A 篇词标记集合不精确（应恰为 tokenA1，未写笔记的 tokenA2 不得出现）");
  if (marksA.tokenIds.includes(tokenA2)) fail("未写笔记的词 tokenA2 不应出现在标记里");
  if (!sameIds(marksB.sentenceIds, [sentenceB1]) || !sameIds(marksB.tokenIds, [tokenB1])) {
    fail("B 篇标记不精确（跨篇不得串味）");
  }

  // ── 清空 A 篇：标记消失，B 篇不受影响 ──
  db.prepare("DELETE FROM sentence_note WHERE sentence_id IN (?, ?)").run(sentenceA1, sentenceA2);
  db.prepare("DELETE FROM word_note WHERE token_id = ?").run(tokenA1);
  const afterClearA = marksOf(articleA);
  const afterClearB = marksOf(articleB);
  console.log(`清空 A 篇后: ${JSON.stringify(afterClearA)}｜B 篇: ${JSON.stringify(afterClearB)}`);
  if (afterClearA.sentenceIds.length !== 0 || afterClearA.tokenIds.length !== 0) fail("清空 A 篇笔记后标记应全部消失");
  if (!sameIds(afterClearB.sentenceIds, [sentenceB1])) fail("清空 A 篇不得影响 B 篇标记");

  // ── 清空 B 篇：全空 ──
  db.prepare("DELETE FROM sentence_note WHERE sentence_id = ?").run(sentenceB1);
  db.prepare("DELETE FROM word_note WHERE token_id = ?").run(tokenB1);
  const allEmpty = marksOf(articleA);
  const allEmptyB = marksOf(articleB);
  if (allEmpty.sentenceIds.length || allEmpty.tokenIds.length || allEmptyB.sentenceIds.length || allEmptyB.tokenIds.length) {
    fail("两张笔记表都清空后应返回空集合");
  }

  // ── 红线：解析四表与 vocab_entry 零写 ──
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
  console.error("FAIL: 本篇笔记标记断言未通过");
  process.exit(1);
}
console.log(
  "PASS: 命令契约 8/8 在位 / 空库为空 / 2 句 + 1 词标记集合精确 / 未写笔记的 token 不出现 / 按篇过滤不串味 / 清空即消失 / 解析四表与 vocab_entry 零写",
);
