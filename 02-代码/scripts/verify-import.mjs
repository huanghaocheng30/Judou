#!/usr/bin/env node
/**
 * AC3 / AC4 断言：只读打开运行期库，逐项核对导入结果。
 *
 * 判据（02 §四 AC4）：
 *   九表行数 12 / 90 / 274 / 6699 / 274 / 213 / 1561 / 30 / 90（顺序见 TABLE_KEYS）
 *   四项非空：question.answer 89/90 + 白名单 1 条（`KNOWN_EMPTY_ANSWERS`：set2Long/no=38，包内本身为 null）、
 *             question.explanation 30/30、
 *             lexicon.word 1561/1561、article.source 12/12 且唯一值 = CET-4 2023年12月真题
 *   article.pack_version 全等 manifest.packVersion；**篇内残留版本（2023-12-set1-v0.9）不得入库**
 *   MAX(id)/COUNT(*) 供幂等复查（删篇补回后 id 会变、count 不变）
 *
 * 用法：node scripts/verify-import.mjs [dbPath]
 *   缺省 = %APPDATA%\com.judou.app\judou.db（Tauri app_data_dir + identifier）
 *
 * ponytail: 直连 SQLite 读库比走 IPC 便宜两个数量级，也不需要起窗口；
 * 等出现「必须经过命令层的聚合」再补一条走 IPC 的断言（那属于 M2 的列表/统计）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "content-pack", "manifest.json");
const dbPath = process.argv[2] ?? path.join(process.env.APPDATA ?? "", "com.judou.app", "judou.db");

if (!existsSync(manifestPath)) {
  console.error(`FAIL: 内容包 manifest 不存在：${manifestPath}`);
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`FAIL: 库文件不存在（应用是否启动过？）：${dbPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const totals = manifest.totals;

/** 表名 → manifest.totals 里的键（顺序即报表顺序） */
const TABLE_KEYS = [
  ["article", "articles"],
  ["paragraph", "paragraphs"],
  ["sentence", "sentences"],
  ["token", "tokens"],
  ["sentence_analysis", "sentenceAnalysis"],
  ["token_analysis", "tokenAnalysis"],
  ["lexicon", "lexicon"],
  ["blank", "blanks"],
  ["question", "questions"],
];

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql, params = []) => db.prepare(sql).get(...params);
const count = (sql, params = []) => one(sql, params)?.c ?? 0;

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

console.log(`库路径: ${dbPath}`);
console.log(`内容包: packVersion=${manifest.packVersion}（${manifest.articles.length} 篇）`);

// ── 1. 九表行数逐项 ──
console.log("\n── 九表行数（实测 / 期望）──");
for (const [table, key] of TABLE_KEYS) {
  const actual = count(`SELECT COUNT(*) AS c FROM ${table}`);
  const expected = totals[key];
  const mark = actual === expected ? "ok" : "FAIL";
  console.log(`  ${mark.padEnd(4)} ${table.padEnd(18)} ${String(actual).padStart(5)} / ${expected}`);
  if (actual !== expected) fail(`${table} 行数 ${actual}，期望 ${expected}`);
}

// ── 2. 四项非空 ──
// **内容包事实例外（不是导入缺陷）**：`cet4-2023-12-set2Long.json` 的第 38 题 `answer` 为 `null`，
// 包内本来就没有这道信息匹配题的答案字母。导入侧**不补造事实**（AC4 的「90/90」按包的实际数据为 89/90）。
// 这里把例外写死：只允许这 1 条为空，任何新增的空答案都算 FAIL。
const KNOWN_EMPTY_ANSWERS = [{ sourceKey: "cet4-2023-12-set2Long", no: 38 }];
console.log("\n── 四项非空 ──");
const emptyAnswerRows = db
  .prepare(
    `SELECT a.source_key AS sourceKey, q.idx AS no
     FROM question q JOIN article a ON a.id = q.article_id
     WHERE q.answer IS NULL OR TRIM(q.answer) = ''
     ORDER BY a.source_key, q.idx`,
  )
  .all();
const answerTotal = count("SELECT COUNT(*) AS c FROM question");
const answerFilled = answerTotal - emptyAnswerRows.length;
const expectedFilled = 90 - KNOWN_EMPTY_ANSWERS.length;
console.log(
  `  question.answer 非空 ${answerFilled}/${answerTotal}（内容包事实期望 ${expectedFilled}/90：set2Long 第 38 题包内 answer=null）`,
);
if (answerFilled !== expectedFilled) fail(`question.answer 非空应为 ${expectedFilled}/90，实测 ${answerFilled}/${answerTotal}`);
const unexpectedEmpty = emptyAnswerRows.filter(
  (row) => !KNOWN_EMPTY_ANSWERS.some((known) => known.sourceKey === row.sourceKey && known.no === row.no),
);
if (unexpectedEmpty.length) fail(`出现计划外的空答案：${JSON.stringify(unexpectedEmpty)}`);

