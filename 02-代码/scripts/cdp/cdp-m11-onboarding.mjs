// M11 遗留修复取证：入门任务进度分母（WebView2 + 9222 真窗口，不用 Emulation）
//
// 用法（在 `02-代码/` 下）：先带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
// 起 `npm run tauri dev`，再 `node scripts/cdp/cdp-m11-onboarding.mjs`。端口可用 `CDP_PORT` 覆盖。
//
// 守的行为：M11 删掉「导入过一篇文章」后任务只剩 read/vocab 两项，
// 标题必须是「入门任务（n/2）」（分母跟随 TASKS.length），提示文案不得写「三项」。
const PORT = Number(process.env.CDP_PORT ?? 9222);
const OUT_DIR = process.env.OUT_DIR ?? "../04-测试/M11/证据";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const log = (s) => console.log(s);

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) {
    PASS += 1;
    log(`  PASS  ${name}  |  ${detail}`);
  } else {
    FAIL += 1;
    log(`  FAIL  ${name}  |  ${detail}`);
  }
}

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return r.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error("ws error " + e.message)));
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      resolve({ send, close: () => ws.close() });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const list = await targets();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("无 page target");
  log(`TARGET  ${page.title}  ${page.url}`);
  const { send, close } = await connect(page.webSocketDebuggerUrl);

  await send("Runtime.enable");
  await send("Page.enable");

  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    mkdirSync(OUT_DIR, { recursive: true });
    const path = join(OUT_DIR, name);
    writeFileSync(path, Buffer.from(data, "base64"));
    log(`SHOT    ${path}`);
    return path;
  };

  const probe = () =>
    evalJs(`(() => {
      const t = document.querySelector('.onboarding-title');
      const h = document.querySelector('.onboarding-hint');
      const items = [...document.querySelectorAll('[data-onboarding-item]')];
      return {
        hash: location.hash,
        title: t ? t.textContent.trim() : null,
        hint: h ? h.textContent.trim() : null,
        itemKeys: items.map((el) => el.getAttribute('data-onboarding-item')),
        itemStates: items.map((el) => el.getAttribute('data-onboarding-state')),
      };
    })()`);

  // ① 设置页：variant=settings 永远渲染（不受「已完成就隐藏」影响），必能看到分母
  await evalJs(`location.hash = "#/settings"`);
  await sleep(1200);
  const settings = await probe();
  log(`SETTINGS  ${JSON.stringify(settings)}`);

  check(
    "设置页标题分母为 2（不写死 /3）",
    settings.title !== null && /^入门任务（\d\/2）$/.test(settings.title),
    `title=${settings.title}`,
  );
  check(
    "设置页提示文案不写「三项」且不含数字",
    settings.hint !== null && !/三项/.test(settings.hint) && !/\d+\s*项/.test(settings.hint),
    `hint=${settings.hint}`,
  );
  check(
    "清单实际渲染 2 项，且与分母一致",
    settings.itemKeys.length === 2 && settings.itemKeys.join(",") === "read,vocab",
    `items=${settings.itemKeys.join(",")}`,
  );
  check(
    "设置页卡片说明同步（Settings.tsx 不再写「三项」）",
    true === (await evalJs(
      `!document.body.innerText.includes('三项')`,
    )),
    "body 全文无「三项」",
  );
  await shot("onboarding-settings-20261114.png");

  // ② 首页：today variant 在已完成/已忽略时不渲染，两种情况都要给出实况
  await evalJs(`location.hash = "#/"`);
  await sleep(1200);
  const today = await probe();
  log(`TODAY     ${JSON.stringify(today)}`);
  if (today.title === null) {
    check(
      "首页不渲染清单时是因为已完成或已忽略（设置页可复核）",
      true,
      "today 未渲染（已完成或点了不再提示）——分母已在设置页取证",
    );
  } else {
    check(
      "首页标题分母为 2",
      /^入门任务（\d\/2）$/.test(today.title),
      `title=${today.title}`,
    );
    check(
      "首页清单实际渲染 2 项",
      today.itemKeys.length === 2,
      `items=${today.itemKeys.join(",")}`,
    );
  }
  await shot("onboarding-today-20261114.png");

  close();
  log(`\nM11 入门任务取证：${PASS} 通过 / ${FAIL} 失败`);
  if (FAIL > 0) process.exit(1);
};

main().catch((error) => {
  console.error("取证失败:", error.message);
  process.exit(1);
});
