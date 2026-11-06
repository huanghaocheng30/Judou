#!/usr/bin/env node
/**
 * 句读（Judou）内容包自检脚本
 *
 * 用途：内容生成 Agent 生成 JSON 后，**自己跑这个脚本**验证格式是否正确。
 *      不通过就不要交付，按报错改。
 *
 * 用法：
 *   node 04-self-check.mjs <文章JSON> [更多文章JSON...]
 *   node 04-self-check.mjs cet4-2024-06-set1A.json cet4-2024-06-set1Cloze.json
 *   node 04-self-check.mjs content-pack/          # 目录：检查其中所有 *.json（跳过 manifest.json）
 *
 * 退出码：0 = 全通过；1 = 有错误（错误必须修）；2 = 脚本自身用法错误
 * 纯 Node 内置模块，无依赖，Node ≥ 18 即可。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// ─────────────────────────── 常量：与项目实现一致，勿改 ───────────────────────────

/** structMarkup 的五类标记（见 01-数据结构规范.md §六） */
const MARKERS = [
  { open: "【", close: "】", kind: "subject" },
  { open: "_", close: "_", kind: "predicate" },
  { open: "~", close: "~", kind: "object" },
  { open: "{", close: "}", kind: "clause" },
  { open: "(", close: ")", kind: "phrase" },
];

/** sentence.analysis 的九个字段（对应「六段式」卡片） */
const ANALYSIS_FIELDS = [
  "translationLiteral",
  "translationNatural",
  "structMarkup",
  "structureSummary",
  "components",
  "clauses",
  "phrases",
  "pitfalls",
  "paragraphRole",
];

/** 题型 → 该题型必须有的顶层字段与题目形态 */
const SECTION_RULES = {
  careful: { needBlanks: false, optionsPerQuestion: 4, answerPattern: /^[A-D]$/, label: "仔细阅读" },
  cloze: { needBlanks: true, optionsPerQuestion: 15, answerPattern: /^[A-O]$/, label: "选词填空" },
  long: { needBlanks: false, optionsPerQuestion: 0, answerPattern: /^[A-Z]$/, label: "长篇阅读（信息匹配）" },
};

/** 六级/四级题型中文名 → sectionType */
const SECTION_BY_LABEL = {
  仔细阅读: "careful",
  选词填空: "cloze",
  长篇阅读: "long",
  信息匹配: "long",
};

// ─────────────────────────── 报告器 ───────────────────────────

const errors = [];
const warnings = [];
let currentFile = "";

function err(where, message) {
  errors.push(`[${currentFile}] ${where}：${message}`);
}
function warn(where, message) {
  warnings.push(`[${currentFile}] ${where}：${message}`);
}

// ─────────────────────────── 工具 ───────────────────────────

const isStr = (v) => typeof v === "string" && v.length > 0;
const isInt = (v) => Number.isInteger(v);
const isArr = (v) => Array.isArray(v);

/** UTF-16 code unit 偏移切片（等价 JS string.slice，见 01 §五） */
function slice(text, start, end) {
  return text.slice(start, end);
}

// ─────────────────────────── 检查：结构 ───────────────────────────

function checkTopLevel(a) {
  for (const k of ["sourceKey", "articleId", "packVersion", "meta", "paragraphs", "questions", "lexicon"]) {
    if (a[k] === undefined) err("顶层", `缺字段 \`${k}\``);
  }
  if (a.packVersion !== undefined && !isStr(a.packVersion)) {
    err("顶层", "`packVersion` 必须是非空字符串");
  }
}

function checkMeta(a) {
  const m = a.meta ?? {};
  for (const k of ["examYear", "examMonth", "setNo", "section", "passageLabel", "title", "wordCount"]) {
    if (m[k] === undefined) err("meta", `缺字段 \`${k}\``);
  }
  if (m.examYear !== undefined && !isInt(m.examYear)) err("meta.examYear", "必须是整数（如 2023）");
  if (m.examMonth !== undefined && !isInt(m.examMonth)) err("meta.examMonth", "必须是整数（1~12）");
  if (m.setNo !== undefined && !isInt(m.setNo)) err("meta.setNo", "必须是整数（1~3）");

  const sectionType = SECTION_BY_LABEL[m.section];
  if (m.section !== undefined && !sectionType) {
    err("meta.section", `必须取 ${Object.keys(SECTION_BY_LABEL).join(" / ")} 之一，实际是「${m.section}」`);
  }
  if (m.title !== undefined && !isStr(m.title)) err("meta.title", "不能为空");
  return sectionType ?? null;
}

