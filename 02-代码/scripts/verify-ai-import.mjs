#!/usr/bin/env node
/**
 * M5b D7 门禁：AI 解析导入（AC7/AC8/AC9/AC10/AC12/AC13/AC15/AC16/AC17/AC18）的**契约级**断言。
 *
 * 分工：
 *   verify-ai-import.mjs（本文件） = `ai_import.rs` 的纯函数语义 + 库层写库结果
 *   ai_import_cli（Rust bin）      = 唯一执行通道（校验与 SQL 只有一份实现，本脚本不重写）
 *
 * 判据来源：02 v1.2a §一 AC7~AC18、§三 payload 契约、§五 错误码、§六 fixture 与比对表。
 *
 * 为什么判据不写死数字：每份 fixture 的期望读数来自同目录的 `expect.json`，而 `expect.json`
 * 由 `build-fixtures.mjs` **从源包直接统计**得出（不调用任何实现）——这样「实现自证」不成立。
 * 本脚本只做逐格比对，任何一格不等即 `MISMATCH` + EXIT≠0（02 §六.5：只打印「全绿」不算证据）。
 *
 * 用法：
 *   node scripts/verify-ai-import.mjs                # 全量
 *   node scripts/verify-ai-import.mjs --source-only  # 只跑静态段（不编译 Rust）
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "scripts", "fixtures", "ai-import");
const sourceOnly = process.argv.includes("--source-only");

let failed = false;
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  failed = true;
};
const ok = (message) => console.log(`  ok   ${message}`);
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${label} = ${a}`);
  else fail(`${label} 实测 ${a}，期望 ${e}`);
};

const fixture = (name) => path.join(fixtureDir, name);
const readJson = (name) => JSON.parse(readFileSync(fixture(name), "utf8"));

// ───────────────────────── 1. 静态段：fixture 齐备性与「零新依赖」 ─────────────────────────
console.log("\n── 1. 静态段 ──");

const POSITIVE = ["careful", "long", "cloze"];
for (const name of POSITIVE) {
  for (const suffix of ["text.txt", "payload.json", "expect.json"]) {
    const file = fixture(`${name}.${suffix}`);
    if (!existsSync(file)) fail(`缺少 fixture：${name}.${suffix}`);
    else if (statSync(file).size <= 0) fail(`fixture 是空壳：${name}.${suffix}`);
  }
}
ok("三题型正例 9 个文件齐备且非空");

/** 02 §六.4 表：18 组 / 19 个文件（R2 的 ⑥ 已并入；重号与 cloze 缺 questions 各 1 份） */
const NEGATIVE = [
  "bad-type-long-with-options.payload.json",
  "bad-type-careful-3options.payload.json",
  "bad-type-cloze-14options.payload.json",
  "bad-type-cloze-blanknos.payload.json",
  "bad-type-cloze-dupno.payload.json",
  "bad-section-mismatch.payload.json",
  "bad-section-invalid.payload.json",
  "bad-markup-unbalanced.payload.json",
  "bad-payload-notjson.txt",
  "fenced-with-prose.payload.txt",
  "renumbered.payload.json",
  "no-match.payload.json",
  "partial-20.payload.json",
  "answer-out-of-options.payload.json",
  "lexicon-word-absent.payload.json",
  "blank-distractors-string.payload.json",
  "cloze-no-questions.payload.json",
  "long-batch1.payload.json",
  "long-batch2.payload.json",
];
for (const name of NEGATIVE) {
  if (!existsSync(fixture(name))) fail(`缺少 fixture：${name}`);
}
eq("反例与边界 fixture 数（02 §六.4：18 组 / 19 文件）", NEGATIVE.length, 19);

const allFixtureFiles = readdirSync(fixtureDir);
eq("fixture 目录总文件数（1 派生脚本 + 9 正例 + 19 反例 = 29）", allFixtureFiles.length, 29);
eq("数据文件数（不含派生脚本）", allFixtureFiles.filter((name) => name !== "build-fixtures.mjs").length, 28);

// lexiconShape 自检：派生脚本漏做 map→数组转换时立刻失败（§六.3）
for (const name of POSITIVE) {
  const expect = readJson(`${name}.expect.json`);
  const payload = readJson(`${name}.payload.json`);
  eq(`${name}.expect.lexiconShape`, expect.lexiconShape, "array");
  if (!Array.isArray(payload.lexicon)) fail(`${name}.payload.json 的 lexicon 不是数组（派生脚本漏做 §六.1③）`);
  else ok(`${name}.payload.json 的 lexicon 是数组（${payload.lexicon.length} 项）`);
}

const cargo = readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
for (const section of ["dependencies", "dev-dependencies"]) {
  const block = cargo.split(`[${section}]`)[1]?.split("\n[")[0] ?? "";
  for (const line of block.split(/\r?\n/)) {
    const name = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (!name) continue;
    if (!["tauri", "serde", "serde_json", "rusqlite", "sha2"].includes(name)) {
      fail(`Cargo.toml 的 [${section}] 新增了依赖 ${name}（02 三问③ 禁止）`);
    }
  }
}
ok("Cargo.toml 未新增依赖（仍为 tauri / serde / serde_json / rusqlite / sha2）");
if (!/\[\[bin\]\]\s*\nname\s*=\s*"ai_import_cli"/.test(cargo)) fail("Cargo.toml 缺少 [[bin]] ai_import_cli");
else ok("Cargo.toml 已注册 [[bin]] ai_import_cli");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
eq("package.json 有 verify:ai-import", pkg.scripts["verify:ai-import"], "node scripts/verify-ai-import.mjs");

// 禁用项自检：不得出现外部 AI API / 网络
const aiSource = readFileSync(path.join(root, "src-tauri", "src", "ai_import.rs"), "utf8");
for (const word of ["reqwest", "TcpStream", "https://api.", "openai", "anthropic"]) {
  if (aiSource.includes(word)) fail(`ai_import.rs 出现了被禁的网络/AI 依赖线索：${word}`);
}
ok("ai_import.rs 无网络/AI API 调用（不联网、不带 key）");

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "judou-ai-import-"));
if (sourceOnly) {
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(failed ? "\n[--source-only] 静态段有 FAIL" : "\n[--source-only] 静态段全绿（红端自证门禁是活的）");
  process.exit(failed ? 1 : 0);
}

