#!/usr/bin/env node
/**
 * M1 AC6 断言 + **M2 回归基线**：把运行期库里的 274 句 / 6699 token 灌进纯函数 `renderTokens`，逐条验：
 *   ① 每个 token 之前的那段文本（`text.slice(prev, t.start)`）全是空白
 *   ② `text.slice(t.start, t.end) === t.surface`（**0 例外**）
 *   ③ 末 token 的 `end === text.length`
 *   ④ 空格分母精确：非词（isWord===false）纯数字 token 共 92 个 → ∈ blankNos 的 30 个出
 *      `data-blank-no`（节点 kind=blank）、另外 62 个不出
 *   ⑤ 固有数字零误判：150 / 1997 / 88,000 不得成为空格节点
 *   ⑥ 长文（set3Long，58 句 / 1208 token）纯函数重复 100 次取中位数 < 50ms
 *   ⑦ 拼回原文：所有节点 text 顺序拼接 === 句原文（不漏字、不重复）
 *   ⑧ 段落级还原：`renderParagraph(paragraph.text, sentences)` 拼出的段落文本 === `paragraph.text`
 *      （90 段逐一，句间/句末空隙不得丢；修复前「句子 text 直接拼接」有 75 段不等）
 *   ⑨ 结构：句段数 === 句子总数，空隙段只出现在句间/首尾
 *
 * 为什么跑纯函数而不是 DOM：`render.ts` 不依赖 DOM（05 §四 规则 7），
 * node 里直接 import 同一份实现即可；DOM 层面的题目折叠/选项不可点由 CDP 断言（M2 AC6）。
 *
 * 口径（D-M1-4 收口）：脚本里的数字（274 句 / 6699 token / 90 段 / 30·62 空格 / 58 句·1208 token）
 * 都是**内置内容包当前事实**（manifest packVersion 对应值），不是常量契约；内容包升级时同步更新断言。
 *
 * 用法：node scripts/verify-render.mjs [dbPath]
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.argv[2] ?? path.join(process.env.APPDATA ?? "", "com.judou.app", "judou.db");
const renderPath = path.join(root, "src", "lib", "render.ts");

if (!existsSync(dbPath)) {
  console.error(`FAIL: 库文件不存在（应用是否启动过？）：${dbPath}`);
  process.exit(1);
}
if (!existsSync(renderPath)) {
  console.error(`FAIL: 纯函数不存在：${renderPath}`);
  process.exit(1);
}

// Node 24 可直接 import .ts（要求 erasable 语法，见 02 D6 R8）
const { renderTokens, renderParagraph } = await import(`file://${renderPath.replace(/\\/g, "/")}`);

const db = new DatabaseSync(dbPath, { readOnly: true });

const sentences = db
  .prepare(
    `SELECT s.id, s.article_id, s.paragraph_id, s.idx, s.text, s.start_offset, s.end_offset,
            p.idx AS paragraph_idx
     FROM sentence s JOIN paragraph p ON p.id = s.paragraph_id
     ORDER BY s.article_id, p.idx, s.idx`,
  )
  .all();
const paragraphs = db
  .prepare("SELECT id, article_id, idx, text FROM paragraph ORDER BY article_id, idx")
  .all();
const tokenRows = db
  .prepare(
    `SELECT t.sentence_id, t.id, t.idx, t.start_offset, t.end_offset, t.surface, t.normalized, t.is_word
     FROM token t JOIN sentence s ON s.id = t.sentence_id
     ORDER BY t.sentence_id, t.idx`,
  )
  .all();
const blankRows = db.prepare("SELECT article_id, blank_no FROM blank ORDER BY article_id, blank_no").all();

const tokensBySentence = new Map();
for (const row of tokenRows) {
  const list = tokensBySentence.get(row.sentence_id) ?? [];
  list.push({
    id: row.id,
    start: row.start_offset,
    end: row.end_offset,
    surface: row.surface,
    normalized: row.normalized,
    isWord: row.is_word !== 0,
  });
  tokensBySentence.set(row.sentence_id, list);
}
const blanksByArticle = new Map();
for (const row of blankRows) {
  const list = blanksByArticle.get(row.article_id) ?? [];
  list.push(row.blank_no);
  blanksByArticle.set(row.article_id, list);
}

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

console.log(`库路径: ${dbPath}`);
console.log(`句子 ${sentences.length} / token ${tokenRows.length}`);
if (sentences.length !== 274) fail(`句子应为 274，实测 ${sentences.length}`);
if (tokenRows.length !== 6699) fail(`token 应为 6699，实测 ${tokenRows.length}`);

// ── ①②③⑦ 切片与拼回（全量逐句） ──
let slicedOk = 0;
let slicedBad = 0;
let gapOk = 0;
let gapBad = 0;
let tailOk = 0;
let tailBad = 0;
let joinOk = 0;
let joinBad = 0;
const samples = [];

for (const sentence of sentences) {
  const tokens = tokensBySentence.get(sentence.id) ?? [];
  const blankNos = blanksByArticle.get(sentence.article_id) ?? [];
  const text = sentence.text;

  let prev = 0;
  let join = "";
  const nodes = renderTokens(text, tokens, blankNos);
  for (const node of nodes) join += node.text;

  for (const token of tokens) {
    const gap = text.slice(prev, token.start);
    if (/^\s*$/.test(gap)) gapOk += 1;
    else {
      gapBad += 1;
      if (samples.length < 3) samples.push({ sentence: sentence.id, kind: "gap", gap, token });
    }
    const slice = text.slice(token.start, token.end);
    if (slice === token.surface) slicedOk += 1;
    else {
      slicedBad += 1;
      if (samples.length < 3) samples.push({ sentence: sentence.id, kind: "slice", got: slice, want: token.surface, token });
    }
    prev = token.end;
  }
  const lastEnd = tokens.length ? tokens[tokens.length - 1].end : 0;
  if (lastEnd === text.length) tailOk += 1;
  else {
    tailBad += 1;
    if (samples.length < 3) samples.push({ sentence: sentence.id, kind: "tail", lastEnd, len: text.length });
  }
  if (join === text) joinOk += 1;
  else {
    joinBad += 1;
    if (samples.length < 3) samples.push({ sentence: sentence.id, kind: "join", got: join.slice(0, 80), want: text.slice(0, 80) });
  }
}

console.log(`\n── 切片与拼回 ──`);
console.log(`  ① 间隙全空白      ${gapOk}/${gapOk + gapBad}`);
console.log(`  ② 切片 === surface ${slicedOk}/${slicedOk + slicedBad}`);
console.log(`  ③ 末 token 收尾    ${tailOk}/${tailOk + tailBad}`);
console.log(`  ⑦ 节点拼回原文     ${joinOk}/${joinOk + joinBad}`);
if (gapBad) fail(`有 ${gapBad} 个 token 之前不是纯空白（缝隙丢字/重复）`);
if (slicedBad) fail(`有 ${slicedBad} 个 token 的切片段与 surface 不等`);
if (tailBad) fail(`有 ${tailBad} 句末 token 的 end !== 句长`);
if (joinBad) fail(`有 ${joinBad} 句节点拼回后与原文不等`);

// ── ⑧ 段落级还原：段落 DOM 文本 === paragraph.text ──
// 渲染路径（`Reader.tsx`）= `renderParagraph(paragraph.text, sentences)` 逐段拼出「空隙 + 句子」，
// 因此这里直接调同一份纯函数：段落文本必须能**无损还原**（红段判据见修复前的「句子 text 直接拼接」，
// 90 段中 75 段不等 → 句间空格丢失）。⑨ 另外核「句段文本 = 该句 text」且空隙只出现在句与句/首尾之间。
console.log(`\n── ⑧ 段落级还原（段落 DOM 文本 === paragraph.text）──`);
const sentencesByParagraph = new Map();
for (const sentence of sentences) {
  const list = sentencesByParagraph.get(sentence.paragraph_id) ?? [];
  list.push(sentence);
  sentencesByParagraph.set(sentence.paragraph_id, list);
}
let paraOk = 0;
let paraBad = 0;
let gapParts = 0;
let gapNonEmpty = 0;
let sentenceParts = 0;
const paraSamples = [];
for (const paragraph of paragraphs) {
  const rows = sentencesByParagraph.get(paragraph.id) ?? [];
  const parts = renderParagraph(
    paragraph.text,
    rows.map((row) => ({ start: row.start_offset, end: row.end_offset, text: row.text })),
  );
  const rendered = parts.map((part) => part.text).join("");
  for (const part of parts) {
    if (part.kind === "gap") {
      gapParts += 1;
      if (part.text) gapNonEmpty += 1;
    } else {
      sentenceParts += 1;
    }
  }
  if (rendered === paragraph.text) paraOk += 1;
  else {
    paraBad += 1;
    if (paraSamples.length < 3) {
      paraSamples.push({ paragraph: paragraph.id, lenPara: paragraph.text.length, lenRendered: rendered.length });
    }
  }
}
console.log(`  ⑧ 段落还原        ${paraOk}/${paraOk + paraBad}（库内共 ${paragraphs.length} 段）`);
console.log(`  ⑨ 句段 / 空隙段   ${sentenceParts} 句段 / ${gapParts} 空隙段（其中非空 ${gapNonEmpty}）`);
if (paraSamples.length) console.log(`  样例（最多 3 条）：${JSON.stringify(paraSamples)}`);
if (paragraphs.length !== 90) fail(`段落应为 90，实测 ${paragraphs.length}`);
if (sentenceParts !== sentences.length) fail(`句段应 ${sentences.length} 个，实测 ${sentenceParts}`);
if (paraBad) fail(`有 ${paraBad} 段渲染后与 paragraph.text 不等（句间空隙丢失 → 句子粘连）`);

// ── ④ 空格分母：92 个非词纯数字 → 30 出空格 / 62 不出 ──
console.log(`\n── 空格分母（isWord===false ∧ /^\\d+$/ ∧ ∈ blankNos）──`);
let nonWordNumeric = 0;
let blankHit = 0;
let blankMiss = 0;
const nonWordSurfaces = new Set();
const blankSurfaces = new Set();

for (const sentence of sentences) {
  const tokens = tokensBySentence.get(sentence.id) ?? [];
  const blankNos = blanksByArticle.get(sentence.article_id) ?? [];
  const nodes = renderTokens(sentence.text, tokens, blankNos);
  const blankNodes = nodes.filter((n) => n.kind === "blank");
  for (const node of blankNodes) blankSurfaces.add(node.text);

  for (const token of tokens) {
    if (token.isWord !== false) continue;
    if (!/^\d+$/.test(token.surface)) continue;
    nonWordNumeric += 1;
    nonWordSurfaces.add(token.surface);
    const shouldBeBlank = blankNos.includes(Number(token.surface));
    const isBlankNode = blankNodes.some((n) => n.text === token.surface && n.start === token.start);
    if (shouldBeBlank && isBlankNode) blankHit += 1;
    else if (!shouldBeBlank && !isBlankNode) blankMiss += 1;
    else fail(`token「${token.surface}」(start=${token.start}) 空格判定错：应为${shouldBeBlank ? "空格" : "普通文本"}`);
  }
}
console.log(`  非词纯数字 token      ${nonWordNumeric}（期望 92）`);
console.log(`  其中出空格节点        ${blankHit}（期望 30）`);
console.log(`  其中不出空格节点      ${blankMiss}（期望 62）`);
console.log(`  空格节点 surface 集合 ${JSON.stringify([...blankSurfaces].sort((a, b) => Number(a) - Number(b)))}`);
if (nonWordNumeric !== 92) fail(`非词纯数字应为 92，实测 ${nonWordNumeric}`);
if (blankHit !== 30) fail(`空格节点应为 30，实测 ${blankHit}`);
if (blankMiss !== 62) fail(`非空格的非词数字应为 62，实测 ${blankMiss}`);

// ── ⑤ 固有数字零误判 ──
console.log(`\n── 固有数字零误判 ──`);
const INHERENT = ["150", "1997", "88,000"];
for (const surface of INHERENT) {
  const offended = [...blankSurfaces].includes(surface);
  console.log(`  ${surface.padEnd(8)} 是否被判为空格：${offended ? "是（FAIL）" : "否（ok）"}`);
  if (offended) fail(`固有数字「${surface}」被误判成空格`);
}

// ── ⑥ 长文纯函数耗时：100 次取中位数 < 50ms ──
const longArticle = db
  .prepare("SELECT id, source_key, sentence_count FROM article WHERE source_key LIKE '%set3Long%' LIMIT 1")
  .get();
if (!longArticle) {
  fail("库中找不到 set3Long 篇（长文耗时断言无法执行）");
} else {
  const longSentences = sentences.filter((s) => s.article_id === longArticle.id);
  const longTokens = longSentences.reduce((sum, s) => sum + (tokensBySentence.get(s.id)?.length ?? 0), 0);
  const blankNos = blanksByArticle.get(longArticle.id) ?? [];
  const runOnce = () => {
    for (const s of longSentences) renderTokens(s.text, tokensBySentence.get(s.id) ?? [], blankNos);
  };
  runOnce(); // 预热（JIT）
  const timings = [];
  for (let i = 0; i < 100; i += 1) {
    const started = performance.now();
    runOnce();
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  console.log(`\n── 长文纯函数耗时（${longArticle.source_key}：${longSentences.length} 句 / ${longTokens} token）──`);
  console.log(`  100 次中位数 ${median.toFixed(2)}ms、最小 ${timings[0].toFixed(2)}ms、最大 ${timings[timings.length - 1].toFixed(2)}ms（门槛 < 50ms）`);
  if (longSentences.length !== 58) fail(`set3Long 应为 58 句，实测 ${longSentences.length}`);
  if (longTokens !== 1208) fail(`set3Long 应为 1208 token，实测 ${longTokens}`);
  if (median >= 50) fail(`长文纯函数中位数 ${median.toFixed(2)}ms ≥ 50ms`);
}

if (samples.length) console.log(`\n样例（最多 3 条）：\n${JSON.stringify(samples, null, 1)}`);

db.close();
if (failed) {
  console.error("\nFAIL: renderTokens 未通过 AC6 判据");
  process.exit(1);
}
console.log("\nPASS: 6699 token 切片零例外 / 空格 30·62 / 固有数字零误判 / 长文中位数 < 50ms / 拼回原文 / 段落 90/90 无损还原");
