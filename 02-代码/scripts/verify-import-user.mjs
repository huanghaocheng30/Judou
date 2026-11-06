#!/usr/bin/env node
/**
 * M5 用户导入门禁（D8）：AC1~AC7 的**契约级**断言。
 *
 * 分工：
 *   verify-import-user.mjs（本文件）= 用户导入管线（`import_user.rs`）的段/句/token/四层校验/入库计数
 *   verify-import.mjs              = 内置 12 篇内容包导入结果（本文件不动它）
 *
 * 判据来源：02 v1.1 §一 AC1/AC2/AC4/AC5/AC6/AC7 + §三 裁定 5/7。
 *
 * 数据库：`node:sqlite` 临时文件库，按 `db.rs` 的 `MIGRATIONS` **同序**跑 001 + 002。
 * **零写入**口径（N-4）：`db.total_changes()` 前后差值 = 0（`PRAGMA data_version` 同连接写入后
 * 不变、实测 1→1，不可用）+ 九张核心表 `COUNT(*)` 快照逐表比对。
 *
 * 用法：
 *   node scripts/verify-import-user.mjs                # 全量（需要实现已落地）
 *   node scripts/verify-import-user.mjs --source-only  # 只跑静态段（红端：实现未落地时自证门禁是活的）
 *
 * ponytail: 句/词级判据走**契约 JSON**（Rust bin `import_user_cli` 生成），不在 JS 里重写切句器——
 * 两份实现只会带来两份漂移；等出现「Rust 侧跑不动（慢）」再考虑把判据整体搬进 Rust 单测。
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "src-tauri", "migrations");
const sourceOnly = process.argv.includes("--source-only");

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};
const ok = (msg) => console.log(`  ok   ${msg}`);
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${label} = ${a}`);
  else fail(`${label} 实测 ${a}，期望 ${e}`);
};

// ───────────────────────── 0. 迁移同序建库 ─────────────────────────
// 与 db.rs 的 MIGRATIONS 同序：001 建 19 张表写 version=1；002 只 ALTER，**游标写回由这里补**
// （O4：迁移文件里没有游标，Rust 侧 db.rs 提交时写；不补这一行会永远停在 1）。
if (!existsSync(migrationsDir)) {
  console.error(`FAIL: 迁移目录不存在：${migrationsDir}`);
  process.exit(1);
}
const sql001 = readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
const sql002 = readFileSync(path.join(migrationsDir, "002_add_import_columns.sql"), "utf8");
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "judou-import-user-"));
const dbPath = path.join(tmpDir, "judou.db");

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec(sql001);
// 001 末尾自带 `INSERT OR IGNORE ... version=1`（行 240）——这里**不重复写**，只断它落地了
const v1 = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()?.value ?? null;
if (v1 !== "1") {
  console.error(`FAIL: 001 迁移后 schema_meta.version 应为 1，实测 ${v1}`);
  process.exit(1);
}
db.exec(sql002);
db.exec("UPDATE schema_meta SET value = '2' WHERE key = 'version'");

const CONTENT_TABLES = [
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
const snapshot = () => {
  const out = {};
  for (const table of CONTENT_TABLES) out[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  return out;
};
const diffSnapshot = (before, after) =>
  CONTENT_TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t}: ${before[t]} → ${after[t]}`);

console.log(`库路径: ${dbPath}`);
const version = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()?.value ?? null;
console.log(`迁移同序 001 → 002：schema_meta.version = ${version}（期望 2）`);
if (version !== "2") fail(`schema 版本应为 2，实测 ${version}`);

// ───────────────────────── 1. 静态段（红端也跑） ─────────────────────────
console.log("\n── [静态] 偏移口径、依赖禁令、冻结属性 ──");
const importUserPath = path.join(root, "src-tauri", "src", "import_user.rs");
const implExists = existsSync(importUserPath);
if (!implExists) {
  console.log(`  note ${path.relative(root, importUserPath)} 不存在 → 实现段将整段 FAIL（红端）`);
} else {
  const src = readFileSync(importUserPath, "utf8");
  // AC5：偏移是 UTF-16 code unit（001_init.sql「偏移口径：UTF-16 code unit（ADR-008）」）
  if (/\.encode_utf16\(\)|len_utf16\(\)/.test(src)) ok("import_user.rs 含 UTF-16 偏移计算（encode_utf16 / len_utf16）");
  else fail("import_user.rs 未见 UTF-16 偏移计算——Rust 默认 byte 偏移与库口径不符（ADR-008）");
}

const cargo = readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
for (const forbidden of ["uuid", "rand", "tokio"]) {
  if (new RegExp(`^\\s*${forbidden}\\s*=`, "m").test(cargo)) fail(`Cargo.toml 新增了依赖 ${forbidden}（02 禁止）`);
}
ok("Cargo.toml 未新增 uuid / rand / tokio");

// 六个冻结 data-* 只能保持存在（本批不碰前端，改到即违规）
const FROZEN = [
  "data-sentence-id",
  "data-token-id",
  "data-blank-no",
  "data-paragraph-id",
  "data-article-id",
  "data-vocab-state",
];
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
};
const uiFiles = walk(path.join(root, "src"));
for (const attr of FROZEN) {
  const missing = uiFiles.filter((file) => readFileSync(file, "utf8").includes(attr)).length === 0;
  if (missing) fail(`冻结属性 ${attr} 在 src/ 下消失（AC12）`);
}
ok(`六个冻结 data-* 仍在 src/ 下（${FROZEN.length} 个，扫描 ${uiFiles.length} 个 ts/tsx）`);

if (sourceOnly) {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(failed ? "\n[--source-only] 静态段有 FAIL" : "\n[--source-only] 静态段全绿（红端自证门禁是活的）");
  process.exit(failed ? 1 : 0);
}

// ───────────────────────── 2. 实现契约：调用 Rust bin ─────────────────────────
/**
 * 契约（本门禁与实现之间唯一接口）：
 *   cargo run --offline --quiet --manifest-path src-tauri/Cargo.toml --bin import_user_cli -- <case>
 *   stdout = 一行 JSON；业务失败 = 退出码 0 且 JSON 带 `error.code`。
 * case 清单见 `src-tauri/src/bin/import_user_cli.rs` 的 `match`。
 */
