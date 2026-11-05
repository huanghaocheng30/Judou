#!/usr/bin/env node
/**
 * AC2 断言（(a) 空库起点）：用 node:sqlite 在 :memory: 里按 migrations/ 目录顺序跑
 * 001 → 002，断「空库全链」：表数仍 19、三列落地、schema_meta.version=2。
 *
 * 与 check-tables.mjs 的分工（02 v1.2 N2）：
 *   verify-sql   = 空库全链（001+002 从零跑）——写迁移时的秒级门禁
 *   check-tables = 真实运行期库（证明应用启动时确实跑过迁移）
 *
 * 001 段仍断 version=1（001 自己写的初始游标）；002 段断 version=2。
 * **002 段必须自己模拟 db.rs 的版本写回**（O4）：002_*.sql 只有 ALTER TABLE，
 * 游标写回在 Rust 侧（db.rs 提交迁移时 UPDATE schema_meta）。不补这一行会永远停在 1。
 *
 * ponytail: :memory: 里跑同一份 SQL 即可验语法/表数/列定义——比启动整个 Tauri 便宜两个数量级；
 * 等出现「修改数据的历史迁移」（非纯 DDL）再考虑改成真实库副本回放。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "src-tauri", "migrations");

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

// 002 三列：名字 → [类型, 默认值]（AC2 判据，逐列）
const COLUMNS_002 = [
  ["token", "is_word", "INTEGER", "1"],
  ["article", "pack_version", "TEXT", null],
  ["article", "sentence_count", "INTEGER", "0"],
];

/** 按文件名升序取全部迁移（001_init.sql → 002_add_import_columns.sql → …） */
function listMigrations() {
  if (!existsSync(migrationsDir)) {
    console.error(`FAIL: 迁移目录不存在：${migrationsDir}`);
    process.exit(1);
  }
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length < 2) {
    console.error(`FAIL: migrations/ 下应至少有 001 与 002 两份，实测 ${files.length}：${files.join(", ")}`);
    process.exit(1);
  }
  const first = files[0];
  const second = files[1];
  if (!first.startsWith("001")) { console.error(`FAIL: 首份迁移应为 001_*.sql，实测 ${first}`); process.exit(1); }
  if (!second.startsWith("002")) { console.error(`FAIL: 第二份迁移应为 002_*.sql，实测 ${second}`); process.exit(1); }
  return { files, first, second };
}

const { files, first, second } = listMigrations();
const db = new DatabaseSync(":memory:");
let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };

/** 在事务里执行一份迁移文件（与 db.rs 同口径：SQL 内不写 BEGIN/COMMIT） */
function runMigration(file) {
  const sql = readFileSync(path.join(migrationsDir, file), "utf8");
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (err) {
    console.error(`FAIL: ${file} 执行失败：${err.message}`);
    process.exit(1);
  }
}

/** 模拟 db.rs 的版本游标写回（迁移提交后 UPDATE schema_meta.version） */
function writeBackVersion(version) {
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

const tableNames = () =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

const versionValue = () => {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
  return row ? row.value : null;
};

const columnInfo = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => ({ name: c.name, type: c.type, dflt: c.dflt_value }));

// ─────────────────── 第 1 段：001（空库起点，判据与 M0 一致） ───────────────────
console.log(`迁移清单: ${files.join(" → ")}`);
runMigration(first);
console.log(`\n── ${first} ──`);

const tablesAfter001 = tableNames();
const missing = EXPECTED_TABLES.filter((t) => !tablesAfter001.includes(t));
const extra = tablesAfter001.filter((t) => !EXPECTED_TABLES.includes(t));
console.log(`表数: ${tablesAfter001.length}（期望 19 = 18 业务 + schema_meta）`);
console.log(`表名: ${tablesAfter001.join(", ")}`);
if (missing.length) fail(`缺表 ${missing.join(", ")}`);
if (extra.length) fail(`多出未登记的表 ${extra.join(", ")}`);

const versionAfter001 = versionValue();
console.log(`schema_meta.version = ${versionAfter001 ?? "<缺失>"}（001 段期望 1）`);
if (versionAfter001 !== "1") fail(`001 段 version 应为 1，实测 ${versionAfter001}`);

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`显式索引数: ${indexes.length}（期望 6）`);
console.log(`索引名: ${indexes.join(", ")}`);
for (const idx of EXPECTED_INDEXES) if (!indexes.includes(idx)) fail(`缺索引 ${idx}`);

