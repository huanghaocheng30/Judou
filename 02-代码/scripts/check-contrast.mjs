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
