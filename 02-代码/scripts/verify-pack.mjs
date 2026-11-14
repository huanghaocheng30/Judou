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
// 两个层次分开报，避免把「checkout 策略」误判成「内容坏了」：
//   raw  = 两侧字节完全相同（本工作树的常态，13/13）
//   eol  = 仅行尾不同（`git clone` 到 `core.autocrlf=true` 的机器时，设计区的 LF 会被 checkout
//          转成 CRLF，而 `content-pack/**` 由 `02-代码/.gitattributes` 的 `-text` 钉住不变）
// 判据：内容（EOL 归一后）必须一致；raw 一致数单独打印，供审查判断当前 checkout 策略。
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const normalizeEol = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
let rawMatched = 0;
let eolOnly = 0;
const missingInSource = [];
const mismatched = [];
console.log("\n文件 | 字节 | SHA-256 前 12 位 | 一致");
console.log("---|---|---|---");
for (const name of packFiles) {
  const packPath = path.join(packDir, name);
  const sourcePath = path.join(sourceDir, name);
  const packBuf = readFileSync(packPath);
  const digest = sha256(packBuf);
  if (!existsSync(sourcePath)) {
    missingInSource.push(name);
    console.log(`${name} | ${packBuf.length} | ${digest.slice(0, 12)} | 来源缺失`);
    continue;
  }
  const sourceBuf = readFileSync(sourcePath);
  const rawSame = digest === sha256(sourceBuf);
  const contentSame = rawSame || sha256(normalizeEol(packBuf)) === sha256(normalizeEol(sourceBuf));
  if (rawSame) rawMatched += 1;
  else if (contentSame) eolOnly += 1;
  else mismatched.push(name);
  console.log(`${name} | ${packBuf.length} | ${digest.slice(0, 12)} | ${rawSame ? "ok" : contentSame ? "eol" : "FAIL"}`);
}
console.log(`\n内容一致: ${rawMatched + eolOnly}/${packFiles.length}（其中 raw 字节一致 ${rawMatched}，仅 EOL 差异 ${eolOnly}）`);
if (eolOnly > 0) {
  console.log(
    `  提示：${eolOnly} 个文件仅行尾不同——这是 checkout 策略造成的（\`git clone\` 到 core.autocrlf=true 时，` +
      `设计区 JSON 被转 CRLF，而 content-pack 被 .gitattributes 的 -text 钉住）。内容本身一致。`,
  );
}
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

// ⑤ M12 D3：content-pack 必须**编进二进制**（Tauri v2 的 bundle.resources 在 Android 不生效）
//    源码侧断言：pack.rs 有 include_dir 内嵌 + app_data_dir 第三级 fallback；lib.rs 传入 app_data_dir
const packRs = readFileSync(path.join(root, "src-tauri", "src", "pack.rs"), "utf8");
const libRs = readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
const sourceChecks = [
  ["pack.rs 有 include_dir!(...content-pack)", /include_dir!\(\s*"\$CARGO_MANIFEST_DIR\/\.\.\/content-pack"\s*\)/.test(packRs)],
  ["pack.rs 有内嵌资源静态 EMBEDDED_PACK", /static\s+EMBEDDED_PACK/.test(packRs)],
  ["pack.rs 有 ensure_pack_extracted(app_data_dir)", /fn\s+ensure_pack_extracted\(\s*app_data_dir/.test(packRs)],
  ["pack.rs resolve_pack_dir 收 app_data_dir 参数（第三级 fallback）", /fn\s+resolve_pack_dir\([\s\S]{0,200}?app_data_dir/.test(packRs)],
  ["lib.rs 调用点传入 app_data_dir", /resolve_pack_dir\([\s\S]{0,200}?data_dir\.as_path\(\)/.test(libRs)],
];
console.log("\n内嵌断言（M12 D3）：");
for (const [label, ok] of sourceChecks) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) fail(`内嵌断言未通过：${label}`);
}

// 二进制侧断言（可选）：Android 的 .so 或桌面 debug 产物里能找到包内特征串
// 候选按「存在即查」处理：都没构建过就跳过（源码断言已覆盖 CI 场景）
const binaries = [
  path.join(root, "src-tauri", "target", "aarch64-linux-android", "debug", "libjudou_lib.so"),
  path.join(root, "src-tauri", "target", "aarch64-linux-android", "debug", "libjudou.so"),
];
const present = binaries.filter((file) => existsSync(file));
if (!present.length) {
  console.log("  跳过 二进制特征串扫描：未找到 Android .so 产物（先跑 tauri android build）");
} else {
  for (const file of present) {
    const bytes = readFileSync(file);
    const hasMarker = bytes.includes(Buffer.from("cet4-2023-12", "utf8"));
    console.log(`  ${hasMarker ? "ok  " : "FAIL"} ${path.relative(root, file)} 含包内特征串 cet4-2023-12（${(bytes.length / 1048576).toFixed(1)} MB）`);
    if (!hasMarker) fail(`${path.relative(root, file)} 未内嵌 content-pack 特征串`);
  }
}

if (failed) {
  console.error("\nFAIL: 内容包落位与设计区不一致");
  process.exit(1);
}
console.log(
  `\nPASS: ${rawMatched + eolOnly}/${packFiles.length} 文件内容一致（raw ${rawMatched} + 仅 EOL ${eolOnly}）｜${totalBytes} B｜` +
    `无 \`_\` 中间件｜manifest ${manifest.articles.length} 篇齐全`,
);