const settings = db.prepare("SELECT key, value FROM app_setting ORDER BY key").all();
console.log(`app_setting 默认值: ${settings.map((r) => `${r.key}=${r.value}`).join(", ")}`);
const theme = settings.find((r) => r.key === "theme");
const guide = settings.find((r) => r.key === "guide_shown");
if (!theme || theme.value !== "system") fail("app_setting.theme 默认应为 system");
if (!guide || guide.value !== "0") fail("app_setting.guide_shown 默认应为 0");

// 关键列抽查（评审驳回过的两处，防回退）
const tokenAnalysisCols = columnInfo("token_analysis").map((c) => c.name);
console.log(`token_analysis 含 is_cet4_high_freq = ${tokenAnalysisCols.includes("is_cet4_high_freq")}`);
if (!tokenAnalysisCols.includes("is_cet4_high_freq")) fail("token_analysis 缺 is_cet4_high_freq");

const lexiconCols = columnInfo("lexicon").map((c) => c.name);
console.log(`lexicon 列 = ${lexiconCols.join(", ")}`);
if (lexiconCols.includes("id")) fail("lexicon 应为 normalized 主键，不应有代理 id 列");

const blankIdx = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blank'")
  .all()
  .map((r) => r.name);
console.log(`blank 上的索引/唯一约束 = ${blankIdx.join(", ") || "<无>"}`);

// 外键级联抽查：article -> blank 必须 CASCADE
const fks = db.prepare("PRAGMA foreign_key_list(blank)").all();
console.log(`blank 外键 = ${JSON.stringify(fks.map((f) => ({ from: f.from, table: f.table, on_delete: f.on_delete })))}`);
if (!fks.some((f) => f.table === "article" && f.on_delete === "CASCADE")) fail("blank.article_id 缺 ON DELETE CASCADE");

// ─────────────────── 第 2 段：002（三列 + 版本 2 + 表数不变） ───────────────────
runMigration(second);
// O4：002 只有 ALTER TABLE，游标写回在 db.rs —— 脚本必须自己补这一行
writeBackVersion(2);
console.log(`\n── ${second} ──（已按 db.rs 口径模拟版本写回）`);

const versionAfter002 = versionValue();
console.log(`schema_meta.version = ${versionAfter002 ?? "<缺失>"}（002 段期望 2）`);
if (versionAfter002 !== "2") fail(`002 段 version 应为 2，实测 ${versionAfter002}`);

const tablesAfter002 = tableNames();
console.log(`表数: ${tablesAfter002.length}（002 只加列不加表，期望仍 19）`);
if (tablesAfter002.length !== 19) fail(`002 段表数应为 19，实测 ${tablesAfter002.length}`);
const newTables = tablesAfter002.filter((t) => !tablesAfter001.includes(t));
if (newTables.length) fail(`002 不应建新表，实测多出 ${newTables.join(", ")}`);

for (const [table, name, expectType, expectDefault] of COLUMNS_002) {
  const found = columnInfo(table).find((c) => c.name === name);
  const got = found ? `${found.type} / 默认 ${found.dflt ?? "<无>"}` : "<缺失>";
  console.log(`${table}.${name} = ${got}（期望 ${expectType} / 默认 ${expectDefault ?? "<无>"}）`);
  if (!found) { fail(`002 缺列 ${table}.${name}`); continue; }
  if (found.type.toUpperCase() !== expectType) fail(`${table}.${name} 类型应为 ${expectType}，实测 ${found.type}`);
  if ((found.dflt ?? null) !== expectDefault) fail(`${table}.${name} 默认值应为 ${expectDefault ?? "<无>"}，实测 ${found.dflt ?? "<无>"}`);
}

// 001 段的核心结构在 002 之后必须原样保留（加法迁移不得动老列/老索引）
const indexesAfter002 = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`002 后显式索引数: ${indexesAfter002.length}（期望仍 6）`);
for (const idx of EXPECTED_INDEXES) if (!indexesAfter002.includes(idx)) fail(`002 后缺索引 ${idx}`);

db.close();
if (failed) { console.error("FAIL: 空库全链迁移自检未通过"); process.exit(1); }
console.log("\nPASS: 空库全链 001→002 / 19 表 / version=2 / 三列类型与默认值 / 6 索引 全部符合 02 D1");
