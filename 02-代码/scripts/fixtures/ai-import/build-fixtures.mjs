#!/usr/bin/env node
/**
 * M5b D7：从仓库内 2024-06 三题型**完整内容包**派生门禁 fixture（02 §六.1，可复算）。
 *
 * 派生 = **字段规范化**，不做任何语义加工（02 §六.1 六条变换，逐条照做）：
 *   ① `paragraphs[].top`+`sentences[].text` → `sentences[] = {quote, analysis}`（拼原文；丢 start/end/tokens）
 *   ② `questions[]` 原样直通（`options` 已是 4 / 0 / 15 项）
 *   ③ `lexicon` 对象 map → 数组（值里没有 `word`，键即原型）
 *   ④ `blanks` 对象 map → `blankAnalyses[]`（键→no；`distractors` 字符串**丢弃**）
 *   ⑤ `meta.section` 中文 → `careful` / `long` / `cloze`
 *   ⑥ `packVersion` 改写为契约版本；丢 `sourceKey` / `articleId` / `meta`
 *
 * `expect.json` 的读数**从源包直接统计**（段/句/题/空/词条），不调用任何实现函数——
 * 否则就是「用被测实现自证」。派生脚本只负责字段搬运。
 *
 * 用法：`node scripts/fixtures/ai-import/build-fixtures.mjs`
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <项目根>/02-代码/scripts/fixtures/ai-import → 上溯 4 级到项目根（源包在 内容生成模板/output/）
const projectRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = here;

const PACK_VERSION = "2026.11.08-1";

/** 源包 → 输出名（02 §六.1：三题型各一份；`set1B` 本包不使用） */
const SOURCES = [
  { name: "careful", section: "careful", file: "cet4-2024-06-set1A.json" },
  { name: "long", section: "long", file: "cet4-2024-06-set1Long.json" },
  { name: "cloze", section: "cloze", file: "cet4-2024-06-set1Cloze.json" },
];

const SECTION_BY_CN = {
  仔细阅读: "careful",
  长篇阅读: "long",
  选词填空: "cloze",
};

const sourceDir = path.join(projectRoot, "内容生成模板", "output", "2024-06");
mkdirSync(outDir, { recursive: true });

const write = (name, value) => {
  const file = path.join(outDir, name);
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
  return file;
};

/** ① 原文纯文本：段间一空行 */
function buildText(pack) {
  return `${pack.paragraphs.map((paragraph) => paragraph.text).join("\n\n")}\n`;
}

/**
 * 切句口径差异的**显式声明**（实测发现，不是猜测）：
 *
 * 冻结切句器（`import_user.rs` 的 B-2 裁定）规定「命中缩写表即不断句」，`etc.` 在表内；
 * 而仓库内 2024-06 长篇内容包是**更早的口径**生成的，它在该处断成了两句。于是同一段原文：
 *   内容包：… retiring in comfort, etc. ｜ While those visions of our future selves …
 *   App  ：… retiring in comfort, etc. While those visions of our future selves …
 * → 长篇整篇 **47 句（源包）/ 46 句（App）**，差 1。
 *
 * 处置：把这两句按「合并后的原文 + 前一句的解析」写成**一条** payload 句（不做任何语义推断），
 * 并在 `expect.json` 里同时记 `sourceSentences: 47` 与 `sentences: 46`。
 * 声明式比对：命中 `firstPrefix` 且**下一句**命中 `secondPrefix` 才合并；一条都没命中就直接抛错，
 * 防止将来源包变了却静默漂移。
 */
const MERGED_SENTENCES = {
  long: [
    {
      firstPrefix: "When most of us set goals, we focus on long-term results",
      secondPrefix: "While those visions of our future selves can be inspiring",
    },
  ],
};

/** ①② 句级数组：`{sNo, quote, analysis}`；按 `MERGED_SENTENCES` 做声明式合并 */
function buildSentences(pack, section) {
  const flat = [];
  for (const paragraph of pack.paragraphs) {
    for (const sentence of paragraph.sentences) {
      flat.push(sentence);
    }
  }
  const merges = MERGED_SENTENCES[section] ?? [];
  const applied = [];
  const out = [];
  for (let index = 0; index < flat.length; index += 1) {
    const match = merges.find((group) => flat[index].text.startsWith(group.firstPrefix));
    const next = flat[index + 1];
    if (match && next && next.text.startsWith(match.secondPrefix)) {
      out.push({
        quote: `${flat[index].text} ${next.text}`,
        analysis: flat[index].analysis,
      });
      applied.push(match.firstPrefix);
      index += 1;
      continue;
    }
    out.push({ quote: flat[index].text, analysis: flat[index].analysis });
  }
  for (const group of merges) {
    if (!applied.includes(group.firstPrefix)) {
      throw new Error(`声明的合并句没有命中：${group.firstPrefix}（源包可能变了，请复核 MERGED_SENTENCES）`);
    }
  }
  return { sentences: out.map((item, index) => ({ sNo: `S${index + 1}`, ...item })), mergedCount: applied.length };
}

