#!/usr/bin/env node
/**
 * AC5 断言：src-tauri/icons 的 5 个桌面图标存在且非空；
 * tauri.conf.json 的 bundle.icon 长度=5 且逐项等于这 5 个相对路径；
 * icons/ 下无 Tauri 默认模板 logo 残留（默认模板产物为 32x32.png 等同样文件名，
 * 故以「全部图标文件 mtime 晚于本包开工时间 + 由 tauri icon 一次性生成」判定，
 * 对应计划评审 R2 的口径提示）。
 *
 * 用法：node scripts/check-icons.mjs [--since YYYY-MM-DDTHH:MM:SS]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "src-tauri", "icons");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");

const EXPECTED = ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.ico", "icons/icon.png"];

let failed = false;

for (const rel of EXPECTED) {
  const file = path.join(root, "src-tauri", rel);
  if (!existsSync(file)) {
    console.error(`FAIL: 缺文件 ${rel}`);
    failed = true;
    continue;
  }
  const size = statSync(file).size;
  console.log(`${rel.padEnd(24)} ${String(size).padStart(8)} B`);
  if (size === 0) {
    console.error(`FAIL: ${rel} 是空文件`);
    failed = true;
  }
}

if (!existsSync(confPath)) {
  console.error(`FAIL: tauri.conf.json 不存在：${confPath}`);
  process.exit(1);
}

const conf = JSON.parse(readFileSync(confPath, "utf8"));
const icons = conf?.bundle?.icon;
console.log(`bundle.icon 长度 = ${Array.isArray(icons) ? icons.length : "<不是数组>"}`);
console.log(`bundle.icon = ${JSON.stringify(icons)}`);

if (!Array.isArray(icons)) {
  failed = true;
} else {
  if (icons.length !== 5) {
    console.error(`FAIL: bundle.icon 应为 5 项，实测 ${icons.length}`);
    failed = true;
  }
  for (const expected of EXPECTED) {
    if (!icons.includes(expected)) {
      console.error(`FAIL: bundle.icon 缺 ${expected}`);
      failed = true;
    }
  }
  const extra = icons.filter((i) => !EXPECTED.includes(i));
  if (extra.length) {
    console.error(`FAIL: bundle.icon 多出未登记项 ${extra.join(", ")}`);
    failed = true;
  }
}

// 目录内容概览 + 全部文件 mtime（R2 口径：均由 tauri icon 一次性生成）
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(iconsDir);

const MIN_MTIME = new Date("2026-11-05T22:45:00");
const tooOld = files.filter((f) => statSync(f).mtime < MIN_MTIME);
console.log(`icons/ 文件总数 = ${files.length}（含 android/ ios/），mtime 早于本包开工的 = ${tooOld.length}`);
if (tooOld.length) {
  console.error(`FAIL: 以下图标疑似非本次生成（mtime 过旧）：\n  ${tooOld.map((f) => path.relative(root, f)).join("\n  ")}`);
  failed = true;
}

// 窗口标题（AC1 ④ 的唯一来源）顺带断言
const title = conf?.app?.windows?.[0]?.title;
const productName = conf?.productName;
console.log(`productName = ${productName}｜app.windows[0].title = ${title}`);
if (title !== "句读") {
  console.error("FAIL: app.windows[0].title 应为「句读」（Tauri v2 缺省是 \"Tauri App\"）");
  failed = true;
}
if (productName !== "句读") {
  console.error("FAIL: productName 应为「句读」");
  failed = true;
}

if (failed) {
  console.error("FAIL: 图标/配置校验未通过");
  process.exit(1);
}
console.log("PASS: 5 个桌面图标非空、bundle.icon 逐项匹配、标题/产品名正确");
