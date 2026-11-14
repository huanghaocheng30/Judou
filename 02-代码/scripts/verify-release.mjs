#!/usr/bin/env node
/**
 * 发布链路实质约束门禁 · `npm run verify:release`
 *
 * ── 职责边界（M17 扩范围，2026-11-14）──────────────────────────────────
 * 本脚本**只管发布链路的实质约束**，六组：
 *   1. **版本三处一致**：tauri.conf.json = package.json = Cargo.toml `[package].version`
 *   2. **私钥不入库**：`.gitignore` 覆盖 `*.key` / `*.pem` / `tauri-signing*`（且没被 `!` 反忽略），
 *      并且 `git ls-files` 里确实没有这类文件（模式对了但文件已被 `add -f` 进来同样拦下）
 *   3. **打包脚本齐备且可解析**：`build-installer.ps1`（tauri build --bundles nsis + 退出码 + 大小）
 *      / `make-update-manifest.mjs`（五字段 + 无签名即报错退出）
 *   4. **发布链路无硬编码凭证**：workflow 与发布脚本里不得出现 PEM 私钥块 / 常见令牌前缀 /
 *      硬编码口令值；只许引用 `secrets.*` 或环境变量
 *   5. **发布物索引在**：`05-交付/安装包/README.md` 存在、非空、且提到当前版本号
 *   6. **`.github/workflows/release.yml` 不存在**（2026-11-14 删除，与 check-ci.mjs 同口径）
 *
 * ── 不做什么（防止以后有人加回来）────────────────────────────────────
 * **CI workflow 的结构校验归 `scripts/check-ci.mjs`（`npm run verify:ci`）**：ci.yml 的
 * matrix / 平台清单 / `cargo check` `cargo test` `npm run build` 步骤 / `verify:*` 挂接，
 * 一律在那里断言，**本脚本不再重复任何一条**。
 *
 * 为什么不重复：两处各写一套 = 改一处必红另一处。M17 实测踩到 —— `release.yml` 删掉后
 * `check-ci.mjs` 已改口径放行，本脚本仍断言「`release.yml` 必须存在」→ 永久红灯 →
 * CI 里那句 `npm run verify:release` 必红，「CI 实跑全绿」判据直接不成立。
 * 以后要加 workflow 结构断言 → 加到 check-ci.mjs；要恢复 `release.yml` →
 * `check-ci.mjs` 的 `ALLOW_RELEASE_WORKFLOW` 与本脚本第 6 组**同时**放行并写明理由。
 *
 * ponytail: 不引依赖。git 索引检查用标准库 `node:child_process` 调 `git ls-files`
 * （非 git 环境降级为 WARN 而不是红，避免在源码包解压目录里假红）；
 * YAML 结构解析已整体移交 check-ci.mjs，本脚本不含 YAML 解析代码。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // 02-代码/

/**
 * 与 `check-ci.mjs` 同口径：以 `.git` 为仓库根判据（02-代码/ 下曾残留空的
 * `.github/workflows/` 目录，按「有 .github 就算根」会误判成仓库根）。
 */
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, "..");
}
const repoRoot = findRepoRoot(root);

const problems = [];
const ok = [];
const warns = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => ok.push(msg);
const warn = (msg) => warns.push(msg);

const read = (relPath) => readFileSync(path.join(root, relPath), "utf8");

// ───────────────── 1) 版本三处一致 ─────────────────

let tauriVersion = null;
let pkgVersion = null;
let cargoVersion = null;

try {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  tauriVersion = String(conf.version ?? "");
} catch (err) {
  fail(`src-tauri/tauri.conf.json 读取/解析失败：${err.message} —— 补：确认该文件存在且是合法 JSON。`);
}

try {
  pkgVersion = String(JSON.parse(read("package.json")).version ?? "");
} catch (err) {
  fail(`package.json 读取/解析失败：${err.message} —— 补：确认 package.json 存在且是合法 JSON。`);
}