// ───────────────────────── 2. 编译 bin（一次），之后直接跑 exe ─────────────────────────
console.log("\n── 2. 构建 ai_import_cli（唯一执行通道）──");
if (!existsSync(path.join(root, "src-tauri", "src", "bin", "ai_import_cli.rs"))) {
  fail("缺少 src-tauri/src/bin/ai_import_cli.rs（门禁契约未落地）");
  process.exit(1);
}
execFileSync("cargo", ["build", "--offline", "--quiet", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--bin", "ai_import_cli"], {
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 64 * 1024 * 1024,
});
const exe = path.join(root, "src-tauri", "target", "debug", process.platform === "win32" ? "ai_import_cli.exe" : "ai_import_cli");
if (!existsSync(exe)) {
  fail(`未找到 ai_import_cli 可执行文件：${exe}`);
  process.exit(1);
}
ok(`ai_import_cli 已构建：${path.relative(root, exe)}`);

const runCli = (args) => {
  const stdout = execFileSync(exe, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = stdout
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.startsWith("{"))
    .pop();
  if (!line) throw new Error(`ai_import_cli 未输出 JSON（前 200 字：${stdout.slice(0, 200)}）`);
  return JSON.parse(line);
};

let caseIndex = 0;
const freshDb = () => path.join(tempRoot, `case-${(caseIndex += 1)}.db`);
const commit = ({ section, text, payload, db }) =>
  runCli(["--commit", "--section", section, "--text", fixture(text), "--payload", fixture(payload), "--db", db]);
const dump = (db, articleId) => runCli(["--dump", "--article", String(articleId), "--db", db]);
const patch = ({ db, articleId, payload, section }) =>
  runCli(["--patch", "--article", String(articleId), "--payload", fixture(payload), "--db", db, ...(section ? ["--section", section] : [])]);

const openDb = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

// ───────────────────────── 3. 三题型正例 + §六.5 真读数比对表 ─────────────────────────
console.log("\n── 3. 三题型正例（AC10：逐格比对 §六.5 表）──");

const positiveReports = {};
for (const name of POSITIVE) {
  const expect = readJson(`${name}.expect.json`);
  const db = freshDb();
  const report = commit({ section: expect.section, text: `${name}.text.txt`, payload: `${name}.payload.json`, db });
  if (!report.ok) {
    fail(`${name} 正例被拒：${report.code} ${report.path ?? ""} ${report.message ?? ""}`);
    continue;
  }
  const counts = dump(db, report.articleId);
  if (!counts.ok) {
    fail(`${name} --dump 失败：${counts.code}`);
    continue;
  }
  positiveReports[name] = { expect, report, counts, db };

  // 解析覆盖率 / 题目覆盖率 / 逐空覆盖率 / 词条 逐格对 expect.json
  eq(`${name} 解析覆盖率`, report.coverage.analysis, expect.expectedCoverage.analysis);
  eq(`${name} 题目覆盖率`, report.coverage.questions, expect.expectedCoverage.questions);
  eq(`${name} 逐空覆盖率`, report.coverage.blanks, expect.expectedCoverage.blanks);
  eq(`${name} 词条数`, report.lexiconInserted, expect.lexicon);
  eq(`${name} unmatched 句数`, report.unmatched.length, 0);
  eq(`${name} unmatched 词条数`, report.unmatchedLexicon.length, 0);
  // 结构读数：段/句必须与源包统计相等（App 自己切的结构 == 源包结构）
  eq(`${name} 段落数（源包统计 vs 库）`, counts.paragraphs, expect.paragraphs);
  eq(`${name} 句数（源包统计 vs 库）`, counts.sentences, expect.sentences);
  eq(`${name} 题目行数`, counts.questions, expect.questions);
  eq(`${name} 逐空行数`, counts.blanks, expect.blanks);
  eq(`${name} 解析行数`, counts.analyses, expect.sentences);
}

// §六.5 比对表（逐 fixture 打印真读数）
console.log("\n── §6.5 真读数比对表（每列与 expect.json 逐项相等才 EXIT=0）──");
const header = ["fixture", "section", "段", "句", "解析覆盖率", "题目覆盖率", "逐空覆盖率", "词条", "lexiconShape"];
const rows = [header];
for (const name of POSITIVE) {
  const entry = positiveReports[name];
  if (!entry) {
    rows.push([name, "MISSING", "-", "-", "-", "-", "-", "-", "-"]);
    continue;
  }
  rows.push([
    name,
    entry.expect.section,
    String(entry.expect.paragraphs),
    String(entry.expect.sentences),
    entry.report.coverage.analysis,
    entry.report.coverage.questions,
    entry.report.coverage.blanks,
    String(entry.report.lexiconInserted),
    entry.expect.lexiconShape,
  ]);
}
const widths = header.map((_, column) => Math.max(...rows.map((row) => [...row[column]].length)));
const pad = (text, width) => `${text}${" ".repeat(Math.max(0, width - [...text].length))}`;
for (const row of rows) console.log(row.map((cell, column) => pad(cell, widths[column])).join("  "));

// 表格逐格自检（不靠人眼）
for (const name of POSITIVE) {
  const entry = positiveReports[name];
  if (!entry) continue;
  const row = rows.find((cells) => cells[0] === name);
  const want = [
    name,
    entry.expect.section,
    String(entry.expect.paragraphs),
    String(entry.expect.sentences),
    entry.expect.expectedCoverage.analysis,
    entry.expect.expectedCoverage.questions,
    entry.expect.expectedCoverage.blanks,
    String(entry.expect.lexicon),
    "array",
  ];
  if (JSON.stringify(row) !== JSON.stringify(want)) {
    fail(`§6.5 表 ${name} 行 MISMATCH：实测 ${JSON.stringify(row)}，期望 ${JSON.stringify(want)}`);
  } else {
    ok(`§6.5 表 ${name} 行逐格相等`);
  }
}

