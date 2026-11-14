#!/usr/bin/env node
/**
 * AC2 schema 断言：在**脚本内临时库**（`:memory:`）跑真迁移 SQL（001→003），核查 19 张物理表 /
 * schema_meta.version=3 / 6 条显式索引 / 003 的 answer_source 列。与 verify-sql.mjs 的区别：
 *   verify-sql = 迁移 SQL 的静态结构自检（不执行）
 *   check-tables = 真执行一遍迁移（证明 db.rs 那套游标 + `execute_batch` 能吃下三份 SQL）
 *
 * M16 D4：**不再读 `%APPDATA%\com.judou.app\judou.db`**。原口径要求「应用启动过一次」，
 * 于是干净机器上必红（假失败）、为绿去造库又是假证据；schema 正确性本该由迁移 SQL 自己证明。
 *
 * 用法：node scripts/check-tables.mjs
 */
import { openTempPackDb } from "./lib/temp-pack-db.mjs";

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

console.log("数据源: 脚本内临时库（:memory:，跑真迁移 SQL 001→003）");

const db = openTempPackDb({ withContent: false });
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
console.log("PASS: 迁移后 schema 19 张表 / version=3 / 6 索引 全部符合");