// Cargo.toml 只看 [package] 段，避免读到依赖里的 version（依赖里是版本约束表达式）
const cargoText = existsSync(path.join(root, "src-tauri", "Cargo.toml")) ? read("src-tauri/Cargo.toml") : "";
if (!cargoText) {
  fail(
    "src-tauri/Cargo.toml 不存在 —— 补：本仓库是 Tauri 桌面应用，Cargo.toml 必须在 src-tauri/ 下；" +
      "若路径变了，请同步改本脚本与 tauri.conf.json 的定位。",
  );
} else {
  const pkgSection = cargoText.split(/^\s*\[/m).find((chunk) => /^package\]/.test(chunk.trim())) ?? "";
  const match = pkgSection.match(/^\s*version\s*=\s*"([^"]+)"/m);
  cargoVersion = match ? match[1] : null;
  if (!cargoVersion) {
    fail(
      "Cargo.toml 的 [package] 段里找不到 version —— 补：在 [package] 下加 `version = \"x.y.z\"`，与 package.json 一致。",
    );
  }
}

console.log(`tauri.conf.json version = ${tauriVersion || "（缺失）"}`);
console.log(`package.json    version = ${pkgVersion || "（缺失）"}`);
console.log(`Cargo.toml      version = ${cargoVersion || "（缺失）"}`);

if (tauriVersion && pkgVersion && cargoVersion) {
  if (tauriVersion === pkgVersion && pkgVersion === cargoVersion) {
    pass(`版本三处一致 = ${tauriVersion}`);
  } else {
    fail(
      `版本三处不一致：tauri=${tauriVersion} / package=${pkgVersion} / cargo=${cargoVersion} —— ` +
        "补：发版时三处一起改（tauri 安装包版本 / npm 版本 / Rust crate 版本必须同号，否则 updater 的 manifest 与产物对不上）。",
    );
  }
} else {
  fail("版本号有缺失项，无法断言一致性 —— 补：先补齐上面标「（缺失）」的那一处再发版。");
}

// ───────────────── 2) 私钥不入库 ─────────────────

const SIGNING_PATTERNS = ["*.key", "*.pem", "tauri-signing*"];

// 2a. .gitignore 覆盖私钥模式
const gitignorePath = path.join(root, ".gitignore");
if (!existsSync(gitignorePath)) {
  fail(
    "02-代码/.gitignore 不存在 —— 补：新建它并加入 " +
      `${SIGNING_PATTERNS.join(" / ")}、.tauri-keys/、src-tauri/target/release/bundle/（签名私钥与安装包一律不入库）。`,
  );
} else {
  const ignoreLines = read(".gitignore")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const missing = SIGNING_PATTERNS.filter((pattern) => !ignoreLines.includes(pattern));
  if (missing.length === 0) {
    pass(`.gitignore 覆盖私钥模式：${SIGNING_PATTERNS.join(" / ")}`);
  } else {
    fail(
      `.gitignore 缺私钥模式：${missing.join(" / ")} —— 补：在 02-代码/.gitignore 里各加一行 ` +
        "（tauri 官方 updater 私钥默认名就是 tauri-signing.key / .pem）。",
    );
  }

  // 被 `!` 反忽略的私钥模式等于没覆盖（典型误改：加一行 !tauri-signing.key 想本地调试）
  const negations = ignoreLines.filter(
    (line) =>
      line.startsWith("!") &&
      SIGNING_PATTERNS.some((pattern) => {
        const core = pattern.replace(/\*/g, "");
        return core !== "" && line.toLowerCase().includes(core);
      }),
  );
  if (negations.length > 0) {
    fail(
      `.gitignore 用 \`!\` 反忽略了私钥模式（${negations.join(" / ")}）—— 补：删掉这些反忽略行；` +
        "本地要留私钥就放 .tauri-keys/ 或仓库外，别靠 add -f 之外的途径进索引。",
    );
  }
}

// 2b. git 索引里确实没有私钥/签名文件（模式对了但文件已被 add -f 进来同样要拦）
function trackedSigningFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ...SIGNING_PATTERNS], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((name) => name !== "");
  } catch {
    return null; // 非 git 环境（源码包解压 / CI 未 checkout）——降级为 WARN
  }
}