// ─────────────────────────── 检查：段落 / 句子 / 词 ───────────────────────────

function checkParagraphs(a) {
  if (!isArr(a.paragraphs) || a.paragraphs.length === 0) {
    err("paragraphs", "必须是非空数组");
    return { sentenceTotal: 0, tokenTotal: 0 };
  }

  let sentenceTotal = 0;
  let tokenTotal = 0;
  const seenSentenceStarts = new Set();

  a.paragraphs.forEach((p, pi) => {
    const where = `paragraphs[${pi}]`;

    if (p.idx !== pi) err(where, `\`idx\` 必须是 ${pi}（必须从 0 连续递增），实际 ${p.idx}`);
    if (!isStr(p.text)) {
      err(where, "`text` 不能为空");
      return;
    }
    if (!isArr(p.sentences) || p.sentences.length === 0) {
      err(where, "`sentences` 必须是非空数组");
      return;
    }

    p.sentences.forEach((s, si) => {
      const sw = `${where}.sentences[${si}]`;

      if (s.idx !== si) err(sw, `\`idx\` 必须是 ${si}（段内从 0 连续递增），实际 ${s.idx}`);
      if (!isStr(s.text)) {
        err(sw, "`text` 不能为空");
        return;
      }
      sentenceTotal += 1;

      // start/end 相对 paragraph.text
      if (!isInt(s.start) || !isInt(s.end)) {
        err(sw, "`start`/`end` 必须是整数");
      } else {
        if (s.start < 0 || s.end > p.text.length || s.start >= s.end) {
          err(sw, `\`start\`/\`end\` 越界或反了：${s.start}~${s.end}，段落长度 ${p.text.length}`);
        } else {
          const sliced = slice(p.text, s.start, s.end);
          if (sliced !== s.text) {
            err(
              sw,
              `start/end 切片与 text 不一致。切片得「${sliced.slice(0, 60)}」，text 是「${s.text.slice(0, 60)}」`,
            );
          }
        }
        const key = `${pi}:${s.start}`;
        if (seenSentenceStarts.has(key)) warn(sw, `与同段其他句子 start 相同（${s.start}），可能重复`);
        seenSentenceStarts.add(key);
      }

      // analysis 九字段
      const an = s.analysis;
      if (!an || typeof an !== "object") {
        err(sw, "缺 `analysis`");
      } else {
        for (const f of ANALYSIS_FIELDS) {
          if (an[f] === undefined) err(`${sw}.analysis`, `缺字段 \`${f}\``);
        }
        for (const f of ["translationLiteral", "translationNatural", "structureSummary", "paragraphRole"]) {
          if (an[f] !== undefined && !isStr(an[f])) err(`${sw}.analysis.${f}`, "必须是非空字符串");
        }
        for (const f of ["clauses", "pitfalls"]) {
          if (an[f] !== undefined && !isArr(an[f])) err(`${sw}.analysis.${f}`, "必须是字符串数组");
          if (isArr(an[f]) && an[f].some((x) => !isStr(x))) err(`${sw}.analysis.${f}`, "数组元素必须是非空字符串");
        }
        if (an.components !== undefined) {
          if (!isArr(an.components)) err(`${sw}.analysis.components`, "必须是数组");
          else
            an.components.forEach((c, ci) => {
              for (const k of ["part", "role", "note"]) {
                if (!isStr(c?.[k])) err(`${sw}.analysis.components[${ci}]`, `缺 \`${k}\` 或为空`);
              }
            });
        }
        if (an.phrases !== undefined) {
          if (!isArr(an.phrases)) err(`${sw}.analysis.phrases`, "必须是数组");
          else
            an.phrases.forEach((ph, phi) => {
              for (const k of ["text", "meaning", "usage", "example"]) {
                if (!isStr(ph?.[k])) err(`${sw}.analysis.phrases[${phi}]`, `缺 \`${k}\` 或为空`);
              }
            });
        }
        if (isStr(an.structMarkup)) checkStructMarkup(sw, an.structMarkup);
      }

      // tokens
      if (!isArr(s.tokens) || s.tokens.length === 0) {
        err(sw, "`tokens` 必须是非空数组");
        return;
      }
      tokenTotal += s.tokens.length;

      let lastEnd = 0;
      s.tokens.forEach((t, ti) => {
        const tw = `${sw}.tokens[${ti}]`;
        if (!isInt(t.start) || !isInt(t.end)) {
          err(tw, "`start`/`end` 必须是整数");
          return;
        }
        if (t.start >= t.end) err(tw, `start 必须小于 end（${t.start} >= ${t.end}）`);
        if (t.start < 0 || t.end > s.text.length) {
          err(tw, `越界：${t.start}~${t.end}，句子长度 ${s.text.length}`);
          return;
        }
        if (t.start < lastEnd) warn(tw, `与上一个 token 重叠或被包含（上一个 end=${lastEnd}）`);
        lastEnd = Math.max(lastEnd, t.end);

        const sliced = slice(s.text, t.start, t.end);
        if (!isStr(t.surface)) err(tw, "`surface` 不能为空");
        else if (sliced !== t.surface) {
          err(tw, `start/end 切片得「${sliced}」，与 surface「${t.surface}」不一致`);
        }

        if (typeof t.isWord !== "boolean") err(tw, "`isWord` 必须是布尔");
        if (t.isWord === true) {
          if (!isStr(t.normalized)) err(tw, "isWord=true 时 `normalized` 必须是非空小写词形");
        } else {
          // 现有内容包 6699 个 token 中 879 个（13%）是标点/符号，其 normalized 为 null。
          // 规范：isWord=false 时 normalized 允许 null 或 ""（二者项目都接受）。
          if (t.normalized !== null && typeof t.normalized !== "string") {
            err(tw, "isWord=false 时 `normalized` 必须是 null 或字符串");
          } else if (typeof t.normalized === "string" && t.normalized !== "") {
            warn(tw, `isWord=false 时 normalized 建议为 null 或空串，实际「${t.normalized}」`);
          }
        }
      });
    });
  });

  return { sentenceTotal, tokenTotal };
}