// ───────────────────────── 4. AC8：AI 的偏移一律忽略（切片自证） ─────────────────────────
console.log("\n── 4. AC8 偏移由 App 自算（库里逐句逐词切片相等）──");
{
  const entry = positiveReports.careful;
  if (!entry) {
    fail("AC8 无法验证：careful 正例未入库");
  } else {
    const db = openDb(entry.db);
    let sentenceChecked = 0;
    let tokenChecked = 0;
    let mismatch = 0;
    const paragraphs = db.prepare("SELECT id, text FROM paragraph WHERE article_id = ? ORDER BY idx").all(entry.report.articleId);
    const paragraphText = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
    const sentences = db
      .prepare("SELECT id, paragraph_id, text, start_offset, end_offset FROM sentence WHERE article_id = ? ORDER BY paragraph_id, idx")
      .all(entry.report.articleId);
    for (const sentence of sentences) {
      const source = paragraphText.get(sentence.paragraph_id) ?? "";
      if (source.slice(sentence.start_offset, sentence.end_offset) !== sentence.text) mismatch += 1;
      sentenceChecked += 1;
      const tokens = db
        .prepare("SELECT surface, start_offset, end_offset FROM token WHERE sentence_id = ? ORDER BY idx")
        .all(sentence.id);
      for (const token of tokens) {
        if (sentence.text.slice(token.start_offset, token.end_offset) !== token.surface) mismatch += 1;
        tokenChecked += 1;
      }
    }
    db.close();
    eq("逐句切片不符数（paragraph.text.slice(start,end) === sentence.text）", mismatch, 0);
    eq("检查句数", sentenceChecked, entry.expect.sentences);
    ok(`逐词切片全部相等（共 ${tokenChecked} 个 token）`);
  }
}

// ───────────────── 4b. R1：question.idx 必须是试卷题号（不是批内下标） ─────────────────
console.log("\n── 4b. R1 题号语义：question.idx = payload questions[].no（与 blank_no 同源）──");
for (const name of ["careful", "cloze"]) {
  const entry = positiveReports[name];
  if (!entry) {
    fail(`R1 无法验证：${name} 正例未入库`);
    continue;
  }
  const payload = readJson(`${name}.payload.json`);
  const wantNos = payload.questions.map((question) => question.no).sort((a, b) => a - b);
  const db = openDb(entry.db);
  const gotIdx = db
    .prepare("SELECT idx FROM question WHERE article_id = ? ORDER BY idx")
    .all(entry.report.articleId)
    .map((row) => row.idx);
  const gotBlank = db
    .prepare("SELECT blank_no FROM blank WHERE article_id = ? ORDER BY blank_no")
    .all(entry.report.articleId)
    .map((row) => row.blank_no);
  db.close();
  eq(`${name} question.idx 集合（= payload questions[].no）`, gotIdx, wantNos);
  eq(`${name} question.idx 不含批内下标 0`, gotIdx.includes(0), false);
  if (name === "cloze") {
    eq("cloze blank.blank_no 集合（与 question.idx 同源）", gotBlank, gotIdx);
  }
}