const trackedSecrets = trackedSigningFiles();
if (trackedSecrets === null) {
  warn(
    `私有链路的 git 索引检查被跳过：在 ${repoRoot} 下跑不了 \`git ls-files\`（非 git 环境）。` +
      "降级为 WARN —— 私钥模式仍由 .gitignore 断言守住。",
  );
} else if (trackedSecrets.length > 0) {
  fail(
    `git 索引里已跟踪 ${trackedSecrets.length} 个签名私钥类文件：${trackedSecrets.join(" / ")} —— ` +
      `补：\`git rm --cached <文件>\` 从索引移除（文件本身可留在本地），并确认 .gitignore 已覆盖；` +
      "已进过历史的话私钥视为泄露，必须换钥。",
  );
} else {
  pass(`git 索引无签名私钥类文件（paths：${SIGNING_PATTERNS.join(" / ")}）`);
}

// ───────────────── 3) 打包脚本齐备且可解析 ─────────────────

const installerScript = "scripts/build-installer.ps1";
if (!existsSync(path.join(root, installerScript))) {
  fail(
    `${installerScript} 不存在 —— 补：恢复本地打包脚本（跑 \`npx tauri build --bundles nsis\` 并联产物路径/大小）；` +
      "它是当前唯一的桌面发布入口。",
  );
} else {
  const text = read(installerScript);
  const missing = [];
  if (!/tauri build\b/.test(text)) missing.push("`tauri build` 调用");
  if (!/--bundles\s+nsis/.test(text)) missing.push("`--bundles nsis`（发布产物必须是 NSIS 安装包）");
  if (!/\$LASTEXITCODE/.test(text)) missing.push("`$LASTEXITCODE` 退出码检查");
  if (!/大小|Length/.test(text)) missing.push("产物大小打印");
  if (missing.length === 0) {
    pass(`${installerScript} 含 \`tauri build --bundles nsis\` + 退出码检查 + 大小打印`);
  } else {
    fail(
      `${installerScript} 缺：${missing.join(" / ")} —— 补：打包失败必须非零退出（不能静默产不出包就说成功），` +
        "并在成功时打印产物路径与大小。",
    );
  }
}

const manifestScript = "scripts/make-update-manifest.mjs";
if (!existsSync(path.join(root, manifestScript))) {
  fail(
    `${manifestScript} 不存在 —— 补：恢复 updater 清单生成脚本（产 version / pub_date / platforms / signature / url）；` +
      "缺它就没有可用的自动更新链路。",
  );
} else {
  const text = read(manifestScript);
  const requiredFields = ["version", "pub_date", "platforms", "signature", "url"];
  const missingFields = requiredFields.filter((token) => !text.includes(token));
  if (missingFields.length > 0) {
    fail(
      `${manifestScript} 未产出字段：${missingFields.join(" / ")} —— 补：latest.json 的五字段是 Tauri updater 的接口契约，` +
        "缺任一字段客户端解析失败。",
    );
  }
  // 无签名时必须明确报错退出，而不是产出空签名（空签名的 updater 包比没有清单更危险）
  if (!/process\.exit\(1\)/.test(text) || !/签名/.test(text)) {
    fail(
      `${manifestScript} 无签名时未明确报错退出 —— 补：找不到 .sig 时 console.error 说明 + process.exit(1)，` +
        "绝不产出空签名的 latest.json。",
    );
  } else if (missingFields.length === 0) {
    pass(`${manifestScript} 产出五字段且无签名时报错退出`);
  }
}

// ───────────────── 4) 发布链路无硬编码凭证 ─────────────────

