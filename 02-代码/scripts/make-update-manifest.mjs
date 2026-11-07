#!/usr/bin/env node
/**
 * M7 D5 · 生成 Tauri updater 形态的 `latest.json`（AC3）。
 *
 * 输入：`src-tauri/tauri.conf.json` 的 version + `src-tauri/target/release/bundle/nsis/` 下的
 *       安装包与其签名（`*.exe.sig`，由 `tauri build` 在配置了签名密钥时产出）。
 * 输出：`{"version","pub_date","platforms":{"windows-x86_64":{"signature","url"}}}`（02 §三.2）。
 *
 * **无签名时明确报错退出（exit 1），绝不产出空签名**——空签名的 manifest 会让 updater 装出
 * 一个无法验证的包，比「没有 manifest」危险得多。
 *
 * 用法：
 *   node scripts/make-update-manifest.mjs [--url-base https://…/releases/download/v0.2.0] [--out 路径]
 * 下载地址的来源优先级：`--url-base` > 环境变量 `JUDOU_RELEASE_BASE_URL` >
 *   `https://github.com/<GITHUB_REPOSITORY>/releases/download/v<version>`（CI 里自动成立）。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");
const nsisDir = path.join(bundleDir, "nsis");
const outPath = argValue("--out") ?? path.join(bundleDir, "latest.json");

/**
 * 签名链路的两步前置（E-M7-1 裁决：本仓库默认**不开启** `createUpdaterArtifacts`，
 * 以保住「一条命令就能打包」；要发布更新时才显式开启）。
 * 每条 exit 1 都带上「怎么修」，避免把脚本失败误读成 bug。
 */
const SIGN_HINT =
  "      怎么修：① 在 src-tauri/tauri.conf.json 设 bundle.createUpdaterArtifacts: true；" +
  "② 在环境里配 TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD；" +
  "③ 重新打包（scripts/build-installer.ps1）后重跑本脚本。";

if (!existsSync(confPath)) {
  console.error(`FAIL: 找不到 ${path.relative(root, confPath)}`);
  console.error("      怎么修：在 02-代码 目录下运行本脚本（它按自身位置定位 src-tauri/tauri.conf.json）。");
  process.exit(1);
}
const version = String(JSON.parse(readFileSync(confPath, "utf8")).version ?? "").trim();
if (!version) {
  console.error("FAIL: tauri.conf.json 未填写 version");
  console.error('      怎么修：填 "version"，并与 package.json / src-tauri/Cargo.toml 的 [package].version 保持一致。');
  process.exit(1);
}

if (!existsSync(nsisDir)) {
  console.error(`FAIL: 找不到打包产物目录 ${path.relative(root, nsisDir)}`);
  console.error("      怎么修：先跑 scripts/build-installer.ps1（或 npx tauri build --bundles nsis）再生成清单。");
  process.exit(1);
}

const entries = readdirSync(nsisDir);
const installer = entries.find((name) => name.toLowerCase().endsWith(".exe"));
if (!installer) {
  console.error(`FAIL: ${path.relative(root, nsisDir)} 下没有 .exe 安装包`);
  console.error("      怎么修：确认上面的 tauri build 真的成功（看它的 EXIT=0），产物应落在 src-tauri/target/release/bundle/nsis/。");
  process.exit(1);
}

// 签名文件：tauri 的默认形态是 `<安装包>.sig`
const signatureFile = `${installer}.sig`;
if (!existsSync(path.join(nsisDir, signatureFile))) {
  console.error(`FAIL: 缺签名文件 ${signatureFile} —— 不生成空签名的 manifest（否则 updater 装出无法验证的包）。`);
  console.error(SIGN_HINT);
  process.exit(1);
}
const signature = readFileSync(path.join(nsisDir, signatureFile), "utf8").trim();
if (!signature) {
  console.error(`FAIL: 签名文件 ${signatureFile} 为空`);
  console.error(SIGN_HINT);
  process.exit(1);
}

// 下载地址：CI 里 GITHUB_REPOSITORY 天然存在；本地生成时用 --url-base 或 JUDOU_RELEASE_BASE_URL
const explicitBase = argValue("--url-base") ?? process.env.JUDOU_RELEASE_BASE_URL;
const repo = process.env.GITHUB_REPOSITORY;
const base =
  explicitBase?.trim() ||
  (repo ? `https://github.com/${repo}/releases/download/v${version}` : "");
if (!base) {
  console.error("FAIL: 无法确定下载地址前缀。");
  console.error("      怎么修：传 --url-base https://…/releases/download/v<版本>，或设 JUDOU_RELEASE_BASE_URL / GITHUB_REPOSITORY。");
  process.exit(1);
}

const manifest = {
  version,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  notes: `句读 v${version}`,
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${base.replace(/\/+$/, "")}/${encodeURIComponent(installer)}`,
    },
  },
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`PASS: 已生成 ${path.relative(root, outPath)}`);
console.log(`      version = ${version}`);
console.log(`      url     = ${manifest.platforms["windows-x86_64"].url}`);
console.log(`      sig 长度 = ${signature.length}`);
