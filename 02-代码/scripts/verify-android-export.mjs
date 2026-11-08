#!/usr/bin/env node
/**
 * M10 门禁（AC1 / AC2 / AC4 静态契约）——**红→绿的可复算证据**。
 *
 * 三组断言：
 *  1. `src/lib/platform.ts` 存在、导出 `isAndroid()` / `platformName()`、零新依赖、无 window 时安全
 *  2. `src/pages/Settings.tsx` 用 `isAndroid()` 给「导出 PDF 词表」加禁用态 + 说明，
 *     且**桌面路径未被误伤**（iframe + print 仍在）
 *  3. **UA 匹配逻辑可复算**：从 platform.ts 抽出真实正则，在 node 里对三条 UA 求值
 *     （不复制一份正则，避免脚本与源码漂移）
 *
 * 纯 node 脚本：不连库、不起前端、不改任何文件。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relPath) => readFileSync(path.join(root, relPath), "utf8");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}：${err.message}`);
    console.error(`  FAIL ${name}：${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const PLATFORM = "src/lib/platform.ts";
const SETTINGS = "src/pages/Settings.tsx";

// ───────────── 1) platform.ts（AC1） ─────────────
check("P-1 platform.ts 存在", () => {
  assert(existsSync(path.join(root, PLATFORM)), `${PLATFORM} 不存在`);
});

check("P-2 导出 isAndroid / platformName", () => {
  const src = read(PLATFORM);
  assert(/export function isAndroid\s*\(\s*\)/.test(src), "缺 export function isAndroid()");
  assert(/export function platformName\s*\(\s*\)/.test(src), "缺 export function platformName()");
});

check("P-3 零新依赖：无任何 import（含不引 @tauri-apps/plugin-os）", () => {
  // 先剥注释再断言——注释里写「不引入 plugin-os」不算违规
  const code = read(PLATFORM)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert(!/plugin-os|@tauri-apps/.test(code), "platform.ts 代码引了 tauri 插件（AC1 要求零新依赖）");
  assert(!/^\s*import\s/m.test(code), "platform.ts 不应有 import（零依赖）");
});

check("P-4 无 navigator 时安全返回（typeof 守卫）", () => {
  const src = read(PLATFORM);
  assert(/typeof navigator === "undefined"/.test(src), "缺 typeof navigator 守卫（SSR/测试会抛）");
});

check("P-5 UA 正则形如 /Android/i", () => {
  const src = read(PLATFORM);
  assert(/\/Android\/i/.test(src), "缺 /Android/i 正则");
});

// ───────────── 2) Settings.tsx（AC2） ─────────────
const settings = existsSync(path.join(root, SETTINGS)) ? read(SETTINGS) : "";
/** 取 `data-export-pdf` 所在按钮的整段开标签（到第一个 `>` 为止） */
const exportButtonTag = (() => {
  const at = settings.indexOf("data-export-pdf");
  if (at < 0) return "";
  const start = settings.lastIndexOf("<button", at);
  const end = settings.indexOf(">", at);
  return start >= 0 && end > at ? settings.slice(start, end + 1) : "";
})();

check("S-1 Settings 从 ../lib/platform 引入 isAndroid", () => {
  assert(/import\s*\{[^}]*isAndroid[^}]*\}\s*from\s*"\.\.\/lib\/platform"/.test(settings), "缺 import { isAndroid } from \"../lib/platform\"");
});

check("S-2 组件内调用 isAndroid()", () => {
  assert(/isAndroid\(\)/.test(settings), "Settings 未调用 isAndroid()");
});

check("S-3 导出按钮带 data-export-android-blocked", () => {
  assert(/data-export-android-blocked/.test(settings), "缺 data-export-android-blocked 属性");
  assert(exportButtonTag.includes("data-export-android-blocked"), "data-export-android-blocked 不在「导出 PDF 词表」按钮上");
});

check("S-4 导出按钮在 Android 下 disabled", () => {
  assert(/disabled=\{[^}]*[Aa]ndroid[^}]*\}/.test(exportButtonTag), "按钮 disabled 未与 Android 判定绑定");
});

check("S-5 说明文案逐字一致", () => {
  assert(settings.includes("Android 版暂不支持导出 PDF，请用桌面版"), "缺文案「Android 版暂不支持导出 PDF，请用桌面版」");
});

check("S-6 桌面路径未被误伤（iframe + print 仍在）", () => {
  assert(/createElement\("iframe"\)/.test(settings), "隐藏 iframe 打印实现被删");
  assert(/contentWindow/.test(settings), "contentWindow 取用被删");
  assert(/\.print\(\)/.test(settings), "print() 调用被删（桌面靠它导出 PDF）");
});

check("S-7 既有挂点未被破坏（data-export-pdf / data-export-mode / data-export-shuffle）", () => {
  assert(/data-export-pdf/.test(settings), "缺 data-export-pdf");
  assert(/data-export-mode=\{item\.mode\}/.test(settings), "缺 data-export-mode 挂点");
  assert(/data-export-shuffle/.test(settings), "缺 data-export-shuffle");
});

// ───────────── 3) UA 逻辑可复算（AC2 分支证据） ─────────────
check("U-1 同一正则对三条 UA 的判定与源码一致", () => {
  const src = read(PLATFORM);
  const m = src.match(/const\s+ANDROID_RE\s*=\s*\/(.+)\/([a-z]*)\s*;/);
  assert(m, "取不到 ANDROID_RE 定义（脚本与源码口径无法对齐）");
  const re = new RegExp(m[1], m[2]);

  const uas = [
    {
      label: "Android WebView",
      ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36",
      expect: true,
    },
    {
      label: "Windows 桌面 WebView2",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0",
      expect: false,
    },
    {
      label: "iPhone Safari（非 Android，不得误伤）",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      expect: false,
    },
  ];
  for (const { label, ua, expect } of uas) {
    const got = re.test(ua);
    assert(got === expect, `${label} 判定为 ${got}，期望 ${expect}`);
  }
  console.log(`       UA 判定：${uas.map((u) => `${u.label}=${re.test(u.ua)}`).join(" / ")}`);
});

console.log(`\n通过 ${passed} / 失败 ${failures.length}`);
if (failures.length > 0) {
  console.error("FAIL: M10 Android 兼容门禁未通过：");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("PASS: M10 Android 兼容门禁全绿（platform.ts + Settings 禁用态 + UA 逻辑）");