/** ①②③④⑤⑥ 契约 payload */
function buildPayload(pack, section) {
  const built = buildSentences(pack, section);
  const payload = {
    packVersion: PACK_VERSION,
    section,
    sentences: built.sentences,
    questions: (pack.questions ?? []).map((question) => ({
      no: question.no,
      stem: question.stem,
      options: (question.options ?? []).map((option) => ({ key: option.key, text: option.text })),
      answer: question.answer,
      ...(question.explanation ? { explanation: question.explanation } : {}),
    })),
  };
  if (section === "cloze") {
    payload.blankAnalyses = Object.entries(pack.blanks ?? {}).map(([no, blank]) => ({
      no: Number(no),
      answerWord: blank.answerWord,
      reason: blank.reason,
    }));
  }
  payload.lexicon = Object.entries(pack.lexicon ?? {}).map(([word, entry]) => {
    const { more, ...rest } = entry; // `more` 是源包私有字段，契约里没有（serde 也会忽略）
    return { word, ...rest };
  });
  return { payload, mergedCount: built.mergedCount };
}

/** 判据读数：段/题/空/词条**从源包统计**；句数按上面的声明式合并口径给出，并把源包数一并记下 */
function buildExpect(pack, section, sourceFile, built) {
  const paragraphs = pack.paragraphs.length;
  const sourceSentences = pack.paragraphs.reduce((sum, paragraph) => sum + paragraph.sentences.length, 0);
  const sentences = built.payload.sentences.length;
  const questions = (pack.questions ?? []).length;
  const blanks = Object.keys(pack.blanks ?? {}).length;
  const lexicon = Object.keys(pack.lexicon ?? {}).length;
  return {
    section,
    sourcePack: `内容生成模板/output/2024-06/${sourceFile}`,
    paragraphs,
    sentences,
    sourceSentences,
    mergedSentences: built.mergedCount,
    questions,
    blanks,
    lexicon,
    lexiconShape: "array",
    expectedCoverage: {
      analysis: `${sentences}/${sentences}`,
      questions: questions === 0 ? "-" : `${questions}/${questions}`,
      blanks: section === "cloze" ? `${blanks}/${blanks}` : "-",
      lexicon: String(lexicon),
    },
    ...(built.mergedCount > 0
      ? {
          note:
            `源包 ${sourceSentences} 句；冻结切句器 B-2（命中缩写表即不断句，` +
            `\`etc.\` 在表内）把其中两句合成一句 → App 侧实测 ${sentences} 句。` +
            `合并的那条 payload 用的是前一句的解析（零语义推断），详见 build-fixtures.mjs 的 MERGED_SENTENCES。`,
        }
      : {}),
  };
}