// ───────────────────────── 5. AC12：只写 8 张内容表，用户表零触碰 ─────────────────────────
console.log("\n── 5. AC12 写入面 = 8 张内容表（19 表快照前后比对）──");
const ALL_TABLES = [
  "article",
  "paragraph",
  "sentence",
  "token",
  "question",
  "blank",
  "sentence_analysis",
  "token_analysis",
  "lexicon",
  "sentence_note",
  "word_note",
  "vocab_entry",
  "tag",
  "vocab_tag",
  "review_plan",
  "review_log",
  "reading_record",
  "app_setting",
  "schema_meta",
];
const snapshotCounts = (dbPath) => {
  const db = openDb(dbPath);
  const out = {};
  for (const table of ALL_TABLES) out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  db.close();
  return out;
};
const snapshotUserContent = (dbPath) => {
  const db = openDb(dbPath);
  const out = {};
  for (const table of ["sentence_note", "word_note", "vocab_entry", "tag", "vocab_tag", "review_plan", "review_log", "reading_record"]) {
    out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  db.close();
  return out;
};
{
  const db = freshDb();
  // 先让 bin 建库（--dump 对空库只返回 0 行读数），再取「写入前」快照
  const seed = runCli(["--dump", "--article", "1", "--db", db]);
  if (!seed.ok) fail(`AC12 建库失败：${seed.code}`);
  const before = snapshotCounts(db);
  const report = commit({ section: "careful", text: "careful.text.txt", payload: "careful.payload.json", db });
  if (!report.ok) fail(`AC12 的 careful 入库失败：${report.code}`);
  const after = snapshotCounts(db);
  const allowed = new Set(["article", "paragraph", "sentence", "token", "sentence_analysis", "question", "lexicon", "blank"]);
  const changed = ALL_TABLES.filter((table) => before[table] !== after[table]);
  const unexpected = changed.filter((table) => !allowed.has(table));
  eq("被写入的表", changed.sort(), [...allowed].filter((table) => before[table] !== after[table]).sort());
  eq("越界写入的表（必须是空）", unexpected, []);
  eq("8 张用户表行数变化（含 tag/vocab_tag）", [after.sentence_note, after.word_note, after.vocab_entry, after.tag, after.vocab_tag, after.review_plan, after.review_log, after.reading_record], [0, 0, 0, 0, 0, 0, 0, 0]);
  rmSync(db, { force: true });
}

// ───────────────────────── 6. 反例与边界（逐条 EXIT + 关键行） ─────────────────────────
console.log("\n── 6. 反例与边界（02 §六.4：18 组 / 19 文件）──");

/** 每条：`want` = 'ok' 表示应通过，其余为期望错误码；`path` 为期望 path；`check` 附加断言 */
const CASES = [
  { name: "bad-type-long-with-options", file: "bad-type-long-with-options.payload.json", text: "long.text.txt", section: "long", want: "AI_TYPE_MISMATCH", path: "questions[0].options" },
  { name: "bad-type-careful-3options", file: "bad-type-careful-3options.payload.json", text: "careful.text.txt", section: "careful", want: "AI_TYPE_MISMATCH", path: "questions[0].options" },
  { name: "bad-type-cloze-14options", file: "bad-type-cloze-14options.payload.json", text: "cloze.text.txt", section: "cloze", want: "AI_TYPE_MISMATCH", path: "questions[0].options" },
  { name: "bad-type-cloze-blanknos", file: "bad-type-cloze-blanknos.payload.json", text: "cloze.text.txt", section: "cloze", want: "AI_TYPE_MISMATCH", path: "blankAnalyses" },
  { name: "bad-type-cloze-dupno", file: "bad-type-cloze-dupno.payload.json", text: "cloze.text.txt", section: "cloze", want: "AI_TYPE_MISMATCH", path: "blankAnalyses" },
  { name: "cloze-no-questions", file: "cloze-no-questions.payload.json", text: "cloze.text.txt", section: "cloze", want: "ok", check: (report, db) => {
    eq("AC7④ 缺省：逐空写入 10 行", report.blanksWritten, 10);
    eq("AC7④ 缺省：逐空覆盖率只显示已解析数 k", report.coverage.blanks, "10");
    eq("AC7④ 缺省：题目覆盖率显示 -", report.coverage.questions, "-");
    const conn = openDb(db);
    eq("AC7④ 缺省：不放行题目行（无 questions → 0 行）", conn.prepare("SELECT COUNT(*) AS n FROM question WHERE article_id = ?").get(report.articleId).n, 0);
    conn.close();
  } },
  { name: "bad-section-mismatch", file: "bad-section-mismatch.payload.json", text: "careful.text.txt", section: "careful", want: "AI_TYPE_MISMATCH", path: "section" },
  { name: "bad-section-invalid", file: "bad-section-invalid.payload.json", text: "careful.text.txt", section: "careful", want: "AI_TYPE_MISMATCH", path: "section" },
  { name: "bad-markup-unbalanced", file: "bad-markup-unbalanced.payload.json", text: "careful.text.txt", section: "careful", want: "AI_MARKUP_UNBALANCED", path: "sentences[0].analysis.structMarkup" },
  { name: "bad-payload-notjson", file: "bad-payload-notjson.txt", text: "careful.text.txt", section: "careful", want: "AI_PAYLOAD_INVALID", path: "payload" },
  { name: "no-match", file: "no-match.payload.json", text: "careful.text.txt", section: "careful", want: "AI_NO_MATCH", path: "sentences" },
  { name: "fenced-with-prose", file: "fenced-with-prose.payload.txt", text: "careful.text.txt", section: "careful", want: "ok", check: (report) => { eq("AC13 已忽略说明文字字符数 > 0", report.ignoredChars > 0, true); } },
  { name: "renumbered", file: "renumbered.payload.json", text: "careful.text.txt", section: "careful", want: "ok", check: (report) => eq("AC18 编号已纠正条数", report.snoFixed, 1) },
  { name: "partial-20", file: "partial-20.payload.json", text: "long.text.txt", section: "long", want: "ok", check: (report) => eq("AC4 覆盖率 20/M（M = long 句数，见 long.expect.json）", report.coverage.analysis, `20/${readJson("long.expect.json").sentences}`) },
  { name: "answer-out-of-options", file: "answer-out-of-options.payload.json", text: "careful.text.txt", section: "careful", want: "ok", check: (report) => eq("AC16 缺答案题数", report.missingAnswer, 1) },
  { name: "lexicon-word-absent", file: "lexicon-word-absent.payload.json", text: "careful.text.txt", section: "careful", want: "ok", check: (report) => {
    eq("AC15 进 unmatched 的词条数", report.unmatchedLexicon.length, 1);
    eq("AC15 unmatched 词条", report.unmatchedLexicon[0]?.word, "zebrafish");
    eq("AC15 词条数（不含缺席词）= 源包 102 条", report.lexiconInserted, readJson("careful.expect.json").lexicon);
  } },
  { name: "blank-distractors-string", file: "blank-distractors-string.payload.json", text: "cloze.text.txt", section: "cloze", want: "ok", check: (report) => eq("§三.4 逐空行数（10 条）", report.blanksWritten, 10) },
];

const exitRows = [];
for (const item of CASES) {
  const db = freshDb();
  const report = commit({ section: item.section, text: item.text, payload: item.file, db });
  const got = report.ok ? "ok" : report.code;
  exitRows.push([item.name, item.section, item.want, got, report.ok ? "-" : (report.path ?? "-")]);
  if (got !== item.want) fail(`${item.name} 实测 ${got}（${report.message ?? ""}），期望 ${item.want}`);
  else ok(`${item.name} → ${got}${report.ok ? "" : ` path=${report.path}`}`);
  if (item.path && !report.ok) eq(`${item.name} path`, report.path, item.path);
  if (report.ok && item.check) item.check(report, db);
  // 反例必须证明「库里没留下半套数据」（拒收即零写入）
  if (!report.ok) {
    const counts = snapshotCounts(db);
    eq(`${item.name} 拒收后 article 行数`, counts.article, 0);
    eq(`${item.name} 拒收后 sentence 行数`, counts.sentence, 0);
    eq(`${item.name} 拒收后 sentence_analysis 行数`, counts.sentence_analysis, 0);
  }
  rmSync(db, { force: true });
}

console.log("\n── 反例与边界逐条 EXIT 表 ──");
const caseHeader = ["fixture", "section", "期望", "实测", "path"];
const caseWidths = caseHeader.map((_, column) => Math.max(...exitRows.map((row) => [...row[column]].length), [...caseHeader[column]].length));
console.log(caseHeader.map((cell, column) => pad(cell, caseWidths[column])).join("  "));
for (const row of exitRows) console.log(row.map((cell, column) => pad(cell, caseWidths[column])).join("  "));

// ───────────────────────── 7. AC9：后补解析（累加 + 三结构表不变 + 用户表不变 + 词条不重复） ─────────────────────────
console.log("\n── 7. AC9 后补解析（long-batch1 前 15 句 → patch long-batch2 余下句）──");
{
  const longExpect = readJson("long.expect.json");
  const total = longExpect.sentences;
  const db = freshDb();
  const first = commit({ section: "long", text: "long.text.txt", payload: "long-batch1.payload.json", db });
  if (!first.ok) {
    fail(`AC9 第一批入库失败：${first.code} ${first.message ?? ""}`);
  } else {
    eq("第一批覆盖率", first.coverage.analysis, `15/${total}`);
    const before = dump(db, first.articleId);
    const userBefore = snapshotUserContent(db);

    // 造 8 张用户表的各一行（真引用本篇文章的句/词），验证补解析不动它们
    {
      const conn = openDb(db);
      const sentence = conn.prepare("SELECT id FROM sentence WHERE article_id = ? ORDER BY id LIMIT 1").get(first.articleId);
      const token = conn.prepare("SELECT t.id FROM token t JOIN sentence s ON s.id = t.sentence_id WHERE s.article_id = ? AND t.is_word = 1 ORDER BY t.id LIMIT 1").get(first.articleId);
      conn.prepare("INSERT INTO sentence_note (sentence_id, translation, grammar_note, phrase_note, updated_at) VALUES (?, '译', '语', '短', datetime('now'))").run(sentence.id);
      conn.prepare("INSERT INTO word_note (token_id, context_meaning, collocation, example, updated_at) VALUES (?, '义', '搭', '例', datetime('now'))").run(token.id);
      const vocab = conn.prepare("INSERT INTO vocab_entry (normalized, surface, context_meaning, source_sentence_id, source_article_id) VALUES ('gateword', 'Gateword', '门禁词', ?, ?)").run(sentence.id, first.articleId);
      const tag = conn.prepare("INSERT INTO tag (name) VALUES ('门禁标签')").run();
      conn.prepare("INSERT INTO vocab_tag (vocab_id, tag_id) VALUES (?, ?)").run(vocab.lastInsertRowid, tag.lastInsertRowid);
      conn.prepare("INSERT INTO review_plan (article_id, next_review_at, interval_index, status, updated_at) VALUES (?, date('now'), 0, 'active', datetime('now'))").run(first.articleId);
      conn.prepare("INSERT INTO review_log (article_id, reviewed_at, interval_index, result) VALUES (?, datetime('now'), 0, 'done')").run(first.articleId);
      conn.prepare("INSERT INTO reading_record (article_id, last_position, duration_sec, completed, last_read_at) VALUES (?, '0-0', 12, 1, datetime('now'))").run(first.articleId);
      conn.close();
    }
    const userBeforeSeed = snapshotUserContent(db);

    const second = patch({ db, articleId: first.articleId, payload: "long-batch2.payload.json", section: "long" });
    if (!second.ok) {
      fail(`AC9 补解析失败：${second.code} ${second.message ?? ""}`);
    } else {
      const after = dump(db, first.articleId);
      eq(`补解析后解析行数（15 → ${total}）`, [before.analyses, after.analyses], [15, total]);
      eq("补解析后句数不变", after.sentences, before.sentences);
      eq("补解析后词数不变", after.tokens, before.tokens);
      eq("补解析后段落数不变", after.paragraphs, before.paragraphs);
      eq("补解析后三结构表内容哈希不变", after.structureHash, before.structureHash);
      eq("同批词条二次提交不新增行", second.lexiconInserted, 0);
      eq("本批补解析覆盖率（余下 31 句）", second.coverage.analysis, `${total - 15}/${total}`);
      eq(`补解析后文章累计覆盖 ${total}/${total}（= 解析行数 / 句数）`, [after.analyses, after.sentences], [total, total]);
      eq("8 张用户表行数与内容不变", snapshotUserContent(db), userBeforeSeed);
      eq("8 张用户表在造数后确实非空（否则上一条是空对空）", Object.values(userBeforeSeed).map((rows) => rows.length), [1, 1, 1, 1, 1, 1, 1, 1]);
      void userBefore;
    }
  }
  rmSync(db, { force: true });
}

// ═════════════ M5c D8：切分 / 三档提示词 / 档 C 一致性 / answer_source / 编辑命令（追加段） ═════════════
// 既有 1~7 段一条未改（M5b 契约向后兼容的证据）；本段只追加新能力的机械判据。
console.log("\n── 8. M5c：切分 / 三档提示词 / 档 C 一致 / answer_source / 编辑命令（D8 追加段）──");

const fullDir = path.join(root, "scripts", "fixtures", "ai-import-full");
const fullFixture = (name) => path.join(fullDir, name);
const stripWs = (text) => String(text ?? "").replace(/\s+/g, "");
const FULL_TYPES = ["careful", "long", "cloze"];

// 8.0 素材齐备性（缺一个就红，避免「空对空」）
for (const name of FULL_TYPES) {
  for (const suffix of ["full.txt", "questions.txt", "full.payload.json"]) {
    const file = fullFixture(`${name}.${suffix}`);
    if (!existsSync(file)) fail(`缺少一体化素材：${name}.${suffix}`);
    else if (statSync(file).size <= 0) fail(`一体化素材是空壳：${name}.${suffix}`);
  }
}
if (!existsSync(fullFixture("bad-question-stem.payload.json"))) fail("缺少一体化素材：bad-question-stem.payload.json");
ok("一体化素材 10 个文件齐备且非空（3 题型 × full/problems/payload + 1 反例）");

const splitOf = (file, start) =>
  runCli(["--split", "--text", file, ...(start === undefined ? [] : ["--start", String(start)])]);
const promptOf = (name, mode, withQuestions) =>
  runCli([
    "--prompt",
    "--section",
    name,
    "--text",
    fixture(`${name}.text.txt`),
    "--mode",
    mode,
    ...(withQuestions ? ["--questions", fullFixture(`${name}.questions.txt`)] : []),
  ]);

// 8.1 切分：含题目区 / 正文干净 / 手动纠正起点（AC3 + AC4 逃生口）
/**
 * 规则口径（02 §三.2 **v1.3 修订**，修 D-M5c-1）：候选行后 **5 个有效题行**内题号行 ≥2 才确认；
 * 「有效题行」＝非空行 − 选项行（A~Z）− 答案行。原口径「5 个原始行」对「题干 + 4 个分行选项」
 * 的真实卷面必然判 false（选项行占满窗口）——本轮起三种题型的 `.full.txt` **全部应自动识别**，
 * 起点都是题型标题行「Directions: …」。切不中时的「不猜」由 8.2 的反例断言守。
 */
const EXPECT_AUTO_DETECT = { careful: true, long: true, cloze: true };
for (const name of FULL_TYPES) {
  const raw = readFileSync(fullFixture(`${name}.full.txt`), "utf8");
  const lines = raw.split(/\r?\n/);
  const payload = JSON.parse(readFileSync(fullFixture(`${name}.full.payload.json`), "utf8"));
  const split = splitOf(fullFixture(`${name}.full.txt`));
  const expectDetected = EXPECT_AUTO_DETECT[name];
  // 期望起点 = 题型标题行「Directions: …」的 1-based 行号（最靠前候选）
  const directionsLine = lines.findIndex((line) => /^Directions:/i.test(line.trim())) + 1;
  eq(`${name} 自动切分 detected（v1.3 口径：跳过空行/选项行/答案行）`, split.detected, expectDetected);
  if (expectDetected) {
    eq(`${name} 自动切分题数 K（= 素材题目数）`, split.questionCount, payload.questions.length);
    eq(`${name} 自动切分起点 = 题型标题行`, split.questionStartLine ?? null, directionsLine);
    const bodyHasQuestionLine = split.bodyText.split(/\r?\n/).some((line) => /^\s*\d{1,3}\s*[.、．)]\s*\S/.test(line));
    eq(`${name} 正文里没有题号行（否则题目会被当正文解析）`, bodyHasQuestionLine, false);
    eq(`${name} 题目区首行 = Directions`, split.questionText.trim().split(/\r?\n/)[0].trim(), "Directions: Read the passage and answer the questions below.");
  } else {
    // 切不中必须「不猜」：题目区空串、K=0、起点为 null
    eq(`${name} 切不中时 questionText 为空串（不猜）`, split.questionText, "");
    eq(`${name} 切不中时 questionCount`, split.questionCount, 0);
    eq(`${name} 切不中时 questionStartLine`, split.questionStartLine ?? null, null);
  }
  eq(`${name} 原文去空白 = 正文+题目区去空白（切分不丢字）`, stripWs(`${split.bodyText}${split.questionText}`) === stripWs(raw), true);

  // 手动纠正：用户手动标记题目区起点（1-based）时，切分必须接受这个起点
  const firstNo = lines.findIndex((line) => /^\s*\d{1,3}\s*[.、．)]\s*\S/.test(line)) + 1;
  const manual = splitOf(fullFixture(`${name}.full.txt`), firstNo);
  eq(`${name} 手动纠正 questionStartLine`, manual.questionStartLine, firstNo);
  eq(`${name} 手动纠正 body = 起点之前的原文`, stripWs(manual.bodyText), stripWs(lines.slice(0, firstNo - 1).join("\n")));
  eq(`${name} 手动纠正 questionText 从题号行起`, stripWs(manual.questionText), stripWs(lines.slice(firstNo - 1).join("\n")));
}