const SECRET_PREFIXES = [/\bghp_[A-Za-z0-9]{10,}/, /\bsk-[A-Za-z0-9]{16,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{12,}/];
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// 键名命中「像凭证」，且值不是 `${{ ... }}` 引用 / 空串 / 块标量 → 视为硬编码
const CRED_LINE = /(password|passwd|secret|token|private[_-]?key|api[_-]?key)\s*[:=]\s*(\S.*)$/i;

// 扫描面：会承载凭证的配置面（workflow + 发布脚本），不扫业务源码与测试 fixture（避免误报）
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const scanTargets = [];
if (existsSync(workflowsDir)) {
  for (const name of readdirSync(workflowsDir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
    scanTargets.push({ abs: path.join(workflowsDir, name), label: `.github/workflows/${name}` });
  }
}
for (const file of [installerScript, manifestScript]) {
  if (existsSync(path.join(root, file))) scanTargets.push({ abs: path.join(root, file), label: file });
}

const secretProblemsBefore = problems.length;
for (const { abs, label } of scanTargets) {
  const text = readFileSync(abs, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const no = index + 1;
    if (PEM_BLOCK.test(line)) fail(`${label}:${no} 出现 PEM 私钥块 —— 补：私钥只放本地/CI secret，永不入仓。`);
    for (const prefix of SECRET_PREFIXES) {
      if (prefix.test(line)) {
        fail(`${label}:${no} 出现疑似真实令牌（${prefix.source}）—— 补：换成 secrets.* / 环境变量引用，并立刻作废该令牌。`);
      }
    }
    const cred = line.match(CRED_LINE);
    if (cred) {
      const value = cred[2].trim().replace(/^["']|["']$/g, "");
      const isRef = value.startsWith("${{") && value.endsWith("}}");
      const isScalar = value === "" || value === "|" || value === ">";
      if (!isRef && !isScalar) {
        fail(
          `${label}:${no} 疑似明文凭证：${cred[1]} = ${value.slice(0, 40)} —— 补：改引用 secrets.*（workflow）或环境变量（脚本），` +
            "硬编码值一律视为已泄露。",
        );
      }
    }
  }
}
if (problems.length === secretProblemsBefore) {
  pass(`发布链路无明文密钥（扫描 ${scanTargets.length} 个文件：${scanTargets.map((t) => t.label).join(" / ")}）`);
}

// ───────────────── 5) 发布物索引在 ─────────────────

const RELEASE_README = path.join(repoRoot, "05-交付", "安装包", "README.md");
if (!existsSync(RELEASE_README)) {
  fail(
    `05-交付/安装包/README.md 不存在 —— 补：建发布物索引（当前在售版本、文件名、体积、安装方式、历史版本清理记录），` +
      "否则发出去的包无从对账。",
  );
} else {
  const size = statSync(RELEASE_README).size;
  const text = readFileSync(RELEASE_README, "utf8");
  const hasVersion = pkgVersion ? text.includes(pkgVersion) : false;
  if (size === 0) {
    fail("05-交付/安装包/README.md 是空文件 —— 补：写入当前在售版本的索引表（文件名 / 体积 / 安装方式）。");
  } else if (!hasVersion) {
    fail(
      `05-交付/安装包/README.md 未提到当前版本号 ${pkgVersion} —— 补：发版时同步更新索引里的版本、文件名与体积` +
        "（索引与实际产物对不上，等于没有索引）。",
    );
  } else {
    pass(`05-交付/安装包/README.md 存在（${size} 字节）且提到当前版本 v${pkgVersion}`);
  }
}

// ───────────────── 6) release.yml 不存在（与 check-ci.mjs 同口径） ─────────────────

const RELEASE_WORKFLOW = path.join(repoRoot, ".github", "workflows", "release.yml");
if (existsSync(RELEASE_WORKFLOW)) {
  fail(
    ".github/workflows/release.yml 存在，但它已于 2026-11-14 删除（M7 遗留的 tag 自动打包，与手动打包流程重复，" +
      "且缺签名密钥必红）—— 补：删掉该文件；确需恢复则 **两处同时放行**：" +
      "check-ci.mjs 的 `ALLOW_RELEASE_WORKFLOW = true` + 本脚本第 6 组，并写明理由（谁在跑 / 为什么不能合并进 ci.yml）。",
  );
} else {
  pass("release.yml 不存在（未恢复 M7 遗留的 tag 自动打包）");
}

// ───────────────── 7) 门禁自身挂载 ─────────────────

try {
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  if (scripts["verify:release"] === "node scripts/verify-release.mjs") {
    pass("package.json 已挂 verify:release");
  } else {
    fail(
      `package.json 的 verify:release 脚本缺失或指向错误：${scripts["verify:release"] ?? "（缺失）"} —— ` +
        "补：改成 `node scripts/verify-release.mjs`；否则 CI 里那句 `npm run verify:release` 跑不起来。",
    );
  }
} catch {
  // package.json 解析失败已在第 1 组报过
}

// ───────────────── 汇总 ─────────────────

for (const line of ok) console.log(`  ok  ${line}`);
if (warns.length > 0) {
  for (const line of warns) console.warn(`  warn  ${line}`);
}
if (problems.length > 0) {
  console.error(`\nFAIL: 发布链路校验未通过（${problems.length} 项）`);
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`\nPASS: 发布链路校验通过（${ok.length} 项断言全绿）`);
