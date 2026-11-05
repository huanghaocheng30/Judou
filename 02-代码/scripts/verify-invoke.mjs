#!/usr/bin/env node
/**
 * AC3 断言：src/**\/*.ts(x) 里出现 `invoke(` 的只允许是 src/lib/api.ts。
 *
 * ponytail: 一条正则扫全树足够——M0 只有 3 个命令；等出现动态命令名
 * （invoke(variable)）再上 AST 解析（@babel/parser 或 typescript API）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const ALLOWED = path.join("src", "lib", "api.ts");
const PATTERN = /invoke\s*\(/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(srcDir);
} catch (err) {
  console.error(`FAIL: 无法扫描 src 目录（${err.code ?? err.message}）：${srcDir}`);
  process.exit(1);
}

const violations = [];
let hitsInAllowed = 0;
let scanned = 0;

for (const file of files) {
  const rel = path.relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  scanned += 1;
  lines.forEach((line, i) => {
    const matches = line.match(PATTERN);
    if (!matches) return;
    if (rel === ALLOWED) {
      hitsInAllowed += matches.length;
      return;
    }
    violations.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
}

console.log(`扫描文件数: ${scanned}`);
console.log(`api.ts 内 invoke( 命中: ${hitsInAllowed}（允许）`);
console.log(`例外数: ${violations.length}`);

if (scanned === 0) {
  console.error("FAIL: src 下未找到任何 .ts/.tsx");
  process.exit(1);
}
if (hitsInAllowed === 0) {
  console.error(`FAIL: ${ALLOWED} 内未发现 invoke( —— 唯一后端入口未建立`);
  process.exit(1);
}
if (violations.length > 0) {
  console.error("FAIL: 以下位置出现裸 invoke(（必须改走 src/lib/api.ts）:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("PASS: invoke( 仅出现在 src/lib/api.ts，例外 0");