// 8.2 切分无误判：正文里孤立的数字行不构成题目区（AC4）
{
  const silent = path.join(tempRoot, "split-no-false-positive.txt");
  writeFileSync(
    silent,
    "She graduated in 2024 from a small college.\n\n2024.\n\nThe passage ends here without any questions.\n",
    "utf8",
  );
  const split = splitOf(silent);
  eq("正文含孤立数字行时 detected", split.detected, false);
  eq("未识别时 questionText 为空串", split.questionText, "");
  eq("未识别时 questionCount", split.questionCount, 0);
  eq("未识别时 questionStartLine 为 null", split.questionStartLine ?? null, null);
}

// 8.3 三档提示词：正文与题目区的包含关系（AC5 / AC6 / AC2）
{
  const bodyOf = (name) => readFileSync(fixture(`${name}.text.txt`), "utf8");
  const questionsOf = (name) => readFileSync(fullFixture(`${name}.questions.txt`), "utf8");
  for (const name of FULL_TYPES) {
    const body = stripWs(bodyOf(name));
    const questions = stripWs(questionsOf(name));
    const full = promptOf(name, "full", true);
    const analysis = promptOf(name, "analysis", false);
    const plain = promptOf(name, "plain", false);
    if (!full.ok || !analysis.ok || !plain.ok) {
      fail(`${name} 生成提示词失败：${full.code ?? ""}${analysis.code ?? ""}${plain.code ?? ""}`);
      continue;
    }
    eq(`${name} 档 C 提示词含正文全文（去空白后逐字包含）`, stripWs(full.text).includes(body), true);
    eq(`${name} 档 C 提示词含题目区全文`, stripWs(full.text).includes(questions), true);
    eq(`${name} 档 B 提示词含正文全文`, stripWs(analysis.text).includes(body), true);
    eq(`${name} 档 B 提示词不含题目区（AC6）`, stripWs(analysis.text).includes(questions), false);
    eq(`${name} 档 A 提示词不要求解析字段（无 sentences[]）`, plain.text.includes("sentences[]"), false);
    eq(`${name} 档 A 提示词不要求 structMarkup`, plain.text.includes("structMarkup"), false);
  }
  // 档 C 的题目区注入是**原文**而非摘要：抽样比对一道题干原文
  const sample = JSON.parse(readFileSync(fullFixture("careful.full.payload.json"), "utf8")).questions[0].stem;
  const fullCareful = promptOf("careful", "full", true);
  eq("档 C 提示词含第一道题的题干原文", stripWs(fullCareful.text).includes(stripWs(sample)), true);
}

