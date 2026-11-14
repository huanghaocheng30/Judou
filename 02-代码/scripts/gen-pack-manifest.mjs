#!/usr/bin/env node
/**
 * 内容包 manifest 生成器（M16 D2）：扫 `content-pack/*.json` → 重算元数据 → 写 `content-pack/manifest.json`。
 *
 * 为什么要有它：manifest 是 17 项门禁与 Rust `manifest_and_all_articles_parse` 的断言源，
 * 以前是手改（并入内容时容易漏字段、算错 totals）；生成器让「加内容」变成一次 `node scripts/gen-pack-manifest.mjs`，
 * 且元数据一律从篇内 `meta` + 内容重算，不做任何手填。
 *
 * 硬判据（M16 §四 3）：把 2023-12 那 12 篇交给生成器重算，结果必须与旧版 hand-written manifest **逐字段相同**。
 * 这就是推导规则正确性的证明——规则错了，那 12 项一定先红。
 *
 * 推导规则：
 *   sourceKey/articleId/title/meta.*  ← 篇内 JSON
 *   sectionType ← 文件名后缀：A/B → careful，Cloze → cloze，Long → long
 *   sectionLabel ← sectionType 的中文名（careful=仔细阅读 / cloze=选词填空 / long=长篇阅读）
 *   paragraphCount/sentenceCount/tokenCount/questionCount ← 内容重算
 *   blankCount ← `blankNos.length`（空格位的唯一权威清单，与 import.rs 同源）
 *   totals ← 全量重算；lexicon 按 normalized **去重**（DB 主键口径，与 pack.rs 断言一致）
 *
 * 幂等：不读时钟（`generatedAt` 是常量，随版本手改），同输入同输出。
 * 有序：examYear, examMonth, examSet, sectionType（→2023-12 set1A/set1B/set1Cloze/set1Long…）。
 *
 * 用法：node scripts/gen-pack-manifest.mjs [--check]
 *   --check  只比对不落盘（CI/自测用；有差异退出码 1）
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = path.join(root, "content-pack");
const manifestPath = path.join(packDir, "manifest.json");

// 版本与日期是「发布动作」的一部分，跟着内容包一起手改——不放进生成逻辑，保证幂等
const PACK_VERSION = "2026.11.14-1";
// `contentVersion` 与 packVersion 同性质：发布者声明「这一包覆盖哪些批次」。
// 纯数据只能推出去重后的批次集合（下面会打印），但「2023-12 是原包基线、2024-06~2026-06 是本次并入区间」
// 是内容归属事实，数据里没有——所以它是常量，不做猜测。
const CONTENT_VERSION = "cet4-2023-12+2024-06~2026-06";
const GENERATED_AT = "2026-11-14";
const SCHEMA_VERSION = 1;
const NOTE = "packVersion 为唯一版本权威；篇内残留 packVersion 不入库、不参与比较";

const SECTION_BY_SUFFIX = {
  A: { type: "careful", label: "仔细阅读" },
  B: { type: "careful", label: "仔细阅读" },
  Cloze: { type: "cloze", label: "选词填空" },
  Long: { type: "long", label: "长篇阅读" },
};

const check = process.argv.includes("--check");

/** 文件名 → { examYear, examMonth, examSet, sectionType, sectionLabel } */
function parseName(name) {
  // `set1A`（新名）与 `set1-passageA`（2023-12 的历史名，manifest 的 file 字段指向它）都得认
  const m = /^cet(\d+)-(\d{4})-(\d{2})-set(\d)-?(?:passage)?([A-Za-z]+)\.json$/.exec(name);
  if (!m) return null;
  // 捕获组：0=全串 1=级别 2=年 3=月 4=套号 5=后缀（`passage` 是非捕获组，不占位）
  const [, , yyyy, mm, setNo, suffix] = m;
  const section = SECTION_BY_SUFFIX[suffix];
  if (!section) return null;
  return {
    examYear: Number(yyyy),
    examMonth: Number(mm),
    examSet: Number(setNo),
    sectionType: section.type,
    sectionLabel: section.label,
  };
}

const files = readdirSync(packDir)
  .filter((name) => name.endsWith(".json") && name !== "manifest.json")
  .filter((name) => statSync(path.join(packDir, name)).isFile())
  .sort();

const articles = [];
const totals = {
  articles: 0,
  paragraphs: 0,
  sentences: 0,
  tokens: 0,
  sentenceAnalysis: 0,
  tokenAnalysis: 0,
  blanks: 0,
  questions: 0,
  lexicon: 0,
};
const lexiconKeys = new Set();
const months = new Set();

