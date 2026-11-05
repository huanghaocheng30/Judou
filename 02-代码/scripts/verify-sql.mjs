#!/usr/bin/env node
/**
 * D2/AC2 断言：用 node:sqlite 空跑 src-tauri/migrations/001_init.sql，
 * 校验「19 张物理表（18 业务 + schema_meta）」、schema_meta.version=1、
 * 6 条显式索引、app_setting 两条默认值。
 *
 * ponytail: :memory: 里跑同一份 SQL 即可验语法与表数——比启动整个 Tauri 便宜两个数量级。
 * 升级路径：002 起按 migrations/*.sql 顺序跑，与 db.rs 的版本游标对齐（M1 导入包再扩）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sqlPath = path.join(root, "src-tauri", "migrations", "001_init.sql");

const EXPECTED_TABLES = [
  // 内容 9
  "article", "paragraph", "sentence", "token", "question", "blank",
  "sentence_analysis", "token_analysis", "lexicon",
  // 用户 8
  "sentence_note", "word_note", "vocab_entry", "tag", "vocab_tag",
  "review_plan", "review_log", "reading_record",
  // 配置 1 + 元 1
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

if (!existsSync(sqlPath)) {
  console.error(`FAIL: 迁移文件不存在：${sqlPath}`);
  process.exit(1);
}

const sql = readFileSync(sqlPath, "utf8");
const db = new DatabaseSync(":memory:");
let failed = false;

try {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN");
  db.exec(sql);
  db.exec("COMMIT");
} catch (err) {
  console.error(`FAIL: 001_init.sql 执行失败：${err.message}`);
  process.exit(1);
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
const extra = tables.filter((t) => !EXPECTED_TABLES.includes(t));

console.log(`表数: ${tables.length}（期望 19 = 18 业务 + schema_meta）`);
console.log(`表名: ${tables.join(", ")}`);
if (missing.length) { console.error(`FAIL: 缺表 ${missing.join(", ")}`); failed = true; }
if (extra.length) { console.error(`FAIL: 多出未登记的表 ${extra.join(", ")}`); failed = true; }

const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
console.log(`schema_meta.version = ${versionRow ? versionRow.value : "<缺失>"}`);
if (!versionRow || versionRow.value !== "1") { console.error("FAIL: schema_meta.version 应为 1"); failed = true; }

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`显式索引数: ${indexes.length}（期望 6）`);
console.log(`索引名: ${indexes.join(", ")}`);
for (const idx of EXPECTED_INDEXES) {
  if (!indexes.includes(idx)) { console.error(`FAIL: 缺索引 ${idx}`); failed = true; }
}

const settings = db.prepare("SELECT key, value FROM app_setting ORDER BY key").all();
console.log(`app_setting 默认值: ${settings.map((r) => `${r.key}=${r.value}`).join(", ")}`);
const theme = settings.find((r) => r.key === "theme");
const guide = settings.find((r) => r.key === "guide_shown");
if (!theme || theme.value !== "system") { console.error("FAIL: app_setting.theme 默认应为 system"); failed = true; }
if (!guide || guide.value !== "0") { console.error("FAIL: app_setting.guide_shown 默认应为 0"); failed = true; }

// 关键列抽查（评审驳回过的两处，防回退）
const tokenAnalysisCols = db.prepare("PRAGMA table_info(token_analysis)").all().map((c) => c.name);
console.log(`token_analysis 含 is_cet4_high_freq = ${tokenAnalysisCols.includes("is_cet4_high_freq")}`);
if (!tokenAnalysisCols.includes("is_cet4_high_freq")) { console.error("FAIL: token_analysis 缺 is_cet4_high_freq"); failed = true; }

const lexiconCols = db.prepare("PRAGMA table_info(lexicon)").all().map((c) => c.name);
console.log(`lexicon 列 = ${lexiconCols.join(", ")}`);
if (lexiconCols.includes("id")) { console.error("FAIL: lexicon 应为 normalized 主键，不应有代理 id 列"); failed = true; }

const blankIdx = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blank'")
  .all()
  .map((r) => r.name);
console.log(`blank 上的索引/唯一约束 = ${blankIdx.join(", ") || "<无>"}`);

// 外键级联抽查：article -> blank 必须 CASCADE
const fks = db.prepare("PRAGMA foreign_key_list(blank)").all();
console.log(`blank 外键 = ${JSON.stringify(fks.map((f) => ({ from: f.from, table: f.table, on_delete: f.on_delete })))}`);
if (!fks.some((f) => f.table === "article" && f.on_delete === "CASCADE")) {
  console.error("FAIL: blank.article_id 缺 ON DELETE CASCADE");
  failed = true;
}

db.close();
if (failed) { console.error("FAIL: 迁移自检未通过"); process.exit(1); }
console.log("PASS: 19 张表 / version=1 / 6 索引 / 默认值 全部符合 02 D2");
