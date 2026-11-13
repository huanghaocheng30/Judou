// M11 AC7 老库启动取证：CDP 真窗口截图（文章库 + 精读页）+ 控制台错误收集
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 起 `npm run tauri dev`
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9222);
const OUT = "E:/Judou/.tmp/m11";
mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(s);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return r.json();
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    });
    ws.addEventListener("error", (e) => reject(new Error("ws error " + e.message)));
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      resolve({ send, close: () => ws.close(), events });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await targets();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("没有 page target：" + JSON.stringify(list));
log(`目标：${page.title} ${page.url}`);
const c = await connect(page.webSocketDebuggerUrl);
await c.send("Runtime.enable");
await c.send("Page.enable");

const errors = [];
async function shoot(hash, file) {
  await c.send("Runtime.evaluate", { expression: `location.hash = ${JSON.stringify(hash)}` });
  await sleep(1600);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${file}`, Buffer.from(shot.data, "base64"));
  log(`截图 ${file}`);
}

// 文章库
await shoot("#/library", "ac7-library.png");
const libText = await c.send("Runtime.evaluate", {
  expression: `JSON.stringify({count: document.querySelector('[data-testid="library-count"]')?.textContent ?? null, cards: document.querySelectorAll('[data-testid="article-card"]').length, nav: document.querySelectorAll('.nav-list a').length, navLabels: [...document.querySelectorAll('.nav-label')].map(e=>e.textContent)})`,
  returnByValue: true,
});
log("文章库：" + libText.result.value);

// 精读第一篇
const first = await c.send("Runtime.evaluate", {
  expression: `document.querySelector('[data-testid="article-card"]')?.dataset.articleId ?? null`,
  returnByValue: true,
});
const artId = first.result.value;
if (!artId) throw new Error("文章库没有卡片");
await shoot(`#/article/${artId}`, "ac7-reader.png");
const rdText = await c.send("Runtime.evaluate", {
  expression: `JSON.stringify({title: document.querySelector('.reader-title')?.textContent ?? document.title, sentences: document.querySelectorAll('.sentence').length, body: !!document.querySelector('[data-testid="reader-body"]'), patch: !!document.querySelector('[data-ai-patch]'), edit: !!document.querySelector('[data-article-edit]'), importRoute: !!document.querySelector('[data-testid="import-root"]')})`,
  returnByValue: true,
});
log("精读页：" + rdText.result.value);

// 记录 / 生词本 / 复习 三页不报错
for (const [hash, name] of [["#/records", "记录"], ["#/vocab", "生词本"], ["#/review", "复习"]]) {
  await c.send("Runtime.evaluate", { expression: `location.hash = ${JSON.stringify(hash)}` });
  await sleep(1200);
  const r = await c.send("Runtime.evaluate", {
    expression: `JSON.stringify({alert: document.querySelector('[role="alert"]')?.textContent ?? null, text: document.body.innerText.slice(0,120)})`,
    returnByValue: true,
  });
  log(`${name}页：${r.result.value}`);
}

// #/import 直接访问应回落今日页
await c.send("Runtime.evaluate", { expression: `location.hash = "#/import"` });
await sleep(1200);
const imp = await c.send("Runtime.evaluate", {
  expression: `JSON.stringify({hash: location.hash, isToday: !!document.querySelector('[data-testid="today"]'), hasImport: document.body.innerText.includes("粘贴或选择文件")})`,
  returnByValue: true,
});
log(`#/import 直访：${imp.result.value}`);

const consoleErrors = c.events
  .filter((e) => e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))
  .map((e) => `${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
log(`控制台 error/warning ${consoleErrors.length} 条` + (consoleErrors.length ? "：" + consoleErrors.slice(0, 5).join(" | ") : ""));
c.close();