for (const file of files) {
  const nameParts = parseName(file);
  if (!nameParts) {
    console.error(`FAIL: 文件名不符合命名规则（应为 cet4-YYYY-MM-set<N><A|B|Cloze|Long>.json）：${file}`);
    process.exit(1);
  }
  const pack = JSON.parse(readFileSync(path.join(packDir, file), "utf8"));
  const meta = pack.meta ?? {};

  let paragraphs = 0;
  let sentences = 0;
  let tokens = 0;
  let sentenceAnalysis = 0;
  let tokenAnalysis = 0;
  for (const paragraph of pack.paragraphs ?? []) {
    paragraphs += 1;
    for (const sentence of paragraph.sentences ?? []) {
      sentences += 1;
      tokens += (sentence.tokens ?? []).length;
      if (sentence.analysis) sentenceAnalysis += 1;
      for (const token of sentence.tokens ?? []) if (token.analysis) tokenAnalysis += 1;
    }
  }

  const blankNos = Array.isArray(pack.blankNos) ? pack.blankNos : [];
  const lexicon = pack.lexicon ?? {};
  for (const key of Object.keys(lexicon)) lexiconKeys.add(key);
  months.add(`${nameParts.examYear}-${String(nameParts.examMonth).padStart(2, "0")}`);

  articles.push({
    sourceKey: pack.sourceKey,
    articleId: pack.articleId,
    file,
    title: meta.title,
    examType: "cet4",
    examYear: nameParts.examYear,
    examSet: nameParts.examSet,
    sectionType: nameParts.sectionType,
    sectionLabel: nameParts.sectionLabel,
    passageLabel: meta.passageLabel ?? "",
    wordCount: meta.wordCount,
    paragraphCount: paragraphs,
    sentenceCount: sentences,
    tokenCount: tokens,
    questionCount: (pack.questions ?? []).length,
    blankCount: blankNos.length,
    visibility: "system",
  });

  totals.articles += 1;
  totals.paragraphs += paragraphs;
  totals.sentences += sentences;
  totals.tokens += tokens;
  totals.sentenceAnalysis += sentenceAnalysis;
  totals.tokenAnalysis += tokenAnalysis;
  totals.blanks += blankNos.length;
  totals.questions += (pack.questions ?? []).length;
}
totals.lexicon = lexiconKeys.size;

// 有序：年 → 月 → 套 → 题型（sectionType 字典序刚好是 careful < cloze < long）
// examMonth 不入 manifest 字段（沿用旧格式），但参与排序——排序键单独从文件名缓存
const monthOf = new Map(files.map((file) => [file, parseName(file).examMonth]));
articles.sort(
  (a, b) =>
    a.examYear - b.examYear ||
    monthOf.get(a.file) - monthOf.get(b.file) ||
    a.examSet - b.examSet ||
    a.sectionType.localeCompare(b.sectionType),
);

/** 月份集合 → 有序批次清单（只作诊断输出：`contentVersion` 是发布常量，不从它推导） */
function batchList(monthSet) {
  return [...monthSet]
    .sort((a, b) => {
      const [ay, am] = a.split("-").map(Number);
      const [by, bm] = b.split("-").map(Number);
      return ay * 12 + am - (by * 12 + bm);
    })
    .join(", ");
}

const manifest = {
  packVersion: PACK_VERSION,
  contentVersion: CONTENT_VERSION,
  generatedAt: GENERATED_AT,
  schemaVersion: SCHEMA_VERSION,
  note: NOTE,
  articles,
  totals,
};

const output = `${JSON.stringify(manifest, null, 2)}\n`;
const previous = readFileSync(manifestPath, "utf8");

console.log(`扫到 ${files.length} 篇 → articles ${totals.articles}`);
console.log(`contentVersion = ${manifest.contentVersion}｜packVersion = ${manifest.packVersion}`);
console.log(`覆盖批次（由文件名推导，仅作核对）= ${batchList(months)}`);
console.log(
  `totals = ${JSON.stringify(totals)}`,
);

if (output === previous) {
  console.log("\nmanifest 已是最新（幂等：同输入同输出）");
  process.exit(0);
}

if (check) {
  const prevJson = JSON.parse(previous);
  console.error("\nFAIL[--check]: manifest 与内容包不一致");
  console.error(`  articles: ${prevJson.articles?.length} → ${manifest.articles.length}`);
  console.error(`  totals: ${JSON.stringify(prevJson.totals)} → ${JSON.stringify(totals)}`);
  process.exit(1);
}

writeFileSync(manifestPath, output, "utf8");
console.log(`\n已写入 ${path.relative(root, manifestPath)}`);