const built = {};
for (const source of SOURCES) {
  const packPath = path.join(sourceDir, source.file);
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  const mapped = SECTION_BY_CN[pack.meta?.section];
  if (mapped !== source.section) {
    throw new Error(
      `${source.file} 的 meta.section 是「${pack.meta?.section}」（映射 ${mapped}），与派生目标 ${source.section} 不符`,
    );
  }
  const text = buildText(pack);
  const built2 = buildPayload(pack, source.section);
  const payload = built2.payload;
  const expect = buildExpect(pack, source.section, source.file, built2);
  if (!Array.isArray(payload.lexicon)) {
    throw new Error(`${source.name} 的 lexicon 派生失败：必须是数组（lexiconShape 自检）`);
  }
  write(`${source.name}.text.txt`, text);
  write(`${source.name}.payload.json`, payload);
  write(`${source.name}.expect.json`, expect);
  built[source.name] = { text, payload, expect };
  console.log(
    `派生 ${source.name}：段 ${expect.paragraphs} / 句 ${expect.sentences} / 题 ${expect.questions} / 空 ${expect.blanks} / 词条 ${expect.lexicon}（lexiconShape=${typeof payload.lexicon === "object" && Array.isArray(payload.lexicon) ? "array" : "?"}）`,
  );
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// ───────────────────── 反例与边界（02 §六.4 表；R2 的 ⑥ 也在这里落地） ─────────────────────

// AC7① 长篇题目带选项
{
  const payload = clone(built.long.payload);
  payload.questions[0].options = [
    { key: "A", text: "选项 A" },
    { key: "B", text: "选项 B" },
    { key: "C", text: "选项 C" },
    { key: "D", text: "选项 D" },
  ];
  write("bad-type-long-with-options.payload.json", payload);
}

// AC7② 仔细阅读某题只剩 3 个选项
{
  const payload = clone(built.careful.payload);
  payload.questions[0].options = payload.questions[0].options.slice(0, 3);
  write("bad-type-careful-3options.payload.json", payload);
}

// AC7③ 选词填空某题只有 14 项词库
{
  const payload = clone(built.cloze.payload);
  payload.questions[0].options = payload.questions[0].options.slice(0, 14);
  write("bad-type-cloze-14options.payload.json", payload);
}

// AC7④ 选词填空题号与正文空号不一致（删掉最后一题 → 26~34 vs 26~35）
{
  const payload = clone(built.cloze.payload);
  payload.questions = payload.questions.filter((question) => question.no !== 35);
  write("bad-type-cloze-blanknos.payload.json", payload);
}

// AC7④ 选词填空「重号」：11 题，第 11 题重复 `no=26`（去重集合仍是 26~35 → 旧实现会静默放行）
{
  const payload = clone(built.cloze.payload);
  payload.questions = [...payload.questions, clone(payload.questions[0])];
  write("bad-type-cloze-dupno.payload.json", payload);
}

// AC7④ 缺省口径（02 §三.1）：cloze 去掉 `questions` → ④ 跳过、不拒收，10 条 blankAnalyses 照常入库
{
  const payload = clone(built.cloze.payload);
  delete payload.questions;
  write("cloze-no-questions.payload.json", payload);
}

// AC7⑤ payload.section 与本次所选题型不一致（内容按 careful，section 写 long）
{
  const payload = clone(built.careful.payload);
  payload.section = "long";
  write("bad-section-mismatch.payload.json", payload);
}

// AC7⑥ section 不在枚举内（R2：计划评审-v1.2 §三 要求执行期必补的那一份）
{
  const payload = clone(built.careful.payload);
  payload.section = "reading";
  write("bad-section-invalid.payload.json", payload);
}

// AC6 structMarkup 的 `_` 出现奇数次
{
  const payload = clone(built.careful.payload);
  payload.sentences[0].analysis.structMarkup = "【主语】People _谓语_ wonder _why";
  write("bad-markup-unbalanced.payload.json", payload);
}

// AC17 完全不可解析
write("bad-payload-notjson.txt", "这不是 JSON：我是 AI 的说明文字，没有任何花括号块。\n");

// AC13 围栏 + 前后说明文字
{
  const payload = clone(built.careful.payload);
  const text = [
    "下面是你要的解析，注意我按模板给了（说明文字应被忽略）：",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "如果 JSON 太长可以分批，我再补后面的。",
    "",
  ].join("\n");
  write("fenced-with-prose.payload.txt", text);
}

// AC18 编号与 quote 冲突（第 2 句写成 S99，quote 仍命中第 2 句）
{
  const payload = clone(built.careful.payload);
  payload.sentences[1].sNo = "S99";
  write("renumbered.payload.json", payload);
}

// §五 no-match：全部 quote 被改写 → AI_NO_MATCH
{
  const payload = clone(built.careful.payload);
  payload.sentences = payload.sentences.map((sentence, index) => ({
    ...sentence,
    quote: `这是被 AI 改写过的第 ${index + 1} 句，原文里当然找不到。`,
  }));
  write("no-match.payload.json", payload);
}

// AC4 只给 long 的前 20 句（覆盖率 20/47，仍可入库）
{
  const payload = clone(built.long.payload);
  payload.sentences = payload.sentences.slice(0, 20);
  delete payload.questions; // 部分提交不带题目，验「允许不完整」
  write("partial-20.payload.json", payload);
}

// AC16 答案不在选项内（不报错，归一为无答案）
{
  const payload = clone(built.careful.payload);
  payload.questions[0].answer = "Z";
  write("answer-out-of-options.payload.json", payload);
}

// AC15 词条不在正文（不进库，进 unmatched）
{
  const payload = clone(built.careful.payload);
  payload.lexicon = [...payload.lexicon, { word: "zebrafish", phonetic: "/ˈziːbrəfɪʃ/", pos: "n.", sense: "斑马鱼" }];
  write("lexicon-word-absent.payload.json", payload);
}

// §三.4 distractors 为字符串（按非必填忽略，不报错）
{
  const payload = clone(built.cloze.payload);
  payload.blankAnalyses = payload.blankAnalyses.map((blank) => ({
    ...blank,
    distractors: "D) difficult（困难的）、F) fixed（固定的）虽同为形容词，但与语境不合。",
  }));
  write("blank-distractors-string.payload.json", payload);
}

// AC2/AC9 分批：long 前 15 句 + 后 32 句（两次提交后 47/47，结构不变、词条不重复新增）
{
  const first = clone(built.long.payload);
  first.sentences = first.sentences.slice(0, 15);
  write("long-batch1.payload.json", first);
  const second = clone(built.long.payload);
  second.sentences = second.sentences.slice(15);
  write("long-batch2.payload.json", second);
}

// 计数自检（与 02 §六.2/§九 的口径对账）
const names = [
  "bad-type-long-with-options.payload.json",
  "bad-type-careful-3options.payload.json",
  "bad-type-cloze-14options.payload.json",
  "bad-type-cloze-blanknos.payload.json",
  "bad-type-cloze-dupno.payload.json",
  "cloze-no-questions.payload.json",
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
  "long-batch1.payload.json",
  "long-batch2.payload.json",
];
console.log(`反例与边界：${names.length} 个文件（02 §六.4：18 组 / 19 个文件）`);

// ─────────────── M5c D9：一体化素材（正文 + 题目 + 答案）→ 用户实测素材 + 门禁端到端 ───────────────
/**
 * 三题型各一份「一次粘贴」素材：
 *   `<type>.full.txt`          = 正文全文 + 题目区（含题干/选项/答案行）
 *   `<type>.full.payload.json` = 该素材对应的 AI 回包（题目带 `answerSource`）
 *
 * 放**独立目录** `scripts/fixtures/ai-import-full/`：`verify-ai-import.mjs` 的静态段断言
 * 「fixture 目录 29 个文件」是既有判据（只追加不改既有），新素材不能挤进同一目录。
 * 素材由本脚本生成而非手写 → 题号/选项/答案与 `paypack` 逐字一致（否则档 C 会因逐字比对被拒）。
 */
const fullOutDir = path.join(here, "..", "ai-import-full");
mkdirSync(fullOutDir, { recursive: true });
const writeFull = (name, value) => {
  const file = path.join(fullOutDir, name);
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
  return file;
};

/** 题目区文本：题干行 + 选项行 + 答案行（与 `parse_user_questions` 的口径一致） */
function buildQuestionArea(questions) {
  const lines = ["Directions: Read the passage and answer the questions below.", ""];
  for (const question of questions ?? []) {
    lines.push(`${question.no}. ${question.stem}`);
    for (const option of question.options ?? []) lines.push(`${option.key}. ${option.text}`);
    if (question.answer) lines.push(`答案 ${question.answer}`);
    lines.push("");
  }
  return lines.join("\n");
}

const FULL_SOURCES = ["careful", "long", "cloze"];
/** 题目区单独一份：档 C 的「只粘题目区」也要能当 `--questions` 入参（门禁与界面同用） */
const fullBuilt = {};
for (const name of FULL_SOURCES) {
  const source = built[name];
  const payload = clone(source.payload);
  // 素材里用户已给答案 → `answerSource: "user"`（AC8）；无答案的题写 `none`
  payload.questions = (payload.questions ?? []).map((question) => ({
    ...question,
    answerSource: question.answer ? "user" : "none",
  }));
  const fullText = `${source.text.trim()}\n\n${buildQuestionArea(payload.questions)}`;
  writeFull(`${name}.full.txt`, fullText);
  writeFull(`${name}.questions.txt`, buildQuestionArea(payload.questions));
  writeFull(`${name}.full.payload.json`, payload);
  fullBuilt[name] = {
    text: fullText,
    payload,
    questions: payload.questions.length,
    answered: payload.questions.filter((question) => question.answer).length,
  };
  console.log(
    `一体化素材 ${name}.full：正文 ${source.text.trim().length} 字符 + 题目 ${fullBuilt[name].questions} 道（带答案 ${fullBuilt[name].answered}）`,
  );
}
// AC7 反例（档 C）：题干被 AI 改写一处 → 必须 AI_QUESTION_MISMATCH
{
  const payload = clone(fullBuilt.careful.payload);
  payload.questions[0].stem = `${payload.questions[0].stem}（被 AI 改写）`;
  writeFull("bad-question-stem.payload.json", payload);
}
console.log(`一体化素材：${FULL_SOURCES.length * 3 + 1} 个文件 → ${path.relative(projectRoot, fullOutDir)}`);
