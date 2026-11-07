#!/usr/bin/env node
/**
 * M7 D4 · `verify:release` 门禁（AC1 / AC4 / AC5 / AC6 的静态断言集合）。
 *
 * 五组断言：
 *  1. **版本三处一致**：tauri.conf.json = package.json = Cargo.toml `[package].version`（AC1）
 *  2. **工作流 YAML 可解析**：ci.yml / release.yml 走「YAML 子集解析」（缩进 + 键值 + 块标量）
 *  3. **无明文密钥**：不得出现 PEM 块 / 常见令牌前缀 / 硬编码口令值；只许引用 `secrets.*`
 *  4. **`.gitignore` 覆盖私钥**：`*.key` / `*.pem` / `tauri-signing*`（AC5）
 *  5. **发布脚本齐备**：`make-update-manifest.mjs`（含签名缺失即退出）/ `build-installer.ps1`
 *
 * ponytail: 不引 `yaml` 依赖——本仓库只有两个自有受控、50 行量级的 workflow 文件，
 * 02 §四 明确允许正则/结构化校验；等出现 reusable workflow 或 `matrix.include` 多层嵌套
 * 再上真正的解析器（升级路径就这一句）。子集校验的判据是「结构层每行都必须是 `键:` 或列表项」，
 * 能抓出的典型错误：tab 缩进、奇数缩进、键后漏冒号、块标量没缩进。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// E-M7-2：workflow 已搬到仓库根 .github/workflows/（GitHub 只认仓库根），工作流路径从 02-代码 上跳一级
const repoRoot = path.resolve(root, "..");
const problems = [];
const ok = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => ok.push(msg);

const rel = (p) => path.relative(root, p).replace(/\\/g, "/");
const read = (relPath) => readFileSync(path.join(root, relPath), "utf8");

// ───────────────────────── 1) 版本三处一致（AC1） ─────────────────────────

let tauriVersion = null;
let pkgVersion = null;
let cargoVersion = null;

try {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  tauriVersion = String(conf.version ?? "");
} catch (err) {
  fail(`src-tauri/tauri.conf.json 读取/解析失败：${err.message}`);
}

try {
  pkgVersion = String(JSON.parse(read("package.json")).version ?? "");
} catch (err) {
  fail(`package.json 读取/解析失败：${err.message}`);
}

// Cargo.toml 只看 [package] 段，避免读到依赖里的 version（依赖里是版本约束表达式）
const cargoText = existsSync(path.join(root, "src-tauri", "Cargo.toml")) ? read("src-tauri/Cargo.toml") : "";
if (!cargoText) {
  fail("src-tauri/Cargo.toml 不存在");
} else {
  const pkgSection = cargoText.split(/^\s*\[/m).find((chunk) => /^package\]/.test(chunk.trim())) ?? "";
  const match = pkgSection.match(/^\s*version\s*=\s*"([^"]+)"/m);
  cargoVersion = match ? match[1] : null;
  if (!cargoVersion) fail("Cargo.toml 的 [package] 段里找不到 version");
}

console.log(`tauri.conf.json version = ${tauriVersion ?? "（缺失）"}`);
console.log(`package.json    version = ${pkgVersion ?? "（缺失）"}`);
console.log(`Cargo.toml      version = ${cargoVersion ?? "（缺失）"}`);

if (tauriVersion && pkgVersion && cargoVersion) {
  if (tauriVersion === pkgVersion && pkgVersion === cargoVersion) {
    pass(`版本三处一致 = ${tauriVersion}`);
  } else {
    fail(`版本三处不一致：tauri=${tauriVersion} / package=${pkgVersion} / cargo=${cargoVersion}`);
  }
} else {
  fail("版本号有缺失项，无法断言一致性");
}

// ───────────────────────── 2) 工作流 YAML 可解析（AC4 / AC5） ─────────────────────────

/**
 * YAML 子集校验：返回问题行列表（空数组 = 通过）。
 * 结构层每行必须是 `键:`（可带行内值）或 `- ` 列表项；块标量（`|` / `>`）内部整段跳过。
 */