// 8.4 档 A：空 matched 也必须能入库（不要求解析不等于不许入库）
{
  const plainPayload = path.join(tempRoot, "plain-empty.payload.json");
  writeFileSync(plainPayload, JSON.stringify({ section: "careful", sentences: [] }), "utf8");
  const db = freshDb();
  const report = runCli([
    "--commit",
    "--section",
    "careful",
    "--text",
    fixture("careful.text.txt"),
    "--payload",
    plainPayload,
    "--db",
    db,
    "--mode",
    "plain",
  ]);
  eq("档 A 空 matched 入库 ok", report.ok, true);
  eq("档 A 空 matched 解析覆盖率 0/N", report.coverage?.analysis, `0/${readJson("careful.expect.json").sentences}`);
  eq("档 A 空 matched 题目覆盖率", report.coverage?.questions, "-");
  eq("档 A 空 matched 不写解析行", runCli(["--dump", "--article", String(report.articleId ?? 1), "--db", db]).analyses, 0);
  rmSync(db, { force: true });
}

// 8.5 档 C 反例：题干被改写 → AI_QUESTION_MISMATCH（经 CLI 走一遍，不是只有单测）
{
  const db = freshDb();
  const report = runCli([
    "--commit",
    "--section",
    "careful",
    "--text",
    fixture("careful.text.txt"),
    "--payload",
    fullFixture("bad-question-stem.payload.json"),
    "--db",
    db,
    "--mode",
    "full",
    "--questions",
    fullFixture("careful.questions.txt"),
  ]);
  eq("档 C 题干被改写 → 错误码", report.ok ? "ok" : report.code, "AI_QUESTION_MISMATCH");
  eq("档 C 题干被改写 → path", report.path, "questions[0].stem");
  eq("档 C 题干被改写 → 库里零写入", snapshotCounts(db).article, 0);
  rmSync(db, { force: true });
}

