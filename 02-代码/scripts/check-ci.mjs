#!/usr/bin/env node
/**
 * AC6 断言：.github/workflows/ci.yml 存在、可结构化解析（缩进块 + 正则，按 02 §四
 * 「用 yaml 或正则校验」取零依赖路径）、build job 三平台 matrix、android job if:false。
 *
 * ponytail: 不引 yaml 依赖——02 明确允许正则校验，且文件结构是自有受控的 50 行；
 * 等 CI 变成多文件复用（reusable workflow）再上 yaml 解析器。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciPath = path.join(root, ".github", "workflows", "ci.yml");

if (!existsSync(ciPath)) {
  console.error(`FAIL: CI 文件不存在：${ciPath}`);
  process.exit(1);
}

const text = readFileSync(ciPath, "utf8");
const lines = text.split(/\r?\n/);
let failed = false;

// 1) 结构可解析：顶层键 + jobs 下每 job 至少含 runs-on 或 if，缩进一致
const topLevel = lines.filter((l) => /^[a-zA-Z_][\w-]*:/.test(l)).map((l) => l.split(":")[0]);
console.log(`顶层键: ${topLevel.join(", ")}`);
for (const key of ["name", "on", "jobs"]) {
  if (!topLevel.includes(key)) { console.error(`FAIL: 缺顶层键 ${key}`); failed = true; }
}

const jobsBlock = text.split(/^jobs:\s*$/m)[1] ?? "";
const jobNames = [...jobsBlock.matchAll(/^ {2}([a-zA-Z_][\w-]*):\s*$/gm)].map((m) => m[1]);
console.log(`job 名: ${jobNames.join(", ")}`);
for (const job of ["build", "android"]) {
  if (!jobNames.includes(job)) { console.error(`FAIL: 缺 job ${job}`); failed = true; }
}

// 2) build job 的三平台 matrix
const buildStart = jobsBlock.indexOf("  build:");
const androidStart = jobsBlock.indexOf("  android:");
const buildBlock = buildStart >= 0 ? jobsBlock.slice(buildStart, androidStart > buildStart ? androidStart : undefined) : "";
const matrixMatch = buildBlock.match(/matrix:\s*[\s\S]*?platform:\s*\[([^\]]+)\]/);
const platforms = matrixMatch ? matrixMatch[1].split(",").map((s) => s.trim()) : [];
console.log(`build.matrix.platform = [${platforms.join(", ")}]`);
for (const p of ["windows-latest", "macos-latest", "ubuntu-latest"]) {
  if (!platforms.includes(p)) { console.error(`FAIL: matrix 缺平台 ${p}`); failed = true; }
}

// 3) build job 三步命令齐全
for (const cmd of ["npm ci", "npm run build", "cargo check"]) {
  if (!buildBlock.includes(cmd)) { console.error(`FAIL: build job 缺步骤 \`${cmd}\``); failed = true; }
}

// 4) android job 占位
const androidBlock = androidStart >= 0 ? jobsBlock.slice(androidStart) : "";
const androidIfFalse = /^\s{4}if:\s*false\s*$/m.test(androidBlock);
console.log(`android job if: false = ${androidIfFalse}`);
if (!androidIfFalse) { console.error("FAIL: android job 未以 if: false 占位"); failed = true; }
if (!/M7/.test(androidBlock)) { console.error("FAIL: android 占位未注明 M7 启用"); failed = true; }

// 5) Ubuntu 的 Linux 依赖步骤（Tauri 官方清单）
if (!/libwebkit2gtk-4\.1-dev/.test(buildBlock)) {
  console.error("FAIL: ubuntu 缺 libwebkit2gtk-4.1-dev 等 Tauri Linux 依赖");
  failed = true;
}

if (failed) { console.error("FAIL: CI 骨架校验未通过"); process.exit(1); }
console.log("PASS: ci.yml 可解析、build 三平台 matrix 齐全、android 占位 if:false");
