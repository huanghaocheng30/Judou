#!/usr/bin/env node
/**
 * CI 配置断言（npm run verify:ci）
 *
 * ── 为什么改口径（M17，2026-11-14）──────────────────────────────
 * 旧版（M7 时代）断言 ci.yml 必须有：build job + windows/macos/ubuntu 三平台
 * matrix + `npm ci`/`npm run build`/`cargo check` 三步 + android job 以
 * `if: false` 占位并注明「M7 启用」+ ubuntu 的 webkit2gtk 依赖。
 *
 * 但那个三平台 matrix 骨架**从未实现**——ci.yml 在 M17 之前一直是「单 ubuntu
 * 的 Node 门禁 + cargo test」，android job 到今天仍是 `if: false` 占位。
 * 门禁守护一个不存在的计划 = 永久红灯；永久红灯的门禁没人看，等于没有门禁。
 * 所以本脚本改成断言**当前真实、且真会踩坑**的约束：
 *
 *   1. workflows/ci.yml 存在且可结构化解析
 *   2. Node 版本 ≥ 22（verify-sql/note/note-marks/vocab/review/render/analysis/
 *      tables 用 node:sqlite，Node 22 才内置；Node 20 直接崩 —— 已踩过的真坑）
 *   3. CI 覆盖**全部** `verify:*` 脚本（从 package.json 的 scripts 动态读取，
 *      不写死清单 —— 以后新增门禁自动被纳入校验，不会漏接）
 *   4. 有 job 跑 `cargo test`
 *   5. 有 job 跑 `npm run build`
 *   6. workflows/release.yml 不存在（2026-11-14 删除：M7 遗留的 tag 自动打包，
 *      与手动打包流程重复，且缺签名密钥必红）；要加回来必须显式放行。
 *
 * ponytail: 不引 yaml 依赖——文件是自有受控的百行结构，缩进块 + 正则够用；
 * 等 CI 拆成 reusable workflow / 多文件再上 yaml 解析器。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 若将来要加回 release.yml：把这里改成 true，并**在紧下方写明理由**（谁在跑、为什么
// 不能合并进 ci.yml、签名密钥从哪来）。不允许无理由放行。
const ALLOW_RELEASE_WORKFLOW = false;

const MIN_NODE_MAJOR = 22;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // 02-代码/

/**
 * 从 02-代码/ 向上找仓库根（GitHub 只认仓库根下的 .github/workflows）。
 * 判据用 `.git` 而不是「有 .github 就算」——02-代码/ 下曾残留一个空的
 * .github/workflows/ 目录，会让人误判成仓库根（M17 实测踩到）。
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
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const ciPath = path.join(workflowsDir, "ci.yml");
const releasePath = path.join(workflowsDir, "release.yml");

let failed = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed++;
};
const pass = (msg) => console.log(`PASS: ${msg}`);

// ── 1. ci.yml 存在且可解析 ───────────────────────────────────────
if (!existsSync(ciPath)) {
  fail(
    `CI 文件不存在：${ciPath}\n` +
      `      补：在仓库根建 .github/workflows/ci.yml（GitHub Actions 只认仓库根，不是 02-代码/ 下）。`,
  );
  console.error(`FAIL: 0 项断言通过 / ${failed} 项失败`);
  process.exit(1);
}

const text = readFileSync(ciPath, "utf8");
const lines = text.split(/\r?\n/);

const topLevel = lines.filter((l) => /^[a-zA-Z_][\w-]*:/.test(l)).map((l) => l.split(":")[0]);
for (const key of ["name", "on", "jobs"]) {
  if (!topLevel.includes(key)) {
    fail(
      `ci.yml 缺顶层键 \`${key}\`（当前顶层键：${topLevel.join(", ") || "无"}\n` +
        `      补：确保第 1 列有 \`${key}:\`（不能缩进）。`,
    );
  }
}

const jobsBlock = text.split(/^jobs:\s*$/m)[1] ?? "";
const jobNames = [...jobsBlock.matchAll(/^ {2}([a-zA-Z_][\w-]*):\s*$/gm)].map((m) => m[1]);
if (jobNames.length === 0) {
  fail(
    "jobs: 下解析不到任何 job（期望 2 空格缩进的 `<job名>:` 行）。\n" +
      `      当前解析值：${JSON.stringify(jobNames)}；补：检查 jobs: 下每个 job 的缩进是否为 2 空格。`,
  );
}
if (failed === 0) pass(`ci.yml 可解析（顶层键 ${topLevel.join("/")}，job：${jobNames.join(", ")}）`);

// ── 2. Node 版本 ≥ 22 ────────────────────────────────────────────
// 抓所有 node-version 声明（容忍 24 / '24' / "24" / v24 / 24.1.0 写法）
const nodeVersionMatches = [...text.matchAll(/node-version:\s*['"]?v?(\d+)(?:\.\d+)*['"]?/g)];
const nodeMajors = nodeVersionMatches.map((m) => Number(m[1]));

if (nodeMajors.length === 0) {
  fail(
    "ci.yml 没有锁定 Node 版本（找不到 `node-version:`）—— 版本漂移会让 node:sqlite 相关门禁在\n" +
      "      旧 Node 上随机崩。\n" +
      "      补：加 `- uses: actions/setup-node@v4` 与 `with: node-version: '24'`（必须 ≥ " +
      `${MIN_NODE_MAJOR}）。`,
  );
} else {
  for (const major of nodeMajors) {
    if (major < MIN_NODE_MAJOR) {
      fail(
        `ci.yml 的 node-version 是 ${major}，但必须 ≥ ${MIN_NODE_MAJOR}：` +
          "verify-sql / verify:note / verify:note-marks / verify:vocab / verify:review /\n" +
          "      verify:render / verify:analysis / verify:tables 都用 node:sqlite（Node 22 起内置），\n" +
          `      Node ${major} 会直接崩。\n` +
          `      补：把 ci.yml 里的 node-version 改成 '24'（或任意 ≥ ${MIN_NODE_MAJOR} 的值）。`,
      );
    }
  }
  if (nodeMajors.every((m) => m >= MIN_NODE_MAJOR)) {
    pass(`Node 版本 ${nodeMajors.join("/")} ≥ ${MIN_NODE_MAJOR}（node:sqlite 可用）`);
  }
}

// ── 3. CI 覆盖全部 verify:* 脚本（动态读 package.json）────────────
const pkgPath = path.join(root, "package.json");
let verifyScripts = [];
if (!existsSync(pkgPath)) {
  fail(`package.json 不存在：${pkgPath} —— 无法动态取 verify:* 清单。`);
} else {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    verifyScripts = Object.keys(pkg.scripts ?? {}).filter((n) => n.startsWith("verify:"));
  } catch (err) {
    fail(`package.json 解析失败：${err.message}`);
  }
}

if (verifyScripts.length > 0) {
  const missing = [];
  for (const name of verifyScripts) {
    // 用 (?![-\w]) 防止 verify:note 被 verify:note-marks 顺带满足
    const re = new RegExp(`npm run ${name.replace(/[^\w]/g, (c) => `\\${c}`)}(?![\\w:-])`);
    if (!re.test(text)) missing.push(name);
  }
  if (missing.length > 0) {
    for (const name of missing) {
      fail(
        `CI 没有运行 \`npm run ${name}\`（package.json 里定义了它，但 ci.yml 里没出现）。\n` +
          `      补：在 gates job 的 steps 里加一段 \`- name: ${name}\\n        run: npm run ${name} --silent\`；\n` +
          "      若是故意不在 CI 跑（需要本地构建产物等），在 ci.yml 里加一行注释说明并改本脚本豁免。",
      );
    }
  } else {
    pass(`CI 覆盖全部 ${verifyScripts.length} 个 verify:* 脚本（${verifyScripts.join(", ")}）`);
  }
}

// ── 4. 有 job 跑 cargo test ─────────────────────────────────────
if (!/^\s*run:\s*[^\n]*\bcargo test\b/m.test(text)) {
  fail(
    "ci.yml 里没有任何 step 跑 `cargo test`（Rust 单元测试未进门禁）。\n" +
      "      补：加一个 job（runs-on: ubuntu-latest，working-directory: 02-代码/src-tauri），\n" +
      "      装好 libwebkit2gtk-4.1-dev 等 Linux 依赖后 `run: cargo test`。",
  );
} else {
  pass("有 job 跑 cargo test");
}

// ── 5. 有 job 跑 npm run build ─────────────────────────────────
if (!/^\s*run:\s*[^\n]*\bnpm run build\b/m.test(text)) {
  fail(
    "ci.yml 里没有任何 step 跑 `npm run build`（tsc + vite 构建未进门禁，类型错误会漏到发布）。\n" +
      "      补：在 gates job 的 steps 末尾加 `- name: 前端构建\n        run: npm run build`。",
  );
} else {
  pass("有 job 跑 npm run build");
}

// ── 6. release.yml 不存在（除非显式放行）───────────────────────
if (existsSync(releasePath)) {
  if (ALLOW_RELEASE_WORKFLOW) {
    console.log(
      `WARN: workflows/release.yml 存在，但 ALLOW_RELEASE_WORKFLOW = true 已放行` +
        `（确认理由已写在本脚本常量附近）。`,
    );
  } else {
    fail(
      "workflows/release.yml 存在，但它已于 2026-11-14 删除：M7 遗留的 tag 自动打包，与手动打包\n" +
        "      流程重复，且缺签名密钥必红。\n" +
        "      补：删掉 .github/workflows/release.yml；若确需恢复，把本脚本顶部\n" +
        "      `ALLOW_RELEASE_WORKFLOW = false` 改成 true 并在紧下方写明理由（谁在跑、为什么不能合并进 ci.yml）。",
    );
  }
} else {
  pass("workflows/release.yml 不存在（未恢复 M7 遗留的 tag 自动打包）");
}

// ── 汇总 ───────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`FAIL: ci.yml 断言未通过（${failed} 项失败）`);
  process.exit(1);
}
console.log(
  "PASS: ci.yml 断言全通过（可解析 · Node ≥ 22 · verify:* 全覆盖 · cargo test · npm run build · release.yml 未恢复）",
);