function yamlSubsetProblems(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let scalarIndent = null;
  lines.forEach((raw, index) => {
    const no = index + 1;
    if (raw.includes("\t")) found.push(`第 ${no} 行含制表符（YAML 禁止 tab 缩进）`);
    const blank = /^\s*$/.test(raw);
    const indent = raw.match(/^ */)[0].length;

    // 块标量内部（比父键缩进更深）整段按字面量跳过
    if (scalarIndent !== null) {
      if (blank || indent > scalarIndent) return;
      scalarIndent = null;
    }
    if (blank || /^\s*#/.test(raw)) return;

    if (indent % 2 !== 0) found.push(`第 ${no} 行缩进 ${indent} 不是 2 的倍数`);

    const body = raw.slice(indent);
    if (body.startsWith("- ")) {
      // 列表项：可以是裸标量，也可以是行内映射（`- name: x`）——都合法，不再往下拆
      return;
    }
    if (!/^[^\s:#][^:]*:(\s|$)/.test(body)) {
      found.push(`第 ${no} 行不是「键: 值」形态：${body.trim().slice(0, 60)}`);
      return;
    }
    if (/(\||>)[+-]?\s*$/.test(body)) scalarIndent = indent;
  });
  return found;
}

const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release.yml";
const workflows = [
  { file: CI, label: "ci.yml" },
  { file: RELEASE, label: "release.yml" },
];

const workflowTexts = new Map();
for (const { file, label } of workflows) {
  const abs = path.join(repoRoot, file);
  if (!existsSync(abs)) {
    fail(`工作流不存在：${file}`);
    continue;
  }
  const text = readFileSync(abs, "utf8");
  workflowTexts.set(file, text);
  const yamlProblems = yamlSubsetProblems(text);
  if (yamlProblems.length === 0) {
    const lineCount = text.split(/\r?\n/).length;
    pass(`${label} YAML 子集校验通过（${lineCount} 行）`);
  } else {
    for (const item of yamlProblems) fail(`${label} ${item}`);
  }
  if (!/^\s*on:/m.test(text)) fail(`${label} 缺顶层 on: 触发器`);
  if (!/^\s*jobs:/m.test(text)) fail(`${label} 缺顶层 jobs:`);
}

// ci.yml：AC4 要求的四步 + 两平台矩阵
const ciText = workflowTexts.get(CI);
if (ciText) {
  for (const cmd of ["cargo check", "cargo test", "npm run build"]) {
    if (!ciText.includes(cmd)) fail(`${CI} 缺步骤 \`${cmd}\``);
    else pass(`${CI} 含 \`${cmd}\``);
  }
  const gates = ["verify:release", "verify:invoke", "verify:records"];
  for (const gate of gates) {
    if (!ciText.includes(gate)) fail(`${CI} 缺门禁 \`npm run ${gate}\``);
  }
  if (gates.every((gate) => ciText.includes(gate))) pass(`${CI} 含 3 个发布相关门禁`);
  const matrix = ciText.match(/platform:\s*\[([^\]]+)\]/);
  const platforms = matrix ? matrix[1].split(",").map((s) => s.trim()) : [];
  for (const need of ["windows-latest", "ubuntu-latest"]) {
    if (!platforms.includes(need)) fail(`${CI} matrix 缺平台 ${need}`);
  }
  if (platforms.length > 0) pass(`${CI} matrix = [${platforms.join(", ")}]`);
}

// release.yml：AC5 的触发方式与产物
const releaseText = workflowTexts.get(RELEASE);
if (releaseText) {
  if (!/workflow_dispatch:/.test(releaseText)) fail(`${RELEASE} 缺 workflow_dispatch 触发`);
  if (!/tags:/.test(releaseText)) fail(`${RELEASE} 缺 tag 触发`);
  if (/workflow_dispatch:/.test(releaseText) && /tags:/.test(releaseText)) {
    pass(`${RELEASE} 触发 = workflow_dispatch + tag`);
  }
  if (!/tauri-apps\/tauri-action/.test(releaseText)) fail(`${RELEASE} 未使用 tauri-apps/tauri-action`);
  else pass(`${RELEASE} 使用 tauri-action 构建`);
  if (!/nsis/i.test(releaseText)) fail(`${RELEASE} 未指定 NSIS 产物`);
  else pass(`${RELEASE} 产物含 NSIS`);
  if (!/TAURI_SIGNING_PRIVATE_KEY/.test(releaseText)) fail(`${RELEASE} 缺签名密钥引用名 TAURI_SIGNING_PRIVATE_KEY`);
}

// ───────────────────────── 3) 无明文密钥（AC4 / AC5） ─────────────────────────

const SECRET_PREFIXES = [/\bghp_[A-Za-z0-9]{10,}/, /\bsk-[A-Za-z0-9]{16,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{12,}/];
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// 键名命中「像凭证」，且值不是 `${{ ... }}` 引用 / 空串 / 块标量 → 视为硬编码
const CRED_LINE = /(password|passwd|secret|token|private[_-]?key|api[_-]?key)\s*[:=]\s*(\S.*)$/i;

const secretProblemsBefore = problems.length;
for (const { file, label } of workflows) {
  const text = workflowTexts.get(file);
  if (!text) continue;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const no = index + 1;
    if (PEM_BLOCK.test(line)) fail(`${label}:${no} 出现 PEM 私钥块`);
    for (const prefix of SECRET_PREFIXES) {
      if (prefix.test(line)) fail(`${label}:${no} 出现疑似真实令牌（${prefix.source}）`);
    }
    const cred = line.match(CRED_LINE);
    if (cred) {
      const value = cred[2].trim().replace(/^["']|["']$/g, "");
      const isRef = value.startsWith("${{") && value.endsWith("}}");
      const isScalar = value === "" || value === "|" || value === ">";
      if (!isRef && !isScalar) fail(`${label}:${no} 疑似明文凭证：${cred[1]} = ${value.slice(0, 40)}`);
    }
  }
}
if (problems.length === secretProblemsBefore) pass("工作流无明文密钥（凭证只引用 secrets.*）");

// ───────────────────────── 4) .gitignore 覆盖私钥（AC5） ─────────────────────────

const gitignorePath = path.join(root, ".gitignore");
const REQUIRED_IGNORES = ["*.key", "*.pem", "tauri-signing*"];
if (!existsSync(gitignorePath)) {
  fail(".gitignore 不存在");
} else {
  const ignoreLines = read(".gitignore")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const missing = REQUIRED_IGNORES.filter((pattern) => !ignoreLines.includes(pattern));
  if (missing.length === 0) pass(`.gitignore 覆盖私钥模式：${REQUIRED_IGNORES.join(" / ")}`);
  else fail(`.gitignore 缺私钥模式：${missing.join(" / ")}`);
}

// ───────────────────────── 5) 发布脚本齐备（AC3 / AC6） ─────────────────────────

const manifestScript = "scripts/make-update-manifest.mjs";
if (!existsSync(path.join(root, manifestScript))) {
  fail(`${manifestScript} 不存在`);
} else {
  const text = read(manifestScript);
  for (const token of ["version", "pub_date", "platforms", "signature", "url"]) {
    if (!text.includes(token)) fail(`${manifestScript} 未产出字段 \`${token}\``);
  }
  // AC3：无签名时必须明确报错退出，而不是产出空签名
  if (!/process\.exit\(1\)/.test(text) || !/签名/.test(text)) {
    fail(`${manifestScript} 无签名时未明确报错退出（AC3）`);
  } else {
    pass(`${manifestScript} 产出五字段且无签名时报错退出`);
  }
}

const installerScript = "scripts/build-installer.ps1";
if (!existsSync(path.join(root, installerScript))) {
  fail(`${installerScript} 不存在`);
} else {
  const text = read(installerScript);
  if (!/tauri build/.test(text) || !/--bundles\s+nsis/.test(text)) {
    fail(`${installerScript} 未包含 \`tauri build --bundles nsis\``);
  } else {
    pass(`${installerScript} 含 \`tauri build --bundles nsis\``);
  }
  if (!/\$LASTEXITCODE/.test(text)) fail(`${installerScript} 未检查退出码`);
  if (!/大小|Length/.test(text)) fail(`${installerScript} 未打印产物大小（AC6）`);
}

// 6) 本门禁必须挂在 package.json 上，否则 CI 里那句 `npm run verify:release` 跑不起来
try {
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  if (scripts["verify:release"] === "node scripts/verify-release.mjs") {
    pass("package.json 已挂 verify:release");
  } else {
    fail(`package.json 的 verify:release 脚本缺失或指向错误：${scripts["verify:release"] ?? "（缺失）"}`);
  }
} catch {
  // package.json 解析失败已在第 1 组报过
}

// ───────────────────────── 汇总 ─────────────────────────

for (const line of ok) console.log(`  ok  ${line}`);
if (problems.length > 0) {
  console.error(`\nFAIL: 发布链路校验未通过（${problems.length} 项）`);
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`\nPASS: 发布链路校验通过（${ok.length} 项断言全绿）`);
