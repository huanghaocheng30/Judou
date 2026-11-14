#!/usr/bin/env node
/**
 * AC1 断言：`02-代码/content-pack/` 与**上游来源**逐文件 SHA-256 一致。
 *
 * 判据：
 *   ① 73 个数据文件（72 篇 + `manifest.json`），**逐文件 SHA-256 一致**
 *   ② 字节总数 = 21,876,963（M16 实测值：60 篇新内容 + 72 项新 manifest；文件变了这里就会红——这正是它的用处）
 *   ③ 目录内不得有 `_` 前缀中间件（`_analysis-*.json` / `_lexicon-batch-*.json` 是生成期切片，不进包）
 *   ④ manifest 声明 72 篇，且每篇的 `file` 都能在包目录里找到
 *
 * **双来源（M16 起，调度员裁定）**：
 *   ① 2023-12 那 12 篇 → 设计区 `01-设计/CET4-阅读精读/内容包/`（历史口径不变）
 *   ② 2024-06~2026-06 那 60 篇 → 上游生成目录 `内容生成模板/output/<YYYY-MM>/`（按文件名年月分子目录）
 * 为什么不是单一来源：设计区只放设计件，把 60 个数据文件塞进 01-设计 会污染设计区且违反区职责；
 * 而这 60 篇本来就是内容生成侧产物，它们的权威源就是 output/。
 * **两侧都做真 SHA-256 校验**（没有任何一侧被跳过）；目录缺失时给出恢复指引，不让后人靠猜。
 *
 * 用法：node scripts/verify-pack.mjs
 * ponytail: 内容包只读、只比哈希——比「解一遍 JSON 再比对」便宜，且能发现任何字节级改动。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = path.join(root, "content-pack");
const sourceDir = path.resolve(root, "..", "01-设计", "CET4-阅读精读", "内容包");
const EXPECTED_BYTES = 21876963;
const EXPECTED_FILES = 73;
// M16：新并入的 60 篇来自上游生成目录（按文件名里的年月分子目录）
const upstreamDir = path.resolve(root, "..", "内容生成模板", "output");

/** 权威来源路径：设计区优先（12 篇历史源），否则回上游 output/<YYYY-MM>/ */
function sourcePathOf(name) {
  const design = path.join(sourceDir, name);
  if (existsSync(design)) return design;
  const month = /^cet4-(\d{4})-(\d{2})-/.exec(name);
  if (!month) return null;
  const upstream = path.join(upstreamDir, `${month[1]}-${month[2]}`, name);
  return existsSync(upstream) ? upstream : null;
}

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
  console.error(`FAIL[来源]: 设计区内容包不存在（只读来源）：${sourceDir}`);
  console.error("  说明：2023-12 那 12 篇的权威源在这里（03-02-set1-passageA.json 等历史文件名也在这里）。");
  console.error("  恢复：确认 01-设计/CET4-阅读精读/内容包/ 存在且含 12 篇 + manifest；本门禁按 SHA-256 逐文件比对。");
  process.exit(1);
}

// 上游目录是 60 篇新内容的权威源：先整目录检查，避免逐文件报 60 条「来源缺失」
if (!existsSync(upstreamDir)) {
  console.error(`FAIL[来源]: 上游生成目录不存在：${upstreamDir}`);
  console.error("  说明：2024-06~2026-06 那 60 篇的权威源在此目录下按 <YYYY-MM>/ 分子目录存放（如 2024-06/cet4-2024-06-set1A.json）。");
  console.error(`  另一侧（2023-12 的 12 篇）查设计区：${sourceDir}`);
  console.error("  恢复：把「内容生成模板/output」放回项目根；若已搬迁，改本脚本 upstreamDir 常量指向新位置。");
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
  // manifest.json 是生成器产物（权威源＝content-pack 里的 72 篇），不参与「与上游一致」比对；
  // 它自己由下面 ⑥ 的 `gen-pack-manifest --check` 守（幂等 + 由数据重算）。
  if (name === "manifest.json") {
    console.log(`${name} | ${statSync(path.join(packDir, name)).size} | 生成器产物 | 跳过来源比对`);
    continue;
  }
  const packPath = path.join(packDir, name);
  const sourcePath = sourcePathOf(name);
  const packBuf = readFileSync(packPath);
  const digest = sha256(packBuf);
  if (!sourcePath) {
    missingInSource.push(name);
    const month = /^cet4-(\d{4})-(\d{2})-/.exec(name);
    const tried = [sourceDir, month ? path.join(upstreamDir, `${month[1]}-${month[2]}`, name) : "<无年月可用>"];
    console.log(`${name} | ${packBuf.length} | ${digest.slice(0, 12)} | 来源缺失（找过：${tried.join(" ｜ ")}）`);
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

if (missingInSource.length) {
  console.error(`\nFAIL[来源]: ${missingInSource.length} 个包内文件在上游找不到权威副本`);
  console.error(`  2023-12 的 12 篇查：${sourceDir}`);
  console.error(`  2024-06~2026-06 的 60 篇查：${upstreamDir}/<YYYY-MM>/`);
  console.error("  恢复：把对应批次的 JSON 放回上述目录（文件名必须与包内一致，本门禁按 SHA-256 比对）。");
}

// ④ manifest 声明 72 篇且文件都在
const manifest = JSON.parse(readFileSync(path.join(packDir, "manifest.json"), "utf8"));
console.log(`manifest.packVersion = ${manifest.packVersion}｜articles = ${manifest.articles.length}（期望 72）`);
if (manifest.articles.length !== 72) fail(`manifest.articles 应为 72，实测 ${manifest.articles.length}`);
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

// ⑥ manifest 必须等于生成器输出（同输入同输出；改了内容却忘跑生成器，这里红）
const gen = spawnSync(process.execPath, [path.join(root, "scripts", "gen-pack-manifest.mjs"), "--check"], {
  encoding: "utf8",
});
console.log(`\nmanifest 生成器 --check：${gen.status === 0 ? "ok（与数据重算结果一致）" : "FAIL"}`);
if (gen.status !== 0) {
  const tail = `${gen.stdout ?? ""}${gen.stderr ?? ""}`.trim().split("\n").slice(-3).join(" / ");
  fail(`manifest 与生成器输出不一致：${tail}`);
}

if (failed) {
  console.error("\nFAIL: 内容包落位与上游不一致");
  process.exit(1);
}
console.log(
  `\nPASS: ${rawMatched + eolOnly}/${packFiles.length} 文件内容一致（raw ${rawMatched} + 仅 EOL ${eolOnly}）｜${totalBytes} B｜` +
    `无 \`_\` 中间件｜manifest ${manifest.articles.length} 篇齐全`,
);