function checkStructMarkup(sw, markup) {
  const where = `${sw}.analysis.structMarkup`;
  // _ 与 ~ 必须成对，否则项目实现会 fail-closed 退化（见 01 §六）。
  // 现有内容包**确实有 7 句**未闭合（项目已知白名单），故这里只告警不判错——
  // 但新生成的数据**不要**制造这种句子：它在界面上会整串变成纯文本、丢掉成分标注。
  for (const ch of ["_", "~"]) {
    const n = markup.split(ch).length - 1;
    if (n % 2 === 1) {
      warn(
        where,
        `\`${ch}\` 出现 ${n} 次（奇数），标记未闭合 → 项目会整串退化为纯文本、丢掉成分标注。` +
          `现有内容包有 7 句如此（已知白名单），**新数据请避免**`,
      );
    }
  }
  if (!/【|_|~|\{|\(/.test(markup)) {
    warn(where, "没有任何标记符，符号句将显示为纯文本");
  }
  // 括号类必须配对
  for (const [open, close] of [["【", "】"], ["{", "}"], ["(", ")"]]) {
    const o = markup.split(open).length - 1;
    const c = markup.split(close).length - 1;
    if (o !== c) err(where, `\`${open}\` 出现 ${o} 次但 \`${close}\` 出现 ${c} 次，不配对`);
  }
}

// ─────────────────────────── 检查：题目 ───────────────────────────

function checkQuestions(a, sectionType) {
  if (!isArr(a.questions) || a.questions.length === 0) {
    err("questions", "必须是非空数组");
    return;
  }
  const rule = SECTION_RULES[sectionType];
  if (!rule) return; // sectionType 已经报过错

  const seenNo = new Set();
  a.questions.forEach((q, qi) => {
    const where = `questions[${qi}]`;
    if (!isInt(q.no)) err(where, "`no` 必须是整数（题号）");
    else {
      if (seenNo.has(q.no)) err(where, `题号 ${q.no} 重复`);
      seenNo.add(q.no);
    }
    if (!isStr(q.stem)) err(where, "`stem` 不能为空");
    if (!isArr(q.options)) err(where, "`options` 必须是数组");
    if (!isStr(q.answer)) {
      err(where, "`answer` 不能为空");
    } else if (!rule.answerPattern.test(q.answer)) {
      err(where, `answer「${q.answer}」不符合 ${rule.label} 的形态（应匹配 ${rule.answerPattern}）`);
    }

    if (isArr(q.options)) {
      if (q.options.length !== rule.optionsPerQuestion) {
        err(where, `options 应有 ${rule.optionsPerQuestion} 项（${rule.label}），实际 ${q.options.length}`);
      }
      const keys = new Set();
      q.options.forEach((o, oi) => {
        if (!isStr(o?.key)) err(`${where}.options[${oi}]`, "缺 `key`");
        else {
          if (keys.has(o.key)) err(`${where}.options[${oi}]`, `key「${o.key}」重复`);
          keys.add(o.key);
        }
        if (!isStr(o?.text)) err(`${where}.options[${oi}]`, "缺 `text` 或为空");
      });
      // answer 必须落在 options 的 key 里（long 型无 options，跳过）
      if (rule.optionsPerQuestion > 0 && isStr(q.answer) && keys.size > 0 && !keys.has(q.answer)) {
        err(where, `answer「${q.answer}」不在 options 的 key 里（有：${[...keys].join(",")}）`);
      }
    }
  });
}

// ─────────────────────────── 检查：选词填空专用 ───────────────────────────

function checkBlanks(a, sectionType) {
  const rule = SECTION_RULES[sectionType];
  if (!rule?.needBlanks) {
    if (a.blanks !== undefined || a.wordBank !== undefined) {
      warn("顶层", "非选词填空题型不应有 `blanks`/`wordBank`，建议删除");
    }
    return;
  }

  if (!isArr(a.blankNos) || a.blankNos.length === 0) err("blankNos", "选词填空必须有非空数组");
  if (!isArr(a.wordBank) || a.wordBank.length === 0) err("wordBank", "选词填空必须有非空数组");
  if (!a.blanks || typeof a.blanks !== "object") {
    err("blanks", "选词填空必须有对象（键=题号，值=解析）");
    return;
  }

  const nos = isArr(a.blankNos) ? a.blankNos : [];
  const bankKeys = new Set((isArr(a.wordBank) ? a.wordBank : []).map((w) => w?.key));

  // wordBank 结构
  if (isArr(a.wordBank)) {
    if (a.wordBank.length !== 15) warn("wordBank", `标准选词填空词库是 15 个（A~O），实际 ${a.wordBank.length}`);
    const seen = new Set();
    a.wordBank.forEach((w, wi) => {
      if (!isStr(w?.key)) err(`wordBank[${wi}]`, "缺 `key`");
      else {
        if (seen.has(w.key)) err(`wordBank[${wi}]`, `key「${w.key}」重复`);
        seen.add(w.key);
      }
      if (!isStr(w?.word)) err(`wordBank[${wi}]`, "缺 `word`");
    });
  }

  // blankNos ↔ blanks 一一对应
  for (const no of nos) {
    const b = a.blanks[String(no)];
    if (!b) {
      err(`blanks.${no}`, `blankNos 里有 ${no}，但 blanks 里没有对应解析`);
      continue;
    }
    if (!isStr(b.answerKey)) err(`blanks.${no}`, "缺 `answerKey`");
    else if (bankKeys.size > 0 && !bankKeys.has(b.answerKey)) {
      err(`blanks.${no}`, `answerKey「${b.answerKey}」不在 wordBank 的 key 里`);
    }
    if (!isStr(b.answerWord)) err(`blanks.${no}`, "缺 `answerWord`");
    if (!isStr(b.reason)) err(`blanks.${no}`, "缺 `reason`（解析理由，必填）");
    if (!isStr(b.distractors)) err(`blanks.${no}`, "缺 `distractors`（干扰项分析，必填）");
  }
  // 反向：blanks 里多余的键
  for (const k of Object.keys(a.blanks)) {
    if (!nos.includes(Number(k))) warn(`blanks.${k}`, "不在 blankNos 里（多余）");
  }

  // 空号必须在正文里出现（项目靠 token.surface 是纯数字来定位空号）
  const allText = (a.paragraphs ?? []).map((p) => p.text ?? "").join(" ");
  for (const no of nos) {
    if (!new RegExp(`(^|[^0-9])${no}([^0-9]|$)`).test(allText)) {
      err(`blankNos`, `空号 ${no} 没有在正文里出现（正文必须包含字面数字 ${no} 作为空格占位）`);
    }
  }

  // 每题与空号对应
  const qNos = new Set((a.questions ?? []).map((q) => q.no));
  for (const no of nos) {
    if (!qNos.has(no)) err("questions", `空号 ${no} 没有对应题目`);
  }
}

// ─────────────────────────── 检查：词表 ───────────────────────────

function checkLexicon(a) {
  const lex = a.lexicon;
  if (!lex || typeof lex !== "object") {
    err("lexicon", "必须是对象（键=小写词形）");
    return;
  }
  const entries = Object.entries(lex);
  if (entries.length === 0) err("lexicon", "不能为空对象");

  // 正文里出现的所有 normalized 词形
  const inText = new Set();
  for (const p of a.paragraphs ?? []) {
    for (const s of p.sentences ?? []) {
      for (const t of s.tokens ?? []) {
        if (t.isWord === true && isStr(t.normalized)) inText.add(t.normalized.toLowerCase());
      }
    }
  }

  entries.forEach(([word, v], i) => {
    const where = `lexicon["${word}"]`;
    if (word !== word.toLowerCase()) warn(where, "键建议全小写");
    if (!inText.has(word.toLowerCase())) {
      warn(where, "该词未在正文 token 中出现（可能是多余条目）");
    }
    if (!v || typeof v !== "object") {
      err(where, "值必须是对象");
      return;
    }
    if (!isStr(v.phonetic)) err(where, "缺 `phonetic`（音标，如 /əˈbɪləti/）");
    if (!isStr(v.pos)) err(where, "缺 `pos`（词性缩写，如 n. / v. / adj.）");
    if (!isStr(v.sense)) err(where, "缺 `sense`（语境义/常用义）");
    if (!isArr(v.collocations)) err(where, "缺 `collocations`（数组，可为空数组）");
    if (!isArr(v.examples)) err(where, "缺 `examples`（数组，可为空数组；每项需含中文译文）");
    if (typeof v.isCet4HighFreq !== "boolean") err(where, "`isCet4HighFreq` 必须是布尔");
    if (v.more !== undefined && (typeof v.more !== "object" || v.more === null)) {
      err(where, "`more` 若存在必须是对象");
    } else if (v.more) {
      for (const k of ["roots", "confusables"]) {
        if (v.more[k] !== undefined && typeof v.more[k] !== "string") err(`${where}.more.${k}`, "必须是字符串");
      }
    }
    if (isArr(v.examples)) {
      v.examples.forEach((ex, ei) => {
        if (!isStr(ex)) err(`${where}.examples[${ei}]`, "必须是非空字符串");
        else if (!/[\u4e00-\u9fa5]/.test(ex)) warn(`${where}.examples[${ei}]`, "例句建议带中文译文");
      });
    }
    // 高频词条数提示
    void i;
  });
}

// ─────────────────────────── 检查：跨字段一致性 ───────────────────────────

function checkConsistency(a, counts) {
  const m = a.meta ?? {};

  // wordCount 口径：正文（段落 text 拼接）的「词」数 = 所有 isWord token 数
  const declared = m.wordCount;
  if (isInt(declared)) {
    const actualTokens = counts.tokenTotal;
    const ratio = actualTokens / Math.max(1, declared);
    // 项目里 wordCount 是「原文词数」，token 数会略多于词数（缩写、连字符拆分）。
    // 只做宽松告警，不强判（见 02 §四）。
    if (ratio < 0.85 || ratio > 1.35) {
      warn(
        "meta.wordCount",
        `声明 ${declared}，但 token 总数 ${actualTokens}（比例 ${ratio.toFixed(2)}）。` +
          `若差异大，检查 wordCount 是否按「原文词数」而非 token 数填`,
      );
    }
  }

  // 段落/句子数量提示（不硬判，因各题型差异）
  const paraCount = (a.paragraphs ?? []).length;
  const sentCount = counts.sentenceTotal;
  if (paraCount === 0) err("paragraphs", "段落数为 0");
  if (sentCount === 0) err("sentences", "句子数为 0");

  // sourceKey 与文件名/内容一致性
  if (isStr(a.sourceKey) && isStr(m.title)) {
    const keyWords = a.sourceKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (keyWords.length < 6) warn("sourceKey", "过短，建议形如 cet4-2024-06-set1A");
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

function checkOne(path) {
  currentFile = basename(path);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    err("文件", `读不到：${e.message}`);
    return;
  }

  // BOM / 控制字符检查
  if (raw.charCodeAt(0) === 0xfeff) err("文件", "有 UTF-8 BOM，必须去掉（用 UTF-8 无 BOM）");
  const NUL = (raw.match(/\u0000/g) ?? []).length;
  const BEL = (raw.match(/\u0007/g) ?? []).length;
  if (NUL > 0) err("文件", `含 ${NUL} 个 NUL 字符（0x00），写入时被截断了`);
  if (BEL > 0) err("文件", `含 ${BEL} 个 BEL 字符（0x07），疑似转义事故`);

  let a;
  try {
    a = JSON.parse(raw);
  } catch (e) {
    err("JSON", `解析失败：${e.message}`);
    return;
  }

  checkTopLevel(a);
  const sectionType = checkMeta(a);
  const counts = checkParagraphs(a);
  if (sectionType) checkQuestions(a, sectionType);
  if (sectionType) checkBlanks(a, sectionType);
  checkLexicon(a);
  checkConsistency(a, counts);

  const ok = errors.filter((e) => e.includes(`[${currentFile}]`)).length === 0;
  console.log(
    `${ok ? "✓" : "✗"} ${currentFile}  ` +
      `段落 ${(a.paragraphs ?? []).length} / 句 ${counts.sentenceTotal} / 词 ${counts.tokenTotal} / ` +
      `题 ${(a.questions ?? []).length} / 词表 ${Object.keys(a.lexicon ?? {}).length}` +
      (sectionType ? `  题型=${sectionType}` : ""),
  );
}

function collectJson(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".json") && f !== "manifest.json")
      .map((f) => join(path, f));
  }
  return [path];
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("用法：node 04-self-check.mjs <文章JSON 或 目录> [更多...]");
  process.exit(2);
}

const files = [];
for (const arg of args) {
  try {
    files.push(...collectJson(arg));
  } catch (e) {
    console.error(`✗ 路径无效：${arg}（${e.message}）`);
    process.exit(2);
  }
}
if (files.length === 0) {
  console.error("✗ 没找到任何 .json 文件");
  process.exit(2);
}

console.log(`\n句读内容包自检 · ${files.length} 个文件\n`);
for (const f of files) checkOne(f);

console.log("");
if (warnings.length > 0) {
  console.log(`⚠ 告警 ${warnings.length} 条（不阻塞，但建议改）：`);
  for (const w of warnings) console.log(`  ${w}`);
  console.log("");
}
if (errors.length > 0) {
  console.log(`✗ 错误 ${errors.length} 条（**必须修**，否则导入会失败或被拒）：`);
  for (const e of errors) console.log(`  ${e}`);
  console.log("");
  process.exit(1);
}

console.log("✓ 全部通过。可以交付。\n");
process.exit(0);