#!/usr/bin/env node
/**
 * AC4 运行期取证 + AC3 的 ping 日志取证（不截图，读真实 DOM 与真实控制台）。
 *
 * 前置：应用以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动的
 * `npm run tauri dev`（WebView2 用同一份 Chromium DevTools 协议）。
 *
 * 用法：
 *   node scripts/check-theme-runtime.mjs cycle            # 三档各断言一次；最后停在「深色」
 *   node scripts/check-theme-runtime.mjs persisted        # 重启后断言仍为「深色」
 *
 * ponytail: 手写 ~120 行 CDP（global fetch + global WebSocket，Node 22+ 自带），
 * 不引 puppeteer/playwright —— 这里只发 Runtime.evaluate 与读 consoleAPICalled，够了。
 * 等 M2 需要真实点击/键盘事件流再评估引入 CDP 客户端库。
 */
import { readFileSync } from "node:fs";

/** 版本唯一真源：tauri.conf.json 的 version（升版只改配置一处，本脚本自动跟随）。 */
const TAURI_CONF = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

const PORT = Number(process.env.CDP_PORT ?? 9222);
const MODE = process.argv[2] ?? "cycle";
const APP_URL_HINTS = ["127.0.0.1:1420", "localhost:1420", "tauri://"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && APP_URL_HINTS.some((hint) => (t.url ?? "").includes(hint)),
      );
      if (page) return page;
      lastErr = `未找到应用页面，targets=${targets.map((t) => `${t.type}:${t.url}`).join(" | ")}`;
    } catch (err) {
      lastErr = `CDP 端口未就绪：${err.message}`;
    }
    await sleep(500);
  }
  throw new Error(`等待 CDP 目标超时：${lastErr}`);
}

function client(ws) {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP 错误：${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    for (const fn of handlers.get(msg.method) ?? []) fn(msg.params);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      const arr = handlers.get(method) ?? [];
      arr.push(fn);
      handlers.set(method, arr);
    },
  };
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  return { ws, cdp: client(ws) };
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(`页面内异常：${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`);
  return result.value;
}

async function waitFor(cdp, expression, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (last === expected) return last;
    await sleep(100);
  }
  throw new Error(`等待 \`${expression}\` = ${expected} 超时，实际 ${JSON.stringify(last)}`);
}

const readTheme = `JSON.stringify({
  theme: document.documentElement.dataset.theme,
  source: document.documentElement.dataset.themeSource,
  prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches
})`;

let failed = false;
const results = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  results.push({ label, actual, expected, ok });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}：实际 ${JSON.stringify(actual)}｜期望 ${JSON.stringify(expected)}`);
}

const target = await findPageTarget();
console.log(`CDP 目标：${target.type} ${target.url}`);
const { ws, cdp } = await connect(target.webSocketDebuggerUrl);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  if (MODE === "cycle") {
    // ── AC3：重载一次，抓真实控制台里的 ping 输出 ──
    const consoleLines = [];
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type)))
        .join(" ");
      consoleLines.push(`[${params.type}] ${text}`);
    });

    await evaluate(cdp, "location.reload(); true");
    const pingDeadline = Date.now() + 15_000;
    let pingLine = null;
    while (Date.now() < pingDeadline && !pingLine) {
      pingLine = consoleLines.find((line) => line.includes("ping →")) ?? null;
      if (!pingLine) await sleep(250);
    }
    console.log("控制台抓到的行：");
    for (const line of consoleLines) console.log(`  ${line}`);
    check(
      "AC3 控制台 ping 输出",
      pingLine?.replace(/^\[log\] /, "") ?? null,
      `ping → ${JSON.stringify({ pong: true, appVersion: TAURI_CONF.version })}`,
    );

    // ── AC4：三档各点击一次并断言 ──
    await evaluate(cdp, `location.hash = "#/settings"; true`);
    await waitFor(cdp, "document.querySelectorAll('.seg').length", 3);

    const tiers = [
      { index: 0, name: "浅色", theme: "light", source: "light" },
      { index: 1, name: "深色", theme: "dark", source: "dark" },
      { index: 2, name: "跟随系统", theme: null, source: "system" },
    ];

    for (const tier of tiers) {
      await evaluate(cdp, `document.querySelectorAll('.seg')[${tier.index}].click(); true`);
      if (tier.theme) {
        await waitFor(cdp, `document.documentElement.dataset.theme`, tier.theme);
        await waitFor(cdp, `document.documentElement.dataset.themeSource`, tier.source);
      } else {
        await waitFor(cdp, `document.documentElement.dataset.themeSource`, "system");
      }
      const state = JSON.parse(await evaluate(cdp, readTheme));
      const expectedTheme = tier.theme ?? (state.prefersDark ? "dark" : "light");
      check(`AC4 档位「${tier.name}」data-theme`, state.theme, expectedTheme);
      check(`AC4 档位「${tier.name}」data-theme-source`, state.source, tier.source);
      await sleep(300); // 给 set_setting 落库留时间
    }

    // 收尾停在「深色」，供重启后断言
    await evaluate(cdp, `document.querySelectorAll('.seg')[1].click(); true`);
    await waitFor(cdp, `document.documentElement.dataset.theme`, "dark");
    await sleep(500);
    const finalState = JSON.parse(await evaluate(cdp, readTheme));
    check("AC4 收尾状态（供重启断言）", finalState.theme, "dark");
  } else if (MODE === "persisted") {
    await waitFor(cdp, "document.documentElement.dataset.theme !== undefined", true, 10_000);
    const state = JSON.parse(await evaluate(cdp, readTheme));
    console.log(`重启后读取：${JSON.stringify(state)}`);
    check("AC4 重启后 data-theme 仍为上次选择", state.theme, "dark");
    check("AC4 重启后 data-theme-source 仍为 dark", state.source, "dark");
  } else {
    throw new Error(`未知 mode：${MODE}`);
  }
} finally {
  ws.close();
}

console.log(`判据项：${results.filter((r) => r.ok).length}/${results.length} 通过`);
if (failed) {
  console.error("FAIL: 运行期主题/ping 断言未通过");
  process.exit(1);
}
console.log("PASS: 运行期断言全部通过");
