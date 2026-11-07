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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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

// ───────────────────────── 8. 汇总 ─────────────────────────
rmSync(tempRoot, { recursive: true, force: true });
console.log("");
if (failed) {
  console.error("结论：FAIL —— 有断言未过（逐条见上）");
  process.exit(1);
}
console.log("结论：PASS —— AC7 六形态 / AC8 偏移自算 / AC9 累加与不动结构 / AC10 逐格比对 / AC12 写入面 / AC13 容错 / AC15 词条 / AC16 答案 / AC17 非法 JSON / AC18 编号 全部成立");