const explanationFilled = count(
  "SELECT COUNT(*) AS c FROM question WHERE explanation IS NOT NULL AND TRIM(explanation) <> ''",
);
console.log(`  question.explanation 非空 ${explanationFilled}（期望 30，仅 cloze 篇有）`);
if (explanationFilled !== 30) fail(`question.explanation 非空应为 30，实测 ${explanationFilled}`);

const wordFilled = count("SELECT COUNT(*) AS c FROM lexicon WHERE word IS NOT NULL AND TRIM(word) <> ''");
const wordTotal = count("SELECT COUNT(*) AS c FROM lexicon");
console.log(`  lexicon.word 非空且非空串 ${wordFilled}/${wordTotal}（期望 1561/1561）`);
if (wordFilled !== 1561 || wordTotal !== 1561) fail(`lexicon.word 非空应为 1561/1561，实测 ${wordFilled}/${wordTotal}`);

const sources = db.prepare("SELECT DISTINCT source FROM article WHERE source IS NOT NULL").all().map((r) => r.source);
const sourceRow = count("SELECT COUNT(*) AS c FROM article WHERE source IS NOT NULL AND TRIM(source) <> ''");
console.log(`  article.source 非空 ${sourceRow}/12，唯一值 = ${JSON.stringify(sources)}`);
if (sourceRow !== 12) fail(`article.source 非空应为 12，实测 ${sourceRow}`);
if (sources.length !== 1 || sources[0] !== "CET-4 2023年12月真题") {
  fail(`article.source 唯一值应为 ["CET-4 2023年12月真题"]，实测 ${JSON.stringify(sources)}`);
}

// ── 3. pack_version 单一权威 + 篇内残留版本未入库 ──
console.log("\n── 内容包版本 ──");
const packVersions = db
  .prepare("SELECT DISTINCT pack_version FROM article ORDER BY pack_version")
  .all()
  .map((r) => r.pack_version);
console.log(`  article.pack_version 唯一值 = ${JSON.stringify(packVersions)}（期望 ["${manifest.packVersion}"]）`);
if (packVersions.length !== 1 || packVersions[0] !== manifest.packVersion) {
  fail(`article.pack_version 应全等 ${manifest.packVersion}，实测 ${JSON.stringify(packVersions)}`);
}
const metaPack = one("SELECT value FROM schema_meta WHERE key = 'pack_version'")?.value ?? null;
console.log(`  schema_meta.pack_version = ${metaPack}（与 article 同事务同值，R11）`);
if (metaPack !== manifest.packVersion) fail(`schema_meta.pack_version 应为 ${manifest.packVersion}，实测 ${metaPack}`);

// 篇内残留的旧版本号（packVersion=2023-12-set1-v0.9）不得出现在库里任何文本列
const residual = count(
  "SELECT COUNT(*) AS c FROM article WHERE IFNULL(pack_version,'') LIKE '%2023-12-set1-v0.9%' OR IFNULL(source,'') LIKE '%2023-12-set1%'",
);
console.log(`  篇内残留版本（2023-12-set1-v0.9）命中行数 = ${residual}（期望 0）`);
if (residual !== 0) fail(`篇内残留版本入库了（命中 ${residual} 行）`);

// ── 4. is_word 权威值落地（核心风险：推导会把空格判成词） ──
console.log("\n── token.is_word（内容包权威值，禁止推导）──");
const wordDist = db.prepare("SELECT is_word, COUNT(*) c FROM token GROUP BY is_word ORDER BY is_word").all();
console.log(`  分布 = ${JSON.stringify(wordDist)}（期望 is_word=0 → 879、is_word=1 → 5820）`);
const nonWord = wordDist.find((r) => r.is_word === 0)?.c ?? 0;
const word = wordDist.find((r) => r.is_word === 1)?.c ?? 0;
if (nonWord !== 879 || word !== 5820) fail(`is_word 分布应为 879/5820，实测 ${nonWord}/${word}`);

// ── 5. 幂等复查用锚点 ──
console.log("\n── 幂等复查锚点（MAX(id) / COUNT(*)）──");
for (const table of ["article", "sentence", "token"]) {
  const row = one(`SELECT COUNT(*) c, MAX(id) max_id FROM ${table}`);
  console.log(`  ${table.padEnd(10)} count=${row.c} maxId=${row.max_id}`);
}

db.close();
if (failed) {
  console.error("\nFAIL: 导入结果与 02 §四 AC3/AC4 不符");
  process.exit(1);
}
console.log("\nPASS: 九表 12/90/274/6699/274/213/1561/30/90 + 四项非空 + pack_version 单一权威 + is_word 权威值 全部符合");
