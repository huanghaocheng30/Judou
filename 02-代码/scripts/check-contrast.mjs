#!/usr/bin/env node
/**
 * AC4 断言：从 src/styles/tokens.css 解析浅/深两套变量，按 WCAG 2.x 相对亮度算对比度。
 * 门槛（02 §四 AC4）：正文/背景 ≥ 4.5:1；标注色/背景 ≥ 3:1。
 *
 * ponytail: 直接读 CSS 文本 + 正则取 --var:#hex，不引 CSS 解析器——
 * 变量块结构是自有的且只有两块，等样式拆分文件/多层 @media 再上 postcss。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(root, "src", "styles", "tokens.css");

if (!existsSync(cssPath)) {
  console.error(`FAIL: tokens.css 不存在：${cssPath}`);
  process.exit(1);
}

const css = readFileSync(cssPath, "utf8");

/** 取第一个匹配 `selector { ... }` 的块体（tokens.css 里各主题块只出现一次） */
function block(selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const m = css.match(re);
  if (!m) throw new Error(`tokens.css 里找不到块 ${selector}`);
  return m[1];
}

function parseVars(body) {
  const vars = {};
  for (const line of body.split(/\r?\n/)) {
    for (const m of line.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) vars[m[1]] = m[2];
  }
  return vars;
}

function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 相对亮度 */
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

let themes;
try {
  themes = {
    light: parseVars(block(":root")),
    dark: parseVars(block('[data-theme="dark"]')),
  };
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

const BODY = [["--ink", "正文墨色"]];
const ANNOTATION = [
  ["--blue", "成分标注·靛蓝"],
  ["--rose", "宾语标注·玫红"],
  ["--green", "正向标注·绿"],
  ["--accent", "主按钮/选中词·陶土橘"],
];
const REQUIRED_VARS = ["--paper", "--paper-2", "--paper-3", "--ink", "--ink-2", "--ink-3", "--line", "--blue", "--rose", "--green", "--accent"];

let failed = false;
const rows = [];

for (const [theme, vars] of Object.entries(themes)) {
  const missing = REQUIRED_VARS.filter((v) => !vars[v]);
  if (missing.length) {
    console.error(`FAIL: [${theme}] 缺变量 ${missing.join(", ")}`);
    failed = true;
    continue;
  }
  const bg = vars["--paper"];
  for (const [name, label] of BODY) {
    const ratio = contrast(vars[name], bg);
    const ok = ratio >= 4.5;
    rows.push({ theme, pair: `${label} ${name} on --paper`, fg: vars[name], bg, ratio, threshold: 4.5, ok });
    if (!ok) failed = true;
  }
  for (const [name, label] of ANNOTATION) {
    const ratio = contrast(vars[name], bg);
    const ok = ratio >= 3.0;
    rows.push({ theme, pair: `${label} ${name} on --paper`, fg: vars[name], bg, ratio, threshold: 3.0, ok });
    if (!ok) failed = true;
  }
  // 次要文字（信息性，不参与判据）
  for (const name of ["--ink-2", "--ink-3"]) {
    rows.push({ theme, pair: `次要 ${name} on --paper（信息项）`, fg: vars[name], bg, ratio: contrast(vars[name], bg), threshold: null, ok: true });
  }
}

// 组件配对：「文字色 on 填充色」（R-1：既有 10 项只测「变量色 on --paper」，不覆盖组件填充底）
// ponytail: 只做三条代表配对；全量组件映射待样式拆模块后再上 CSS 解析器。
const appCss = readFileSync(path.join(root, "src", "styles", "app.css"), "utf8");
const blockBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (appCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`)) || [])[1] || "";
};
const segOnBody = blockBody(".seg.on");
// D-M0-6（M0 遗留债务）：`.tag` 是「强调色文字 on accent-soft 填充」，M0 实测浅色 3.73:1 不达标。
// 每个主题各成一项判据（不是 +1）：既有 14 项 + 2 = 16 项。
const tagBody = blockBody(".tag");
const declOf = (body, prop) => (body.match(new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`)) || [])[1]?.trim() || null;
const resolveColor = (value, vars) => {
  const ref = value && value.match(/var\(\s*(--[a-z0-9-]+)\s*\)/);
  return ref ? vars[ref[1]] : value;
};
const COMPONENT_PAIRS = [
  ["选中态 .seg.on（文字 on 自身填充）", declOf(segOnBody, "color"), declOf(segOnBody, "background"), 4.5],
  ["按钮 .btn（--ink-2 on --paper）", "var(--ink-2)", "var(--paper)", 4.5],
  ["标签 .tag（文字 on 自身填充）", declOf(tagBody, "color"), declOf(tagBody, "background"), 4.5],
];
for (const [theme, vars] of Object.entries(themes)) {
  for (const [label, fgRaw, bgRaw, threshold] of COMPONENT_PAIRS) {
    const fg = resolveColor(fgRaw, vars);
    const bg = resolveColor(bgRaw, vars);
    if (!fg || !bg) { console.error(`FAIL: [${theme}] 组件配对取色失败：${label}`); failed = true; continue; }
    const ratio = contrast(fg, bg);
    rows.push({ theme, pair: label, fg, bg, ratio, threshold, ok: ratio >= threshold });
    if (ratio < threshold) failed = true;
  }
}