// 8.6 answer_source 三值：commit 路径 user / patch 路径 ai / 无答案 none
{
  const db = freshDb();
  const commitReport = runCli([
    "--commit",
    "--section",
    "careful",
    "--text",
    fixture("careful.text.txt"),
    "--payload",
    fullFixture("careful.full.payload.json"),
    "--db",
    db,
    "--mode",
    "full",
    "--questions",
    fullFixture("careful.questions.txt"),
  ]);
  eq("一体化素材（档 C）入库 ok", commitReport.ok, true);
  const first = runCli(["--dump-questions", "--article", String(commitReport.articleId), "--db", db]).questions ?? [];
  eq("commit 路径：带答案的题全部 answerSource=user", [...new Set(first.filter((q) => q.answer).map((q) => q.answerSource))], ["user"]);
  eq("commit 路径：题数与素材一致", first.length, JSON.parse(readFileSync(fullFixture("careful.full.payload.json"), "utf8")).questions.length);

  // patch 路径：无题目区 → AI 补答案 → ai；把第 1 题答案清空 → none
  const patchPayload = path.join(tempRoot, "patch-answer-source.payload.json");
  const base = readJson("careful.payload.json");
  base.questions[0].answer = null;
  writeFileSync(patchPayload, JSON.stringify(base), "utf8");
  const patchReport = runCli(["--patch", "--article", String(commitReport.articleId), "--payload", patchPayload, "--db", db, "--section", "careful", "--mode", "analysis"]);
  eq("patch 路径（第二批）ok", patchReport.ok, true);
  const second = runCli(["--dump-questions", "--article", String(commitReport.articleId), "--db", db]).questions ?? [];
  eq("patch 路径：AI 补的答案 answerSource=ai", second.filter((q) => q.answer).map((q) => q.answerSource).every((source) => source === "ai"), true);
  eq("patch 路径：清空答案的题 answerSource=none", second.find((q) => q.no === base.questions[0].no)?.answerSource, "none");
  rmSync(db, { force: true });
}

// 8.7 编辑命令：改元信息 / 改题目后三结构表哈希不变（AC9 / AC10 的库层判据）
{
  const db = freshDb();
  const report = commit({ section: "careful", text: "careful.text.txt", payload: "careful.payload.json", db });
  if (!report.ok) fail(`8.7 入库失败：${report.code}`);
  const before = runCli(["--dump", "--article", String(report.articleId), "--db", db]);

  const meta = runCli(["--meta", "--article", String(report.articleId), "--db", db, "--title", "门禁改过的标题", "--exam-year", "2025"]);
  eq("编辑元信息 ok", meta.ok, true);
  const afterMeta = runCli(["--dump", "--article", String(report.articleId), "--db", db]);
  eq("改标题后三结构表内容哈希不变", afterMeta.structureHash, before.structureHash);
  eq("改标题后解析行数不变", afterMeta.analyses, before.analyses);
  const conn = openDb(db);
  const row = conn.prepare("SELECT title, exam_year FROM article WHERE id = ?").get(report.articleId);
  conn.close();
  eq("标题真的改了（否则上一条是空对空）", [row.title, row.exam_year], ["门禁改过的标题", 2025]);

  // 改题目：题干改写一处 → 只写 question 表，三结构表哈希不变
  const questions = runCli(["--dump-questions", "--article", String(report.articleId), "--db", db]).questions ?? [];
  eq("读题目：行数与库一致", questions.length, before.questions);
  const edited = questions.map((question, index) => (index === 0 ? { ...question, stem: `${question.stem}（用户改过）` } : question));
  const editedPath = path.join(tempRoot, "edited-questions.json");
  writeFileSync(editedPath, JSON.stringify(edited), "utf8");
  const setReport = runCli(["--set-questions", "--article", String(report.articleId), "--db", db, "--payload", editedPath]);
  eq("整批替换题目 ok", setReport.ok, true);
  const afterSet = runCli(["--dump", "--article", String(report.articleId), "--db", db]);
  eq("改题目后三结构表内容哈希不变", afterSet.structureHash, before.structureHash);
  eq("改题目后题目行数不变", afterSet.questions, before.questions);
  eq("改题目后解析行数不变", afterSet.analyses, before.analyses);
  const afterQuestions = runCli(["--dump-questions", "--article", String(report.articleId), "--db", db]).questions ?? [];
  eq("题干真的改了", afterQuestions[0]?.stem, `${questions[0].stem}（用户改过）`);
  eq("answer_source 原样保留", afterQuestions[0]?.answerSource, questions[0].answerSource);
  rmSync(db, { force: true });
}

// ───────────────────── 8.8 M5c 优化轮 AC5：suggest_section 三推断 + 不敢猜 ─────────────────────
// 实测根因：选了「仔细阅读」却粘长篇卷面 → AI_TYPE_MISMATCH，而界面看起来「没反应」。
// 本段只验**推断读数**；「必须用户点确认、无自动切换路径」由代码审查复核（门禁没有 UI 层）。
console.log("\n── 8.8 suggest_section（AC1 / AC5） ──");

