#!/usr/bin/env node
/**
 * AC1 断言：`02-代码/content-pack/` 与设计区内容包逐文件 SHA-256 一致。
 *
 * 判据：
 *   ① 13 个数据文件（12 篇 `cet4-2023-12-*.json` + `manifest.json`），**逐文件 SHA-256 一致**
 *   ② 字节总数 = 3,529,547（AC1 实测值；文件变了这里就会红——这正是它的用处）
 *   ③ 目录内不得有 `_` 前缀中间件（`_analysis-*.json` / `_lexicon-batch-*.json` 是生成期切片，不进包）
 *   ④ manifest 声明 12 篇，且每篇的 `file` 都能在包目录里找到
 *
 * 用法：node scripts/verify-pack.mjs
 * ponytail: 内容包只读、只比哈希——比「解一遍 JSON 再比对」便宜，且能发现任何字节级改动。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = path.join(root, "content-pack");
const sourceDir = path.resolve(root, "..", "01-设计", "CET4-阅读精读", "内容包");
const EXPECTED_BYTES = 3529547;
const EXPECTED_FILES = 13;

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

if (!existsSync(packDir)) {
  console.error(`FAIL: 内容包目录不存在：${packDir}`);
  process.exit(1);
}
if (!existsSync(sourceDir)) {
  console.error(`FAIL: 设计区内容包不存在（只读来源）：${sourceDir}`);
  process.exit(1);
}

const listFiles = (dir) => readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile()).sort();
const packFiles = listFiles(packDir);
const sourceFiles = listFiles(sourceDir);

console.log(`包目录: ${packDir}`);
console.log(`来源目录: ${sourceDir}`);

// ③ 不得有 `_` 前缀中间件
const underscored = packFiles.filter((name) => name.startsWith("_"));
console.log(`文件数: ${packFiles.length}（期望 ${EXPECTED_FILES}）｜\`_\` 前缀中间件: ${underscored.length}（期望 0）`);
if (packFiles.length !== EXPECTED_FILES) fail(`文件数应为 ${EXPECTED_FILES}，实测 ${packFiles.length}`);
if (underscored.length) fail(`包目录内不应有 \`_\` 前缀中间件，实测 ${underscored.join(", ")}`);

// ② 字节总数
const totalBytes = packFiles.reduce((sum, name) => sum + statSync(path.join(packDir, name)).size, 0);
console.log(`字节总数: ${totalBytes}（期望 ${EXPECTED_BYTES}）`);
if (totalBytes !== EXPECTED_BYTES) fail(`字节总数应为 ${EXPECTED_BYTES}，实测 ${totalBytes}`);

// ① 逐文件 SHA-256
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
let matched = 0;
const missingInSource = [];
const mismatched = [];
console.log("\n文件 | 字节 | SHA-256 前 12 位 | 一致");
console.log("---|---|---|---");
for (const name of packFiles) {
  const packPath = path.join(packDir, name);
  const sourcePath = path.join(sourceDir, name);
  const digest = sha256(packPath);
  if (!existsSync(sourcePath)) {
    missingInSource.push(name);
    console.log(`${name} | ${statSync(packPath).size} | ${digest.slice(0, 12)} | 来源缺失`);
    continue;
  }
  const same = digest === sha256(sourcePath);
  if (same) matched += 1;
  else mismatched.push(name);
  console.log(`${name} | ${statSync(packPath).size} | ${digest.slice(0, 12)} | ${same ? "ok" : "FAIL"}`);
}
console.log(`\nSHA-256 一致: ${matched}/${packFiles.length}`);
if (missingInSource.length) fail(`来源目录缺文件：${missingInSource.join(", ")}`);
if (mismatched.length) fail(`内容不一致：${mismatched.join(", ")}`);

// ④ manifest 声明 12 篇且文件都在
const manifest = JSON.parse(readFileSync(path.join(packDir, "manifest.json"), "utf8"));
console.log(`manifest.packVersion = ${manifest.packVersion}｜articles = ${manifest.articles.length}（期望 12）`);
if (manifest.articles.length !== 12) fail(`manifest.articles 应为 12，实测 ${manifest.articles.length}`);
const missingDeclared = manifest.articles.map((a) => a.file).filter((file) => !packFiles.includes(file));
if (missingDeclared.length) fail(`manifest 声明的文件不在包内：${missingDeclared.join(", ")}`);
const undeclared = packFiles.filter(
  (name) => name !== "manifest.json" && !manifest.articles.some((a) => a.file === name),
);
if (undeclared.length) fail(`包内有 manifest 未声明的文件：${undeclared.join(", ")}`);
// 来源目录里除内容包外还有生成期切片，这里只做提示（不参与判据）
console.log(`来源目录文件数: ${sourceFiles.length}（含生成期 \`_\` 切片，仅作提示）`);

if (failed) {
  console.error("\nFAIL: 内容包落位与设计区不一致");
  process.exit(1);
}
console.log(`\nPASS: ${matched}/${packFiles.length} 文件 SHA-256 一致｜${totalBytes} B｜无 \`_\` 中间件｜manifest 12 篇齐全`);