// ── M2 D10（AC3）：五种符号标记的标注色配对。每主题 5 项 → 判据项 16 + 10 = 26 ──
// 取色口径：subject 是「文字 on 自身轻底」；其余四种是「装饰线/文字色 on 卡片底 --paper-2」。
// 门槛按 AC3：主/谓/宾类 ≥3:1（除颜色外还有下划线/波浪线/轻底等形状通道）；从句/短语类 ≥4.5:1（承载正文语义）。
// 文字色**直接从 app.css 的 .mk-* 解析**（不手抄），改样式色值即反映到判据；
// 只有下划线/波浪线的颜色藏在 text-decoration 简写里，才用显式期望值 + 包含性断言（见下）。
const MK_BODIES = {
  subject: blockBody(".mk-subject"),
  predicate: blockBody(".mk-predicate"),
  object: blockBody(".mk-object"),
  clause: blockBody(".mk-clause"),
  phrase: blockBody(".mk-phrase"),
};
const MK_PAIRS = [
  ["标记·主语 .mk-subject（文字 on 自身轻底）", declOf(MK_BODIES.subject, "color"), declOf(MK_BODIES.subject, "background"), 3.0],
  ["标记·谓语下划线 .mk-predicate（下划线色 on 卡片底）", "var(--accent)", "var(--paper-2)", 3.0],
  ["标记·宾语波浪线 .mk-object（波浪线色 on 卡片底）", "var(--green)", "var(--paper-2)", 3.0],
  ["标记·从句 .mk-clause（文字 on 卡片底）", declOf(MK_BODIES.clause, "color"), "var(--paper-2)", 4.5],
  ["标记·短语 .mk-phrase（文字 on 卡片底）", declOf(MK_BODIES.phrase, "color"), "var(--paper-2)", 4.5],
];

// 形状通道 + 装饰线取色防漂移：
// predicate = 实线下划线（`text-decoration: underline` + `text-decoration-color: var(--accent)`，
// 颜色写在独立属性里）；object = 波浪线（`text-decoration: underline wavy var(--green)`，颜色在简写里）。
const DECORATION = [
  ["predicate", "text-decoration", "underline"],
  ["predicate", "text-decoration-color", "var(--accent)"],
  ["object", "text-decoration", "wavy"],
  ["object", "text-decoration", "var(--green)"],
];
for (const [key, prop, expect] of DECORATION) {
  const value = declOf(MK_BODIES[key], prop);
  if (!value || !value.includes(expect)) {
    console.error(`FAIL: app.css 的 .mk-${key} ${prop} 应含 ${expect}（实际 ${value}）`);
    failed = true;
  }
}
for (const [key, body] of Object.entries(MK_BODIES)) {
  if (!body) {
    console.error(`FAIL: app.css 缺少 .mk-${key} 规则`);
    failed = true;
  }
}

for (const [theme, vars] of Object.entries(themes)) {
  for (const [label, fgRaw, bgRaw, threshold] of MK_PAIRS) {
    const fg = resolveColor(fgRaw, vars);
    const bg = resolveColor(bgRaw, vars);
    if (!fg || !bg) { console.error(`FAIL: [${theme}] 标记配对取色失败：${label}`); failed = true; continue; }
    const ratio = contrast(fg, bg);
    rows.push({ theme, pair: label, fg, bg, ratio, threshold, ok: ratio >= threshold });
    if (ratio < threshold) failed = true;
  }
}

// ── TP-修复1 F2（AC-R2）：句末「析」角标 + 句子 hover 反馈的对比度配对。每主题 2 项 → 判据项 26 + 4 = 30 ──
// 取色口径：
// - `.sentence-mark` 是「标注色文字 on 正文底」，门槛按标注色 ≥3:1（角标是提示、非正文语义）；
// - `.sentence:hover` 只改背景，文字**继承**正文墨色 `--ink`（规则里没有 color 声明），
//   所以前景显式取 `var(--ink)`、背景取该规则自己的 `background`，门槛按正文 ≥4.5:1。
const SENTENCE_MARK_BODY = blockBody(".sentence-mark");
const SENTENCE_HOVER_BODY = blockBody(".sentence:hover");
if (!SENTENCE_MARK_BODY) {
  console.error("FAIL: app.css 缺少 .sentence-mark 规则（句末角标，AC-R2）");
  failed = true;
}
if (!SENTENCE_HOVER_BODY) {
  console.error("FAIL: app.css 缺少 .sentence:hover 规则（句子可点反馈，AC-R2）");
  failed = true;
}
const SENTENCE_PAIRS = [
  ["句末角标 .sentence-mark（标注色 on 正文底 --paper）", declOf(SENTENCE_MARK_BODY, "color"), "var(--paper)", 3.0],
  // hover 只改底色：写的是 `background-color`（简写会清掉 `.tok` 的笔记圆点），两种写法都取，防样式写法回退
  [
    "句子 hover 反馈 .sentence:hover（正文色 --ink on 悬停底）",
    "var(--ink)",
    declOf(SENTENCE_HOVER_BODY, "background-color") ?? declOf(SENTENCE_HOVER_BODY, "background"),
    4.5,
  ],
];
for (const [theme, vars] of Object.entries(themes)) {
  for (const [label, fgRaw, bgRaw, threshold] of SENTENCE_PAIRS) {
    const fg = resolveColor(fgRaw, vars);
    const bg = resolveColor(bgRaw, vars);
    if (!fg || !bg) { console.error(`FAIL: [${theme}] 句子标记配对取色失败：${label}`); failed = true; continue; }
    const ratio = contrast(fg, bg);
    rows.push({ theme, pair: label, fg, bg, ratio, threshold, ok: ratio >= threshold });
    if (ratio < threshold) failed = true;
  }
}