const suggestOf = (file) => {
  const report = runCli(["--suggest", "--payload", fixture(file)]);
  if (report.ok !== true) fail(`suggest(${file}) 未返回 ok：${report.code ?? "?"}`);
  return report.section ?? null;
};

eq("正例 careful.payload.json → careful", suggestOf("careful.payload.json"), "careful");
eq("正例 long.payload.json → long（空选项 + 段落字母）", suggestOf("long.payload.json"), "long");
eq("正例 cloze.payload.json → cloze（15 项）", suggestOf("cloze.payload.json"), "cloze");
// 规则是「任一题 4 项 → careful」：个别残缺题不否决整体建议（用户真实数据常有半截题）
eq("bad-type-careful-3options（个别 3 项，其余 4 项）→ careful", suggestOf("bad-type-careful-3options.payload.json"), "careful");

// 全部题都是 3 项（既非 4 也非 15、也不是空选项）→ 结构上无可判形态，必须 null
const oddPayload = path.join(tempRoot, "suggest-odd-3options.json");
writeFileSync(
  oddPayload,
  JSON.stringify({
    section: "careful",
    sentences: [],
    questions: [{ no: 46, stem: "s", options: [{ key: "A", text: "a" }, { key: "B", text: "b" }, { key: "C", text: "c" }], answer: "A" }],
  }),
  "utf8",
);
const oddReport = runCli(["--suggest", "--payload", oddPayload]);
eq("全部 3 项 → 不敢猜 null", oddReport.ok === true ? oddReport.section ?? null : `不 ok：${oddReport.code}`, null);
eq("cloze-no-questions（无 questions）→ 不敢猜 null", suggestOf("cloze-no-questions.payload.json"), null);

// AC2/AC3/AC4 的入口存在性（静态判据：缺按钮/缺守卫/缺强调，用户就没有「下一步」可点）
const importSource = readFileSync(path.join(root, "src", "pages", "Import.tsx"), "utf8");
if (!importSource.includes("data-section-suggest")) fail("导入页缺少 data-section-suggest 按钮（AC2/AC3 无入口）");
ok("导入页有 data-section-suggest 切换按钮");
if (!/error\.suggestion\s*\?/.test(importSource)) fail("建议块未受 error.suggestion 守卫（可能无条件显示建议）");
ok("建议块受 error.suggestion 守卫（不是无条件显示）");
if (!/import-error-strong/.test(importSource)) fail("错误卡片缺少置顶视觉强调类（AC4）");
ok("错误卡片带 import-error-strong 强调类（AC4）");
// ───────────────── 8b. D-M5c-2：整卷多篇切分（真跑 CLI，不靠人眼） ─────────────────
const volumePath = path.join(tempRoot, "volume-4.txt");
writeFileSync(
  volumePath,
  [
    "Section A",
    "Directions: fill in the blanks.",
    "",
    "The market of the town changed.",
    "",
    "Section B",
    "Passage One",
    "Questions 46 to 50 are based on the following passage.",
    "",
    "Some long text one.",
    "",
    "Passage Two",
    "Some careful text two.",
    "",
    "Section C",
    "Passage Three",
    "Some careful text three.",
    "",
  ].join("\n"),
  "utf8",
);
const passagesOf = (file) => runCli(["--passages", "--text", file]);
const volumeReport = passagesOf(volumePath);
eq("整卷 4 篇 → 篇数 4（相邻小标题合并，不切空壳篇）", volumeReport.ok ? volumeReport.count : `不 ok：${volumeReport.code}`, 4);
eq("整卷 4 篇 → 首篇从文件头（第 1 行）起", volumeReport.ok ? volumeReport.passages[0].startLine : null, 1);
eq(
  "整卷 4 篇 → 篇序与起止行首尾相接",
  volumeReport.ok
    ? volumeReport.passages.map((span) => `${span.index}:${span.startLine}-${span.endLine}`).join(",")
    : "不 ok",
  "1:1-5,2:6-11,3:12-14,4:15-17",
);
const singleReport = passagesOf(fixture("careful.text.txt"));
eq("单篇原文 → 只有 1 篇（界面不渲染篇列表）", singleReport.ok ? singleReport.count : `不 ok：${singleReport.code}`, 1);
const emptyPath = path.join(tempRoot, "empty.txt");
writeFileSync(emptyPath, "  \n\n\t\n", "utf8");
eq("空输入 → 0 篇", passagesOf(emptyPath).count, 0);
// 误切防护：正文里的短语不是篇边界（AC4 点名的反例）
const trapPath = path.join(tempRoot, "trap.txt");
writeFileSync(
  trapPath,
  "Part of the reason is clear.\n\nSection of the market grew fast.\n\nQuestions remain.\n",
  "utf8",
);
eq("「Part of the reason / Section of the market」不误切", passagesOf(trapPath).count, 1);

// AC1/AC2 的入口存在性（静态判据：缺钩子，CDP 就点不到、审核员也无法取证）
for (const hook of ["data-passage-count", "data-passage-item", "data-passage-next", "data-passage-done"]) {
  if (!importSource.includes(hook)) fail(`导入页缺少 ${hook}（D-M5c-2 AC1/AC2 无入口）`);
  ok(`导入页有 ${hook}`);
}
if (!/passageSpans\.length\s*>\s*1/.test(importSource)) {
  fail("篇列表未受「>1 篇」守卫（单篇也会显示区域，违反 AC1）");
}
ok("篇列表受「>1 篇」守卫（单篇不渲染）");

// ───────────────────────── 9. 汇总 ─────────────────────────
rmSync(tempRoot, { recursive: true, force: true });
console.log("");
if (failed) {
  console.error("结论：FAIL —— 有断言未过（逐条见上）");
  process.exit(1);
}
console.log("结论：PASS —— AC7 六形态 / AC8 偏移自算 / AC9 累加与不动结构 / AC10 逐格比对 / AC12 写入面 / AC13 容错 / AC15 词条 / AC16 答案 / AC17 非法 JSON / AC18 编号 全部成立");