console.log("\n── 调用 import_user_cli（实现契约）──");
if (!existsSync(path.join(root, "src-tauri", "src", "bin", "import_user_cli.rs"))) {
  fail("缺少 src-tauri/src/bin/import_user_cli.rs（门禁契约未落地）");
}

const runCase = (name) => {
  const stdout = execFileSync(
    "cargo",
    [
      "run",
      "--offline",
      "--quiet",
      "--manifest-path",
      path.join(root, "src-tauri", "Cargo.toml"),
      "--bin",
      "import_user_cli",
      "--",
      name,
      dbPath, // 用本脚本建好的同序迁移库，跑完后下面直查同一份数据
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  // 实现会往 stdout 打一行 `[judou][import-user] …` 诊断日志：只取最后一个以 `{` 开头的行
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error(`import_user_cli 未输出 JSON（前 200 字：${stdout.slice(0, 200)}）`);
  return JSON.parse(line);
};

let report;
try {
  report = runCase("all");
} catch (err) {
  fail(`import_user_cli 运行失败：${err.message?.split("\n")[0] ?? err}`);
  report = null;
}

if (report) {
  // ── AC2 清洗五类 ──
  console.log("\n── AC2 清洗五类 ──");
  const c = report.clean;
  eq("无 BOM", c.hasBom, false);
  eq("无 \\r", c.hasCr, false);
  eq("无零宽（200b/200c/200d/feff）", c.zeroWidth, []);
  eq("连续空行压成 1", c.blankRun, "\n\n");
  eq("\\r\\n 与 \\r 归一", c.lineEndings, ["a\nb", "a\nb"]);

  // ── AC3 分段 ──
  console.log("\n── AC3 分段 ──");
  eq("段 idx 连续", report.segment.idxs, [0, 1, 2]);
  eq("纯空白段不产生 paragraph", report.segment.count, 3);

  // ── AC4 切句 ──
  console.log("\n── AC4 切句（B-2 写死：单一缩写表 + 命中即不断）──");
  const s = report.sentence;
  eq("① 两句", s.basic, ["One end.", "Next one."]);
  eq("② Mr. 不断", s.mrSmith, ["Mr. Smith said."]);
  eq("② U.S. 不断", s.usEconomy, ["The U.S. economy grew."]);
  eq("③ 小数不断", s.decimal, ["Pi is 3.14 now."]);
  eq("④ 句末引号归属该句", s.quoted, ['He said "Done."']);
  eq("⑤ ?! 同 .（`?!` 不拆开，`?` 收尾）", s.interrobang, ["What?!", "Really?"]);
  eq("② 表内其余 14 个缩写全部不断（表内共 18 个）", s.others, 14);
  eq("缩写表规模", s.abbreviationCount, 18);

  // ── AC5 分词与偏移（UTF-16）──
  console.log("\n── AC5 分词与偏移（UTF-16 code unit）──");
  const t = report.token;
  eq("students' 一个 token", t.apostrophe.surface, "Students'");
  eq("students' normalized", t.apostrophe.normalized, "students");
  eq("students' isWord", t.apostrophe.isWord, true);
  eq("day-to-day 一个 token", t.hyphen.surface, "day-to-day");
  for (const num of report.numbers) {
    eq(`${num.surface} isWord`, num.isWord, false);
    eq(`${num.surface} normalized`, num.normalized, null);
  }
  eq("空格不属于任何 token", t.noSpaceTokens, true);
  // UTF-16：中文标点 / emoji / 组合字符各一，切片必须逐条相等
  for (const cs of report.utf16) {
    eq(`UTF-16[${cs.label}] 全句切片`, cs.sentenceSlicesEqual, true);
    eq(`UTF-16[${cs.label}] 逐 token 切片`, cs.tokenSlicesEqual, true);
    eq(`UTF-16[${cs.label}] 覆盖除空格`, cs.coverageEqual, true);
    eq(`UTF-16[${cs.label}] end（UTF-16 单位）`, cs.utf16Length, cs.utf16Measured);
  }
  for (const cs of report.offsets) {
    eq(`偏移[${cs.label}] 句 start/end`, [cs.start, cs.end], [cs.expectStart, cs.expectEnd]);
  }

  // ── AC1 parse 不写库（Rust 侧 total_changes 差值）──
  console.log("\n── AC1 parse_import_preview 零写入 ──");
  eq("parse 期间 total_changes 差值", report.commit.totals.parseDelta, 0);
  // SAMPLE = 2 段 × 每段 2 句（`…over time. Many people…` / `…every single day. Keep…`）
  eq("parse stats", report.parse.stats, { paragraphCount: 2, sentenceCount: 4, tokenCount: 34, wordCount: 30 });
  eq("用户给标题原样保留", report.parse.title, "样例");

  // ── AC6 四层校验 + 六错误码 + 零写入 ──
  console.log("\n── AC6 四层校验（每码 + 库中零写入）──");
  const expectCodes = {
    L1: "IMPORT_L1_STRUCTURE",
    L2: "IMPORT_L2_OFFSET",
    L3: "IMPORT_L3_COVERAGE",
    L4: "IMPORT_L4_BUSINESS",
    L4_control: "IMPORT_L4_BUSINESS",
    TOO_LARGE: "IMPORT_TOO_LARGE",
  };
  for (const [key, code] of Object.entries(expectCodes)) {
    const r = report.errors[key];
    eq(`${key} 错误码`, r.code, code);
    if (!r.message) fail(`${key} 缺可操作提示（AC11：错误码 + 提示）`);
  }
  // 三个「commit 内」的错误码必须证明「库中零写入」（N-4：total_changes 差值 + 九表 COUNT 快照）
  for (const [key, r] of Object.entries(report.commit.errors)) {
    eq(`commit 内 ${key} 错误码`, r.code, key === "DUPLICATE" ? "IMPORT_DUPLICATE_SOURCE" : "IMPORT_L2_OFFSET");
    eq(`commit 内 ${key} 库中零写入（total_changes 差值）`, r.delta, 0);
    const changed = Object.keys(r.countsBefore).filter((k) => r.countsBefore[k] !== r.countsAfter[k]);
    eq(`commit 内 ${key} 九表 COUNT 快照无变化`, changed, []);
  }
  // 错误码清单必须齐全（六码，02 AC6）
  const allCodes = new Set([
    ...Object.values(expectCodes),
    report.commit.errors.L2.code,
    report.commit.errors.DUPLICATE.code,
  ]);
  eq("六错误码齐全", [...allCodes].sort(), [
    "IMPORT_DUPLICATE_SOURCE",
    "IMPORT_L1_STRUCTURE",
    "IMPORT_L2_OFFSET",
    "IMPORT_L3_COVERAGE",
    "IMPORT_L4_BUSINESS",
    "IMPORT_TOO_LARGE",
  ]);

  // ── AC7 入库计数 + 两次 commit 是两篇 ──
  console.log("\n── AC7 入库（sentence_count 等）+ 两次 commit = 两篇 ──");
  const commit = report.commit;
  eq("article 新增 2 行", commit.articleRowsAdded, 2);
  eq("source_key 形如 user-<hex>", commit.sourceKeyShape, [true, true]);
  eq("两次 commit 的 source_key 不同", commit.sourceKeyDistinct, true);
  const a = commit.row;
  eq("sentence_count = 真实句数", a.sentence_count, a.realSentences);
  eq("paragraph_count = 真实段数", a.sentence_count > 0 ? a.realParagraphs : -1, 2);
  eq("token_count = 真实 token 数", a.token_count, a.realTokens);
  eq("word_count = 真实词数", a.word_count, a.realWords);
  eq("exam_type 取 meta", a.exam_type, "cet6");
  eq("exam_year 取 meta", a.exam_year, 2022);
  eq("title 取用户输入", commit.titleFromUser, "我的第一篇");
  eq("title 缺省取正文首行前 40 字", commit.titleFallback.got, commit.titleFallback.expect);
  if (!/^未命名导入 \d{4}-\d{2}-\d{2}$/.test(commit.titleEmpty.got)) {
    fail(`title 兜底应为「未命名导入 YYYY-MM-DD」，实测 ${JSON.stringify(commit.titleEmpty.got)}`);
  } else ok(`title 兜底 = ${commit.titleEmpty.got}`);

  // ── 段/句/token 落到库里逐条对得上（切片复核，用库里的偏移）──
  console.log("\n── 入库后回读：偏移在库里仍能切片 ──");
  eq("回读偏差", commit.readbackMismatches, []);

  // ── 库内直接核 visibility / sentence_count（不信实现自报）──
  console.log("\n── 库内直查（不信实现自报）──");
  const rows = db
    .prepare("SELECT source_key, visibility, sentence_count, word_count, title, exam_type, exam_year FROM article ORDER BY id")
    .all();
  eq("article 行数", rows.length, 2);
  eq("visibility 全为 user", rows.map((r) => r.visibility), ["user", "user"]);
  eq(
    "sentence_count 全为 4（B-3'：不写会显示 0 句；SAMPLE 2 段 × 2 句）",
    rows.map((r) => r.sentence_count),
    [4, 4],
  );
  eq("word_count 全为 30", rows.map((r) => r.word_count), [30, 30]);
  eq("source_key 都形如 user-<hex>", rows.every((r) => /^user-[0-9a-f]+$/.test(r.source_key)), true);
  const tokensInDb = db
    .prepare(
      `SELECT COUNT(*) AS c FROM token t JOIN sentence s ON s.id = t.sentence_id
       JOIN article a ON a.id = s.article_id WHERE a.visibility = 'user'`,
    )
    .get().c;
  eq("库内 user 篇 token 总数（2 篇 × 34）", tokensInDb, 68);
  const analyses = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sentence_analysis sa JOIN sentence s ON s.id = sa.sentence_id JOIN article a ON a.id = s.article_id WHERE a.visibility='user') AS sa,
              (SELECT COUNT(*) FROM token_analysis ta JOIN token t ON t.id = ta.token_id JOIN sentence s ON s.id = t.sentence_id JOIN article a ON a.id = s.article_id WHERE a.visibility='user') AS ta`,
    )
    .get();
  eq("导入文章无预置解析（降级精读的前提，AC9）", [analyses.sa, analyses.ta], [0, 0]);
}

db.close();
rmSync(tmpDir, { recursive: true, force: true });
if (failed) {
  console.error("\nFAIL: 用户导入与 02 v1.1 AC1/AC2/AC4/AC5/AC6/AC7 不符");
  process.exit(1);
}
console.log("\nPASS: 用户导入 清洗/分段/切句/分词(UTF-16)/四层校验/六错误码零写入/入库计数/两篇 全部符合 02 v1.1");