// ── M3 D8（AC7）：生词本掌握状态三档 + 点回原句高亮态。每主题 4 项 → 判据项 30 + 8 = 38 ──
// 取色口径：
// - `.mastery-new/fuzzy/known` 只改边框与底色，文字**继承** `.vocab-mastery` 的 `color`；
//   所以前景优先读规则自身的 color，没有再回落 `.vocab-mastery` 的 color 与 `var(--ink)`
//   （样式将来改了色值也会被这条如实测到，不是抄一份期望值）。
// - `.sentence-flash` 是「正文色 on 高亮底」，门槛按正文 ≥4.5:1；
//   底色只写 `background-color`（`background` 简写会清掉既有背景），两种写法都取。
const MASTERY_BASE_BODY = blockBody(".vocab-mastery");
const MASTERY_BODIES = {
  new: blockBody(".mastery-new"),
  fuzzy: blockBody(".mastery-fuzzy"),
  known: blockBody(".mastery-known"),
};
const SENTENCE_FLASH_BODY = blockBody(".sentence-flash");
if (!MASTERY_BASE_BODY) {
  console.error("FAIL: app.css 缺少 .vocab-mastery 规则（掌握状态徽标，AC7）");
  failed = true;
}
for (const [key, body] of Object.entries(MASTERY_BODIES)) {
  if (!body) {
    console.error(`FAIL: app.css 缺少 .mastery-${key} 规则（掌握状态三档之一，AC7）`);
    failed = true;
  }
}
if (!SENTENCE_FLASH_BODY) {
  console.error("FAIL: app.css 缺少 .sentence-flash 规则（点回原句高亮，AC5）");
  failed = true;
}
const masteryForeground = (body) =>
  declOf(body, "color") ?? declOf(MASTERY_BASE_BODY, "color") ?? "var(--ink)";
const MASTERY_PAIRS = [
  ["掌握状态·新词 .mastery-new（文字 on 自身填充）", masteryForeground(MASTERY_BODIES.new), declOf(MASTERY_BODIES.new, "background"), 4.5],
  ["掌握状态·模糊 .mastery-fuzzy（文字 on 自身填充）", masteryForeground(MASTERY_BODIES.fuzzy), declOf(MASTERY_BODIES.fuzzy, "background"), 4.5],
  ["掌握状态·已掌握 .mastery-known（文字 on 自身填充）", masteryForeground(MASTERY_BODIES.known), declOf(MASTERY_BODIES.known, "background"), 4.5],
  [
    "点回原句高亮 .sentence-flash（正文色 on 高亮底）",
    "var(--ink)",
    declOf(SENTENCE_FLASH_BODY, "background-color") ?? declOf(SENTENCE_FLASH_BODY, "background"),
    4.5,
  ],
];
for (const [theme, vars] of Object.entries(themes)) {
  for (const [label, fgRaw, bgRaw, threshold] of MASTERY_PAIRS) {
    const fg = resolveColor(fgRaw, vars);
    const bg = resolveColor(bgRaw, vars);
    if (!fg || !bg) { console.error(`FAIL: [${theme}] 生词本配对取色失败：${label}`); failed = true; continue; }
    const ratio = contrast(fg, bg);
    rows.push({ theme, pair: label, fg, bg, ratio, threshold, ok: ratio >= threshold });
    if (ratio < threshold) failed = true;
  }
}

console.log("theme | 配对 | 前景 | 背景 | 比值 | 门槛 | 判定");
console.log("---|---|---|---|---|---|---");
for (const r of rows) {
  console.log(
    `${r.theme} | ${r.pair} | ${r.fg} | ${r.bg} | ${r.ratio.toFixed(2)}:1 | ${r.threshold === null ? "—" : `${r.threshold}:1`} | ${r.threshold === null ? "info" : r.ok ? "PASS" : "FAIL"}`,
  );
}

const checked = rows.filter((r) => r.threshold !== null);
const passed = checked.filter((r) => r.ok);
console.log(`判据项: ${passed.length}/${checked.length} 达标（正文 ≥4.5:1，标注色 ≥3:1）`);

if (failed) {
  console.error("FAIL: 存在未达标的对比度项");
  process.exit(1);
}
console.log("PASS: WCAG 对比度达标");
