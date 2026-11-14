#!/usr/bin/env node
/**
 * M2 纯函数门禁（AC2 / AC3 / AC4 / AC5 的纯函数侧）。
 *
 * 判据（与 02 v1.2 / 决策记录 #19 #20 #23 逐条对应）：
 *   ① parseMarkup 文本守恒：`parts.map(p => p.text).join("")` === `markup.replace(/[_~]/g, "")`
 *      —— 1771/1771 零例外（`text` 统一去标记符口径，含嵌套内层与 fail-closed 分支）
 *   ② fail-closed 白名单**恰为** 7 句（sentence_id 26/68/69/75/180/211/260）；其余句一律不得触发
 *   ③ 五种 kind 全覆盖；样本句 id=4 出 subject/predicate/object、id=10 出 clause/phrase
 *   ④ 标记符零残留：任何 part.text 里都不含 `_` / `~`
 *   ⑤ 奇数标记不抛错、退化为单个 text part；嵌套按外层优先切、内层不展开
 *   ⑥ toSentenceCard 六段序固定、缺字段段 empty=true
 *   ⑦ pickWordCard 三态（provoke→context / teenagers→generic / the→none）
 *   ⑧ toBlankCard 180 空全部有内容、distractors 两形态逐空条数正确、无行时降级
 *   ⑨ normalizeList 数组 / 字符串（`、`、换行）/ JSON 数组文本 三形态归一
 *   ⑩ 数据事实：`more.synonyms`/`more.confusables` 两形态真实存在（string 130 / array 83）；
 *      `collocations`/`examples` 数据只有数组形态（字符串形态由构造用例覆盖，不谎称「数据里有」）
 *
 * 数据源（M16 D4）：**脚本内自建 `:memory:` 临时库**（`lib/temp-pack-db.mjs`：跑真迁移 SQL +
 * 按 manifest 顺序灌 content-pack），不再读 `%APPDATA%\com.judou.app\judou.db`——
 * 门禁验的是「内容包能不能被解析」，不该以「用户机器上启动过应用」为前提。
 *
 * 失败分两类（02 D10 / 评审 N2-9）：
 *   退出码 2 = 前置不满足（内容包无句子/无解析行）—— 不是实现错
 *   退出码 1 = 实现错（断言不成立）
 *
 * 用法：node scripts/verify-analysis.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTempPackDb } from "./lib/temp-pack-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const analysisPath = path.join(root, "src", "lib", "analysis.ts");

// ── 前置：实现文件 ──────────────────────────────────────────────
if (!existsSync(analysisPath)) {
  console.error(`FAIL[实现]: 纯函数不存在：${analysisPath}`);
  process.exit(1);
}

const db = openTempPackDb({ withContent: true });
const sentenceCount = db.prepare("SELECT COUNT(*) c FROM sentence").get().c;
const analysisRows = db
  .prepare("SELECT sentence_id, struct_markup, translation_literal, translation_natural, structure_summary, paragraph_role, components_json, clauses_json, phrases_json, pitfalls_json FROM sentence_analysis ORDER BY sentence_id")
  .all();
if (sentenceCount === 0 || analysisRows.length === 0) {
  console.error(`FAIL[前置]: 库无数据（sentence=${sentenceCount}、sentence_analysis=${analysisRows.length}）——先启动一次应用导入内容包`);
  process.exit(2);
}

const mod = await import(`file://${analysisPath.replace(/\\/g, "/")}`);
const { parseMarkup, toSentenceCard, pickWordCard, toBlankCard, normalizeList, SENTENCE_SEGMENT_ORDER } = mod;

for (const [name, value] of Object.entries({ parseMarkup, toSentenceCard, pickWordCard, toBlankCard, normalizeList })) {
  if (typeof value !== "function") {
    console.error(`FAIL[实现]: analysis.ts 未导出函数 ${name}`);
    process.exit(1);
  }
}

let failed = false;
const fail = (msg) => {
  console.error(`FAIL[实现]: ${msg}`);
  failed = true;
};
const ok = (msg) => console.log(`  ok  ${msg}`);

console.log(`数据源: 脚本内临时库（跑真迁移 SQL + 灌 content-pack）`);
console.log(`库内：sentence ${sentenceCount} / sentence_analysis ${analysisRows.length}`);

const strip = (markup) => markup.replace(/[_~]/g, "");
const EXPECTED_FAILED_CLOSED = [26, 68, 69, 75, 180, 211, 260];

// ── ① 守恒 274/274 + ④ 标记符零残留 ──────────────────────────
console.log("\n── ① parseMarkup 文本守恒（parts 拼回 === markup 去 _ ~）──");
let conserveOk = 0;
const conserveBad = [];
let residue = 0;
const kindHit = new Set();
const failedClosedSet = [];
const partsBySentence = new Map();

for (const row of analysisRows) {
  const markup = row.struct_markup ?? "";
  const parts = parseMarkup(markup);
  partsBySentence.set(row.sentence_id, parts);
  const joined = parts.map((part) => part.text).join("");
  if (joined === strip(markup)) conserveOk += 1;
  else if (conserveBad.length < 5) conserveBad.push({ id: row.sentence_id, got: joined.slice(0, 60), want: strip(markup).slice(0, 60) });
  for (const part of parts) {
    if (/[_~]/.test(part.text)) residue += 1;
    if (part.kind !== "text") kindHit.add(part.kind);
  }
  if (parts.length === 1 && parts[0].failedClosed === true) failedClosedSet.push(row.sentence_id);
}
console.log(`  守恒            ${conserveOk}/${analysisRows.length}`);
if (conserveBad.length) console.log(`  反例（最多 5 条）：${JSON.stringify(conserveBad, null, 1)}`);
if (conserveOk !== analysisRows.length) fail(`parseMarkup 守恒有 ${analysisRows.length - conserveOk} 句不等（应 274/274）`);
else ok(`274/274 守恒`);
if (residue > 0) fail(`有 ${residue} 个 part.text 残留标记符 _ / ~（text 统一去标记符口径未落实）`);
else ok(`part.text 标记符零残留`);

// ── ② fail-closed 白名单 ────────────────────────────────────
console.log("\n── ② fail-closed 白名单（内容包事实，7 句）──");
console.log(`  实测：${JSON.stringify(failedClosedSet)}`);
console.log(`  期望：${JSON.stringify(EXPECTED_FAILED_CLOSED)}`);
if (JSON.stringify(failedClosedSet) !== JSON.stringify(EXPECTED_FAILED_CLOSED)) {
  fail(`fail-closed 集合与内容包事实不符（期望恰 7 句）`);
} else {
  ok(`fail-closed 恰 ${failedClosedSet.length} 句，与内容包一致`);
}
// 退化形态：单 part + failedClosed + text === strip(markup)
for (const id of EXPECTED_FAILED_CLOSED) {
  const row = analysisRows.find((r) => r.sentence_id === id);
  const parts = partsBySentence.get(id);
  if (parts.length !== 1) fail(`句 ${id} 应退化为单个 part，实测 ${parts.length} 个`);
  else if (parts[0].kind !== "text") fail(`句 ${id} 退化后应为 text part，实测 ${parts[0].kind}`);
  else if (parts[0].text !== strip(row.struct_markup)) fail(`句 ${id} 退化后 text 应 === markup 去标记符`);
}

// ── ③ 五 kind 覆盖 + 样本句 ─────────────────────────────────
console.log("\n── ③ 五种 kind 覆盖与样本句 ──");
const FIVE = ["subject", "predicate", "object", "clause", "phrase"];
console.log(`  实测出现：${JSON.stringify([...kindHit].sort())}`);
for (const kind of FIVE) if (!kindHit.has(kind)) fail(`kind「${kind}」在 274 句里一次都没出现`);
const kindsOf = (id) => new Set(partsBySentence.get(id).map((p) => p.kind));
const k4 = kindsOf(4);
const k10 = kindsOf(10);
console.log(`  句 4  : ${JSON.stringify([...k4])}`);
console.log(`  句 10 : ${JSON.stringify([...k10])}`);
for (const kind of ["subject", "predicate", "object"]) {
  if (!k4.has(kind)) fail(`样本句 4 缺 kind「${kind}」`);
}
for (const kind of ["clause", "phrase"]) {
  if (!k10.has(kind)) fail(`样本句 10 缺 kind「${kind}」`);
}
if (!failed) ok(`五种 kind 全覆盖；句 4 出主/谓/宾、句 10 出从句/短语`);

// ── ⑤ 构造用例：奇数标记 / 嵌套 / 空串 ─────────────────────
console.log("\n── ⑤ 构造用例（奇数标记 / 嵌套外层优先 / 空串）──");
const cases = [
  { name: "五类并列", markup: "【主】 _谓_ ~宾~ {从} (短)", expectKinds: ["subject", "predicate", "object", "clause", "phrase"], failedClosed: false },
  { name: "嵌套：从句内短语不展开", markup: "(In other words), {a (b) _c_}", expectKinds: ["phrase", "clause"], failedClosed: false },
  { name: "宾语内嵌从句不展开", markup: "【We】 _found_ ~{that A paid (on average) $18}~", expectKinds: ["subject", "predicate", "object"], failedClosed: false },
  // 退化用例：整串变成**单个 text part**，所以「非 text kind 序列」为空
  { name: "奇数下划线 → 退化", markup: "【a】 _b", expectKinds: [], failedClosed: true },
  { name: "奇数波浪线 → 退化", markup: "abc ~def", expectKinds: [], failedClosed: true },
  { name: "空串", markup: "", expectKinds: [], failedClosed: false },
];
for (const testCase of cases) {
  let parts;
  try {
    parts = parseMarkup(testCase.markup);
  } catch (err) {
    fail(`构造用例「${testCase.name}」抛错：${err}`);
    continue;
  }
  const joined = parts.map((p) => p.text).join("");
  const want = strip(testCase.markup);
  if (joined !== want) fail(`构造用例「${testCase.name}」守恒失败：got=${JSON.stringify(joined)} want=${JSON.stringify(want)}`);
  const kinds = parts.map((p) => p.kind).filter((k) => k !== "text");
  if (JSON.stringify(kinds) !== JSON.stringify(testCase.expectKinds)) {
    fail(`构造用例「${testCase.name}」kind 序列应为 ${JSON.stringify(testCase.expectKinds)}，实测 ${JSON.stringify(kinds)}`);
  }
  const isFailedClosed = parts.length === 1 && parts[0].failedClosed === true;
  if (isFailedClosed !== testCase.failedClosed) fail(`构造用例「${testCase.name}」failedClosed 应为 ${testCase.failedClosed}`);
  // 内层不展开：嵌套用例不得出现第二个 clause / phrase
  if (testCase.name.includes("嵌套") && parts.filter((p) => p.kind === "clause").length > 1) {
    fail(`构造用例「${testCase.name}」内层 clause 被展开了`);
  }
}
if (!failed) ok(`6 个构造用例（含 2 个奇数标记、2 个嵌套）全部通过`);

// ── ⑥ toSentenceCard 六段序 / 缺字段 ───────────────────────
console.log("\n── ⑥ toSentenceCard 六段固定序与缺字段降级 ──");
const SIX = ["translation", "structure", "clauses", "phrases", "pitfalls", "paragraphRole"];
console.log(`  段序常量：${JSON.stringify(SENTENCE_SEGMENT_ORDER)}`);
if (JSON.stringify(SENTENCE_SEGMENT_ORDER) !== JSON.stringify(SIX)) {
  fail(`段序常量应为 ${JSON.stringify(SIX)}，实测 ${JSON.stringify(SENTENCE_SEGMENT_ORDER)}`);
}
const row4 = analysisRows.find((r) => r.sentence_id === 4);
const model4 = toSentenceCard({
  sentenceId: 4,
  translationLiteral: row4.translation_literal,
  translationNatural: row4.translation_natural,
  structMarkup: row4.struct_markup,
  structureSummary: row4.structure_summary,
  paragraphRole: row4.paragraph_role,
  components: JSON.parse(row4.components_json ?? "[]"),
  clauses: JSON.parse(row4.clauses_json ?? "[]"),
  phrases: JSON.parse(row4.phrases_json ?? "[]"),
  pitfalls: JSON.parse(row4.pitfalls_json ?? "[]"),
});
console.log(`  句 4 模型：translation=${JSON.stringify(model4.translation)}`);
console.log(`             structure.components=${model4.structure.components.length} 条、summary=${JSON.stringify(model4.structure.summary)}`);
console.log(`             clauses=${model4.clauses.length} / phrases=${model4.phrases.length} / pitfalls=${model4.pitfalls.length} / paragraphRole=${model4.paragraphRole ? "有" : "无"}`);
if (!model4.translation) fail(`句 4 的 translation 不该为空（直译+顺译都有）`);
if (!model4.structure.components.length) fail(`句 4 的 structure.components 不该为空（实测应有 4 条）`);
if (!model4.clauses.length) fail(`句 4 的 clauses 不该为空`);
if (!model4.phrases.length) fail(`句 4 的 phrases 不该为空`);
if (!model4.pitfalls.length) fail(`句 4 的 pitfalls 不该为空`);
if (!model4.paragraphRole) fail(`句 4 的 paragraphRole 不该为空`);
if (!model4.structMarkup) fail(`句 4 的 structMarkup 不该为空（②段要渲染符号句）`);
for (const [key, value] of Object.entries(model4.emptyFlags ?? {})) {
  if (value !== false) fail(`句 4 的 emptyFlags.${key} 应为 false，实测 ${value}`);
}
if (Object.keys(model4.emptyFlags ?? {}).length !== 6) fail(`emptyFlags 应有 6 个键，实测 ${Object.keys(model4.emptyFlags ?? {}).length}`);

const modelEmpty = toSentenceCard(null);
console.log(`  缺字段降级：emptyFlags=${JSON.stringify(modelEmpty.emptyFlags)}`);
for (const key of SIX) {
  if (!modelEmpty.emptyFlags?.[key]) fail(`空行时 emptyFlags.${key} 应为 true`);
}
if (modelEmpty.translation !== null) fail(`空行时 translation 应为 null，实测 ${JSON.stringify(modelEmpty.translation)}`);
if (!failed) ok(`六段序固定；句 4 六段均有内容；空行六段 empty 全真`);

// ── ⑦ pickWordCard 三态 ────────────────────────────────────
console.log("\n── ⑦ pickWordCard 三态判定（真实数据）──");
const wordSamples = [
  { word: "provoke", expect: "context" },
  { word: "teenagers", expect: "generic" },
  { word: "the", expect: "none" },
];
const pick = (word) => {
  const ta = db
    .prepare(
      `SELECT ta.id AS token_id, ta.phonetic, ta.pos, ta.sense_in_context, ta.collocations_json, ta.examples_json, ta.is_cet4_high_freq, ta.more_json
       FROM token_analysis ta JOIN token t ON t.id = ta.token_id WHERE t.normalized = ? LIMIT 1`,
    )
    .get(word);
  const lx = db
    .prepare(
      "SELECT normalized, word, phonetic, pos, sense, lemma, collocations_json, examples_json, is_cet_high_freq, more_json FROM lexicon WHERE normalized = ?",
    )
    .get(word);
  const parse = (raw) => {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  const tokenAnalysis = ta
    ? {
        tokenId: ta.token_id,
        phonetic: ta.phonetic,
        pos: ta.pos,
        senseInContext: ta.sense_in_context,
        collocations: parse(ta.collocations_json),
        examples: parse(ta.examples_json),
        isCet4HighFreq: ta.is_cet4_high_freq !== 0,
        more: parse(ta.more_json),
      }
    : null;
  const lexicon = lx
    ? {
        normalized: lx.normalized,
        word: lx.word,
        phonetic: lx.phonetic,
        pos: lx.pos,
        sense: lx.sense,
        lemma: lx.lemma,
        collocations: parse(lx.collocations_json),
        examples: parse(lx.examples_json),
        isCetHighFreq: lx.is_cet_high_freq !== 0,
        more: parse(lx.more_json),
      }
    : null;
  return { model: pickWordCard(tokenAnalysis, lexicon), hasTa: Boolean(ta), hasLx: Boolean(lx) };
};
for (const sample of wordSamples) {
  const { model, hasTa, hasLx } = pick(sample.word);
  console.log(`  ${sample.word.padEnd(10)} token_analysis=${hasTa ? 1 : 0} lexicon=${hasLx ? 1 : 0} → mode=${model.mode}（期望 ${sample.expect}）`);
  if (model.mode !== sample.expect) fail(`「${sample.word}」三态应为 ${sample.expect}，实测 ${model.mode}`);
  if (sample.expect === "none" && model.sense !== null) fail(`「the」三态 none 时 sense 应为 null`);
  if (sample.expect === "generic" && !model.sense) fail(`「teenagers」generic 时 sense 不该为空`);
  if (sample.expect === "context" && !model.sense) fail(`「provoke」context 时 sense 不该为空`);
}
if (!failed) ok(`三态判定正确（context / generic / none 各一）`);

// ── ⑩ 两形态真实分布（AC4 数据事实） ───────────────────────
console.log("\n── ⑩ more.synonyms / more.confusables 两形态真实分布 ──");
let synString = 0;
let synArray = 0;
let confString = 0;
let confArray = 0;
const moreRows = db.prepare("SELECT more_json FROM token_analysis WHERE more_json IS NOT NULL").all();
for (const row of moreRows) {
  let parsed;
  try {
    parsed = JSON.parse(row.more_json);
  } catch {
    continue;
  }
  if (typeof parsed?.synonyms === "string") synString += 1;
  else if (Array.isArray(parsed?.synonyms)) synArray += 1;
  if (typeof parsed?.confusables === "string") confString += 1;
  else if (Array.isArray(parsed?.confusables)) confArray += 1;
}
console.log(`  token_analysis.more_json 非空 ${moreRows.length} 行`);
console.log(`  synonyms    string ${synString} / array ${synArray}`);
console.log(`  confusables string ${confString} / array ${confArray}`);
if (synString !== 130 || synArray !== 83) fail(`more.synonyms 应 string 130 / array 83，实测 ${synString}/${synArray}`);
if (confString !== 130 || confArray !== 83) fail(`more.confusables 应 string 130 / array 83，实测 ${confString}/${confArray}`);
// 两形态都要能过 normalizeList（真实数据逐行）
let realBoth = 0;
for (const row of moreRows) {
  let parsed;
  try {
    parsed = JSON.parse(row.more_json);
  } catch {
    fail(`more_json 不是合法 JSON：${row.more_json?.slice(0, 60)}`);
    continue;
  }
  const syn = normalizeList(parsed?.synonyms);
  if (!Array.isArray(syn) || syn.length === 0) fail(`synonyms 归一后应为非空数组，实测 ${JSON.stringify(syn)}`);
  else realBoth += 1;
}
console.log(`  normalizeList(more.synonyms) 真实逐行非空 ${realBoth}/${moreRows.length}`);
if (realBoth !== moreRows.length) fail(`more.synonyms 归一后非空行数应 ${moreRows.length}`);
const collStr = db.prepare("SELECT COUNT(*) c FROM token_analysis WHERE collocations_json IS NOT NULL AND substr(trim(collocations_json),1,1) <> '['").get().c;
const exStr = db.prepare("SELECT COUNT(*) c FROM token_analysis WHERE examples_json IS NOT NULL AND substr(trim(examples_json),1,1) <> '['").get().c;
console.log(`  数据事实：collocations 非数组 ${collStr} 行 / examples 非数组 ${exStr} 行（数据只有数组形态，字符串形态走构造用例）`);
if (collStr !== 0 || exStr !== 0) fail(`collocations/examples 出现非数组形态（${collStr}/${exStr}）——02 AC4 声明数据只有数组形态，需更新口径`);

// ── ⑨ normalizeList 构造用例 ──────────────────────────────
console.log("\n── ⑨ normalizeList 三形态归一（构造用例）──");
const listCases = [
  { name: "数组直用", input: ["a", "b", "c"], want: ["a", "b", "c"] },
  { name: "顿号字符串", input: "A) adjust（调整）、L) risk（风险）", want: ["A) adjust（调整）", "L) risk（风险）"] },
  { name: "换行字符串", input: "第一行\n第二行\n\n第三行", want: ["第一行", "第二行", "第三行"] },
  { name: "JSON 数组文本", input: '["x","y"]', want: ["x", "y"] },
  { name: "null", input: null, want: [] },
  { name: "空串", input: "", want: [] },
  { name: "数组含空项", input: ["a", " ", "b"], want: ["a", "b"] },
];
for (const testCase of listCases) {
  const got = normalizeList(testCase.input);
  if (JSON.stringify(got) !== JSON.stringify(testCase.want)) {
    fail(`normalizeList「${testCase.name}」应 ${JSON.stringify(testCase.want)}，实测 ${JSON.stringify(got)}`);
  }
}
if (!failed) ok(`${listCases.length} 个 normalizeList 用例通过`);

// ── ⑧ toBlankCard 180 空 + 两形态 ─────────────────────────
console.log("\n── ⑧ toBlankCard 180 空 + distractors 两形态 ──");
const blankRows = db
  .prepare("SELECT article_id, blank_no, answer_key, answer_word, reason, distractors FROM blank ORDER BY article_id, blank_no")
  .all();
console.log(`  库内 blank 行 ${blankRows.length}（期望 180）`);
if (blankRows.length !== 180) fail(`blank 行数应 180，实测 ${blankRows.length}`);
let blankOk = 0;
let stringForm = 0;
let arrayForm = 0;
let distTotal = 0;
const blankDetail = [];
for (const row of blankRows) {
  const parsedDistractors = (() => {
    if (row.distractors === null || row.distractors === undefined) return null;
    const text = String(row.distractors).trim();
    if (text.startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  })();
  const isArray = Array.isArray(parsedDistractors);
  if (isArray) arrayForm += 1;
  else stringForm += 1;
  const model = toBlankCard(
    {
      blankNo: row.blank_no,
      answerKey: row.answer_key,
      answerWord: row.answer_word,
      reason: row.reason,
      distractors: parsedDistractors,
    },
    row.blank_no,
  );
  const wantLen = isArray
    ? parsedDistractors.filter((item) => typeof item === "string" && item.trim() !== "").length
    : String(parsedDistractors ?? "")
        .split(/[、\n]/)
        .filter((item) => item.trim() !== "").length;
  if (model.empty) fail(`第 ${row.blank_no} 空被判为空（should not be empty）`);
  if (!model.answerWord || !model.answerKey) fail(`第 ${row.blank_no} 空缺答案词/字母`);
  if (model.distractors.length !== wantLen) {
    fail(`第 ${row.blank_no} 空 distractors 条数应 ${wantLen}（${isArray ? "数组" : "字符串"}形态），实测 ${model.distractors.length}`);
  }
  distTotal += model.distractors.length;
  blankDetail.push(`空 ${row.blank_no}(${isArray ? "array" : "string"})=${model.distractors.length} 条`);
  blankOk += 1;
}
console.log(`  逐空条数：${blankDetail.join(" / ")}`);
console.log(`  形态分布：array ${arrayForm} / string ${stringForm}（期望 10 / 170）；distractors 总条数 ${distTotal}`);
if (arrayForm !== 10 || stringForm !== 170) fail(`distractors 形态分布应 array 10 / string 170，实测 ${arrayForm}/${stringForm}`);
if (blankOk !== 180) fail(`180 空应全部有内容，实测 ${blankOk}`);

const blankEmpty = toBlankCard(null, 99);
console.log(`  无行降级：${JSON.stringify(blankEmpty)}`);
if (!blankEmpty.empty) fail(`无 blank 行时应 empty=true`);
if (blankEmpty.blankNo !== 99) fail(`无 blank 行时 blankNo 应保留 99，实测 ${blankEmpty.blankNo}`);
if (blankEmpty.distractors.length !== 0) fail(`无 blank 行时 distractors 应为空数组`);
if (!failed) ok(`180 空全部有内容；两形态条数逐空一致；无行降级成立`);

db.close();

console.log("");
if (failed) {
  console.error("FAIL[实现]: analysis.ts 未通过 M2 纯函数判据（详见上方 FAIL 行）");
  process.exit(1);
}
console.log(`PASS: parseMarkup 守恒 ${conserveOk}/${analysisRows.length} / fail-closed 恰 ${failedClosedSet.length} 句 / 五 kind 全覆盖 / 六段序固定 / 三态正确 / 180 空两形态逐条一致 / normalizeList 三形态`);
