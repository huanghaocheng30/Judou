#!/usr/bin/env node
/**
 * AC2 运行期断言：只读打开 Tauri 生成的本地库，核查 19 张物理表 / schema_meta.version（002 后应为 2） /
 * 6 条显式索引 / app_setting 实际值。与 verify-sql.mjs 的区别：
 *   verify-sql = 迁移 SQL 空跑（写代码时的语法与结构自检）
 *   check-tables = 真实运行期库（证明应用启动时确实建了库）
 *
 * 用法：node scripts/check-tables.mjs [dbPath]
 *   缺省路径 = %APPDATA%\\com.judou.app\\judou.db（Tauri v2 app_data_dir + identifier）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

const IDENTIFIER = "com.judou.app";
const dbPath =
  process.argv[2] ??
  path.join(process.env.APPDATA ?? "", IDENTIFIER, "judou.db");

const EXPECTED_TABLES = [
  "article", "paragraph", "sentence", "token", "question", "blank",
  "sentence_analysis", "token_analysis", "lexicon",
  "sentence_note", "word_note", "vocab_entry", "tag", "vocab_tag",
  "review_plan", "review_log", "reading_record",
  "app_setting", "schema_meta",
];
const EXPECTED_INDEXES = [
  "idx_article_exam",
  "idx_article_visibility_list",
  "idx_sentence_paragraph",
  "idx_token_sentence",
  "idx_vocab_normalized",
  "idx_review_plan_due",
];

console.log(`库路径: ${dbPath}`);
if (!existsSync(dbPath)) {
  console.error("FAIL: 库文件不存在（应用是否启动过？）");
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
let failed = false;

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`表数: ${tables.length}`);
tables.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2, "0")}. ${t}`));

const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
const extra = tables.filter((t) => !EXPECTED_TABLES.includes(t));
if (missing.length) { console.error(`FAIL: 缺表 ${missing.join(", ")}`); failed = true; }
if (extra.length) { console.error(`FAIL: 多出未登记的表 ${extra.join(", ")}`); failed = true; }
if (tables.length !== 19) { console.error(`FAIL: 表数应为 19，实测 ${tables.length}`); failed = true; }

const version = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
console.log(`schema_meta.version = ${version ? version.value : "<缺失>"}`);
if (!version || version.value !== "3") { console.error("FAIL: version 应为 3（003 落地后）"); failed = true; }

// M5c AC12：003 迁移的列必须真在库里（迁移编号复用 002 时会被版本游标跳过 → 这里必红）
const questionColumns = db.prepare("PRAGMA table_info(question)").all().map((r) => r.name);
console.log(`question 列: ${questionColumns.join(", ")}`);
if (!questionColumns.includes("answer_source")) {
  console.error("FAIL: question 缺列 answer_source（003_answer_source.sql 是否注册进 db.rs MIGRATIONS？）");
  failed = true;
}

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`显式索引数: ${indexes.length} → ${indexes.join(", ")}`);
for (const idx of EXPECTED_INDEXES) {
  if (!indexes.includes(idx)) { console.error(`FAIL: 缺索引 ${idx}`); failed = true; }
}

const settings = db.prepare("SELECT key, value FROM app_setting ORDER BY key").all();
console.log(`app_setting: ${settings.length === 0 ? "<空>" : settings.map((r) => `${r.key}=${r.value}`).join(", ")}`);

const fkOn = db.prepare("PRAGMA foreign_keys").get();
console.log(`PRAGMA foreign_keys（只读连接，仅展示）= ${JSON.stringify(fkOn)}`);

db.close();
if (failed) { console.error("FAIL: 运行期库与 02 D2 清单不符"); process.exit(1); }
console.log("PASS: 运行期库 19 张表 / version=2 / 6 索引 全部符合");
