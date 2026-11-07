#!/usr/bin/env node
/**
 * M5b 运行期 CDP 取证（02 §七.2）：真窗口 1920（Browser.setWindowBounds，不用 Emulation），读真实 DOM。
 *
 * 前置：应用以 `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"` + `npm run tauri dev` 启动。
 * 用法：`node scripts/cdp/cdp-ai-import.mjs`（在 `02-代码/` 下跑；端口可用 `CDP_PORT`、`DEV_URL` 覆盖）
 *
 * 覆盖：AC1 双 Tab + 快速导入六步不回归 / AC2 题型选择与清单与分批提示 / AC3 六段式与词卡与答案 /
 *       AC4 覆盖率两态与「该句暂无解析」/ AC5 unmatched + 跳过 / AC6 markup 拒收定位 + 跳过该句可入库 /
 *       AC7 逐空覆盖率 / AC9 补解析累加 / AC13 已忽略字数 / AC14 两种处置 / AC16 缺答案 / AC18 编号纠正。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CDP_PORT ?? 9222);
// fixture 目录按本脚本位置解析（不写死机器路径）：scripts/cdp/ → ../fixtures/ai-import
const FIX = fileURLToPath(new URL("../fixtures/ai-import/", import.meta.url));
const fixture = (name) => readFileSync(`${FIX}${name}`, "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && (t.url ?? "").includes("127.0.0.1:1420"));
      if (page) return page;
      lastErr = `targets=${targets.map((t) => `${t.type}:${t.url}`).join(" | ")}`;
    } catch (err) {
      lastErr = `CDP 端口未就绪：${err.message}`;
    }
    await sleep(400);
  }
  throw new Error(`等待 CDP 目标超时：${lastErr}`);
}

function client(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`CDP 错误：${JSON.stringify(msg.error)}`));
    else resolve(msg.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});
const cdp = client(ws);

// 真窗口 1920（02 §七.2：用 Browser.setWindowBounds，不用 Emulation）
let windowMode = "unavailable";
try {
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: target.id });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: 1920, height: 1080 } });
  const info = await cdp.send("Browser.getWindowBounds", { windowId });
  windowMode = `window ${info.bounds.width}x${info.bounds.height}`;
} catch (err) {
  windowMode = `setWindowBounds 不可用（${err.message.split("\n")[0]}）`;
}

await cdp.send("Runtime.enable");
console.log(`CDP 目标：${target.url}`);
console.log(`窗口：${windowMode}`);

async function js(expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(`页面内异常：${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`);
  }
  return result.value;
}

const q = (selector) => JSON.stringify(selector);

async function waitTrue(expression, timeoutMs = 8000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await js(expression);
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`等待超时（${label}）：实际 ${JSON.stringify(last)}`);
}

const click = async (selector) => {
  const ok = await js(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`点不到元素：${selector}`);
  await sleep(120);
};

/** React 受控组件的值必须走原生 setter + 冒泡事件，否则 onChange 不触发 */
const setValue = async (selector, value) => {
  const payload = JSON.stringify(value);
  const ok = await js(`(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${payload});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`设值失败：${selector}`);
  await sleep(150);
};

const textOf = (selector) => js(`(() => { const el = document.querySelector(${q(selector)}); return el ? el.textContent.trim() : null; })()`);
const countOf = (selector) => js(`document.querySelectorAll(${q(selector)}).length`);
const exists = (selector) => js(`document.querySelector(${q(selector)}) !== null`);

let failed = false;
const results = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, actual, expected, ok });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}：实际 ${JSON.stringify(actual)}｜期望 ${JSON.stringify(expected)}`);
}
function checkTrue(label, actual, predicate = (v) => v === true) {
  const ok = predicate(actual);
  results.push({ label, actual, expected: "predicate", ok });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}：实际 ${JSON.stringify(actual)}`);
}

const goto = async (hash) => {
  await js(`location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(400);
};

/** 进 AI Tab 并把某一篇原文解析好（每个会话只做一次，之后复用同会话改 payload） */
async function openAiSession(section, textFile) {
  await goto("#/import");
  await waitTrue(`!!document.querySelector('[data-import-mode="ai"]')`, 8000, "导入页双 Tab");
  await click('[data-import-mode="ai"]');
  await waitTrue(`!!document.querySelector('[data-ai-section]')`, 8000, "AI 面板");
  await setValue("[data-ai-section]", section);
  await setValue("[data-ai-text]", fixture(textFile));
  await click("[data-ai-parse]");
  await waitTrue(`!!document.querySelector('[data-ai-stats]')`, 15000, "AI 原文解析完成");
}

async function matchPayload(text) {
  await setValue("[data-ai-payload]", text);
  await click("[data-ai-match]");
}

const createdArticleIds = [];

// ───────────────────────── AC1：双 Tab + 快速导入六步不回归 ─────────────────────────
console.log("\n── AC1 双 Tab 与快速导入六步（不回归）──");
// 先离开导入页再回来：确保是**新挂载**的首屏（同一路由元素不会重挂载，见 Import.tsx 的 hashchange 注释）
await goto("#/today");
await goto("#/import");
await waitTrue(`!!document.querySelector('[data-import-mode="quick"]')`, 8000, "快速 Tab");
check("AC1 两个 Tab 都在（quick + ai）", [
  await exists('[data-import-mode="quick"]'),
  await exists('[data-import-mode="ai"]'),
], [true, true]);
check("AC1 首屏默认在快速导入", await js(`document.querySelector('[data-quick-panel]').hidden`), false);

await setValue(
  "[data-import-text]",
  "Reading is a habit that builds over time. Many people read slowly at first.\n\nPractice makes the habit stronger every single day. Keep a notebook beside you while you read.",
);
await click("[data-import-parse]");
await waitTrue(`!!document.querySelector('[data-import-stats]')`, 10000, "快速导入预览");
const quickStats = await js(`(() => { const el = document.querySelector('[data-import-stats]'); return [Number(el.dataset.paragraphCount), Number(el.dataset.sentenceCount)]; })()`);
check("AC1 快速导入预览 段/句", quickStats, [2, 4]);

await click("[data-import-paragraph-toggle]");
check("AC1 剔段后该段标记为已剔除", await js(`document.querySelector('[data-paragraph-excluded="true"]') !== null`), true);
check("AC1 剔段后保留句数 = 2", await js(`Number(document.querySelector('[data-import-stats]').dataset.keptSentenceCount)`), 2);
await click("[data-import-paragraph-toggle]"); // 恢复，避免只剩一段

await setValue("[data-import-title]", "CDP 快速导入回归");
await click("[data-import-commit]");
await waitTrue(`location.hash.startsWith('#/article/')`, 15000, "快速导入跳精读");
const quickArticleId = Number((await js("location.hash")).split("/").pop());
createdArticleIds.push(quickArticleId);
check("AC1 快速导入跳转到精读页文章", quickArticleId > 0, true);
check("AC1 精读页标题 = 用户所填", await textOf('[data-testid="reader-title"]'), "CDP 快速导入回归");

// ───────────────────────── AC2：AI 模式选题型 + 粘原文 + 清单 + 分批提示 ─────────────────────────
console.log("\n── AC2 题型选择 / 句子清单 / 分批提示 ──");
await openAiSession("long", "long.text.txt");
check("AC2 粘原文后显示 N 段 / M 句（46 句）", await js(`Number(document.querySelector('[data-ai-stats]').dataset.sentenceCount)`), 46);
check("AC2 句子清单条数 = 句数", await countOf("[data-ai-sentence]"), 46);
check("AC2 第一条是 S1", await js(`document.querySelector('[data-ai-sentence]').dataset.sNo`), "S1");
const firstRowText = await js(`document.querySelector('[data-ai-sentence] .ai-s-text').textContent`);
checkTrue(
  "AC2 清单每行含原文前 24 字符 + 省略号（长度 25 且以 … 结尾）",
  [firstRowText.length, firstRowText.endsWith("…")],
  ([len, tail]) => len === 25 && tail === true,
);
check("AC2 句数 > 15 显示「建议分批（当前 46 句）」", (await textOf("[data-ai-batch-hint]"))?.startsWith("建议分批（当前 46 句）"), true);
check("AC2 提示词里也带同一批句子清单（S1｜…）", (await js(`document.querySelector('[data-ai-prompt]').value.includes("S1｜")`)), true);

// ───────────────────────── AC13 + AC3：容错解析 → 覆盖率 → 入库 → 精读页六段式 ─────────────────────────
console.log("\n── AC13 容错解析 + AC3 覆盖率与精读页 ──");
await openAiSession("careful", "careful.text.txt");
await matchPayload(fixture("fenced-with-prose.payload.txt"));
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC13 围栏 payload 通过");
checkTrue("AC13 已忽略 N 字说明文字（> 0）", await textOf("[data-ai-ignored-chars]"), (t) => /^已忽略 \d+ 字说明文字$/.test(t ?? ""));
check("AC3 覆盖率读数", await textOf("[data-ai-coverage]"), "解析 20/20 · 题目 5 · 词条 102");
check("AC3 非选词填空时逐空覆盖率显示 -", (await textOf("[data-ai-blank-coverage]"))?.startsWith("逐空 -（非选词填空）"), true);
check("AC3 未匹配 0 条", await countOf("[data-ai-unmatched-item]"), 0);
await click("[data-ai-commit]");
await waitTrue(`location.hash.startsWith('#/article/')`, 20000, "AI 入库跳精读");
const carefulArticleId = Number((await js("location.hash")).split("/").pop());
createdArticleIds.push(carefulArticleId);
check("AC3 入库成功并跳精读", carefulArticleId > 0, true);

await sleep(600);
await js(`document.querySelectorAll('[data-sentence-idx]')[2].click(); true`);
await waitTrue(`document.querySelector('[data-analysis-panel]')?.dataset.panelStatus === 'ready'`, 15000, "句子卡就绪");
const segments = await js(`(() => {
  const card = document.querySelector('[data-sentence-card]');
  if (!card) return null;
  const els = [...card.querySelectorAll('[data-segment]')];
  return { count: els.length, empty: els.filter((el) => el.dataset.segmentEmpty === "true").length };
})()`);
check("AC3 点句出六段式（6 段、0 段空）", segments, { count: 6, empty: 0 });

await js(`document.querySelector('[data-token-id]').click(); true`);
await waitTrue(`!!document.querySelector('[data-word-card]')`, 15000, "词卡");
check("AC3 点词出词卡", await exists("[data-word-card]"), true);

await js(`document.querySelector('[data-testid="questions"] details').open = true; true`);
await click('[data-question-toggle="0"]');
await waitTrue(`!!document.querySelector('[data-question-answer]')`, 8000, "答案展示");
check("AC3 题目区显示答案（第 1 题 = B）", await js(`document.querySelector('[data-question-answer]').dataset.questionAnswer`), "B");
check("AC3 精读页有「补解析」入口", await exists("[data-ai-patch]"), true);

// ───────────────────────── AC4：部分解析（20/M）仍可入库 + 未覆盖句显「该句暂无解析」 ─────────────────────────
console.log("\n── AC4 部分解析两态 ──");
await openAiSession("long", "long.text.txt");
await matchPayload(fixture("partial-20.payload.json"));
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC4 部分覆盖通过");
check("AC4 覆盖率 20/46", await textOf("[data-ai-coverage]"), "解析 20/46 · 题目 0 · 词条 108");
check("AC4 未匹配 0 条（缺的句子只是没给，不算不匹配）", await countOf("[data-ai-unmatched-item]"), 0);
await click("[data-ai-commit]");
await waitTrue(`location.hash.startsWith('#/article/')`, 20000, "AC4 入库跳精读");
const longArticleId = Number((await js("location.hash")).split("/").pop());
createdArticleIds.push(longArticleId);
await sleep(600);
// 最后一句（第 46 句）没有解析 → 卡片应显示「该句暂无解析」而不是空白
await js(`document.querySelectorAll('[data-sentence-idx]').length && document.querySelectorAll('[data-sentence-idx]')[document.querySelectorAll('[data-sentence-idx]').length - 1].click(); true`);
await waitTrue(`document.querySelector('[data-analysis-panel]')?.dataset.panelStatus === 'ready'`, 15000, "未覆盖句卡片");
check("AC4 未覆盖句显示「该句暂无解析」", await js(`document.querySelector('[data-sentence-card]')?.dataset.cardEmpty`), "true");
checkTrue(
  "AC4 降级文案含「暂无解析」",
  await js(`document.querySelector('[data-sentence-card]')?.textContent ?? ""`),
  (text) => text.includes("暂无解析"),
);

// ───────────────────────── AC9：补解析（20/M → 46/M，结构不变，题型预选） ─────────────────────────
console.log("\n── AC9 补解析（从库卡片入口进 patch 模式）──");
await goto("#/library");
await waitTrue(`!!document.querySelector('[data-ai-patch]')`, 10000, "库卡片补解析入口");
checkTrue(
  "AC9 库卡片「补解析」链接指向 #/import?articleId=<id>",
  await js(`[...document.querySelectorAll('[data-ai-patch]')].slice(0, 3).map((a) => a.getAttribute('href'))`),
  (hrefs) => Array.isArray(hrefs) && hrefs.length > 0 && hrefs.every((href) => /^#\/import\?articleId=\d+$/.test(href ?? "")),
);
// 精读页页头入口（同一篇文章，patch 模式判定只看 articleId 是否存在）
await goto(`#/article/${longArticleId}`);
await waitTrue(`!!document.querySelector('[data-ai-patch]')`, 10000, "精读页补解析入口");
check("AC9 精读页「补解析」带 articleId", await js(`document.querySelector('[data-ai-patch]').dataset.articleId`), String(longArticleId));
await click("[data-ai-patch]");
await waitTrue(`location.hash.includes('articleId=')`, 8000, "跳补解析");
check("AC9 补解析 URL 带 articleId", (await js("location.hash")).includes(`articleId=${longArticleId}`), true);
await waitTrue(`!!document.querySelector('[data-ai-loaded]')`, 15000, "补解析载入");
check("AC9 原文从库载入（粘原文框隐藏）", await exists("[data-ai-text]"), false);
checkTrue("AC9 载入行显示标题与段/句", await textOf("[data-ai-loaded]"), (t) => /已从文章库载入：.+ · 段 13 \/ 句 46/.test(t ?? ""));
check("AC9 题型初值取 article.section_type（long）", await js(`document.querySelector('[data-ai-section]').value`), "long");
checkTrue("AC9 覆盖率初值取库里真读数（20/46）", await textOf("[data-ai-coverage]"), (t) => (t ?? "").includes("解析 20/46"));
check("AC9 补解析按钮文案与锚点", await exists("[data-ai-patch-commit]"), true);
await matchPayload(fixture("long-batch2.payload.json"));
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC9 第二批匹配");
await click("[data-ai-patch-commit]");
await waitTrue(`!!document.querySelector('[data-ai-notice]')`, 20000, "AC9 补解析完成回执");
checkTrue("AC9 补解析回执有真读数", await textOf("[data-ai-notice]"), (t) => /已补充解析：本次写入 \d+ 句解析/.test(t ?? ""));
checkTrue("AC9 补解析后覆盖率累加到 46/46", await textOf("[data-ai-coverage]"), (t) => (t ?? "").includes("解析 46/46"));

// ───────────────────────── AC5 + AC14：未匹配句逐条列出 / 跳过 / 重新生成 ─────────────────────────
console.log("\n── AC5 未匹配 + AC14 两种处置 ──");
const longPayload = JSON.parse(fixture("long.payload.json"));
const garbled = structuredClone(longPayload);
garbled.sentences[5] = { ...garbled.sentences[5], quote: "这是 AI 改写过的第 6 句，原文里当然找不到。" };

await openAiSession("long", "long.text.txt");
await matchPayload(JSON.stringify(garbled));
await waitTrue(`!!document.querySelector('[data-ai-unmatched-item]')`, 20000, "AC5 未匹配清单");
check("AC5 unmatched 逐条列出 1 条", await countOf("[data-ai-unmatched-item]"), 1);
checkTrue("AC5 每条带原因", await js(`document.querySelector('[data-ai-unmatched-item]')?.dataset.unmatchedReason`), (t) => (t ?? "").length > 0);
check("AC5 覆盖率把这条排除在外（45/46）", await textOf("[data-ai-coverage]"), "解析 45/46 · 题目 10 · 词条 108");
await click("[data-ai-regen]");
await waitTrue(`!!document.querySelector('[data-ai-regen-text]')`, 8000, "AC14 单句小模板");
const regen = await js(`document.querySelector('[data-ai-regen-text]').value`);
checkTrue("AC14 单句模板含 S 编号", regen, (t) => /句子编号：S6/.test(t ?? ""));
checkTrue("AC14 单句模板含该句原文（取声明编号对应的 App 侧句子）", regen, (t) => /句子原文：.+/.test(t ?? "") && !t.includes("改写过的第 6 句"));
await click("[data-ai-skip]");
check("AC14 跳过后该条从未匹配清单移除", await countOf("[data-ai-unmatched-item]"), 0);
check("AC14 跳过计数 = 1", (await textOf("[data-ai-skipped-count]"))?.startsWith("已跳过 1 条"), true);
await click("[data-ai-commit]");
await waitTrue(`location.hash.startsWith('#/article/')`, 20000, "AC5 跳过后入库");
const skippedArticleId = Number((await js("location.hash")).split("/").pop());
createdArticleIds.push(skippedArticleId);
check("AC5 跳过后可继续入库（已跳精读）", skippedArticleId > 0, true);

// ───────────────────────── AC6：markup 不配平拒收 + 「跳过该句」后可入库 ─────────────────────────
console.log("\n── AC6 markup 拒收与跳过该句 ──");
const carefulPayload = JSON.parse(fixture("careful.payload.json"));
const badMarkup = structuredClone(carefulPayload);
badMarkup.sentences[3] = {
  ...badMarkup.sentences[3],
  analysis: { ...badMarkup.sentences[3].analysis, structMarkup: "【主语】People _谓语_ wonder _why" },
};

await openAiSession("careful", "careful.text.txt");
await matchPayload(JSON.stringify(badMarkup));
await waitTrue(`!!document.querySelector('[data-ai-error-code]')`, 20000, "AC6 错误条");
check("AC6 拒收码", await textOf("[data-ai-error-code]"), "AI_MARKUP_UNBALANCED");
check("AC6 定位到具体句的 structMarkup", await textOf("[data-ai-error-path]"), "定位：sentences[3].analysis.structMarkup");
check("AC6 提供「跳过该句」入口", await exists("[data-ai-skip-sentence]"), true);
await click("[data-ai-skip-sentence]");
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC6 跳过该句后匹配通过");
check("AC6 跳过后其余 19 句照常就绪", await textOf("[data-ai-coverage]"), "解析 19/20 · 题目 5 · 词条 102");
await click("[data-ai-commit]");
await waitTrue(`location.hash.startsWith('#/article/')`, 20000, "AC6 跳过后入库");
createdArticleIds.push(Number((await js("location.hash")).split("/").pop()));
check("AC6 跳过后可入库", true, true);

// ───────────────────────── AC18 编号纠正 + AC16 缺答案（同一 careful 会话内累加） ─────────────────────────
console.log("\n── AC18 编号纠正 / AC16 答案不编造 ──");
await openAiSession("careful", "careful.text.txt");
await matchPayload(fixture("renumbered.payload.json"));
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC18 通过");
check("AC18 编号已纠正 1 条（以 quote 为准）", await textOf("[data-ai-sno-fixed]"), "编号已纠正 1 条");
check("AC18 编号冲突不影响匹配", await textOf("[data-ai-coverage]"), "解析 20/20 · 题目 5 · 词条 102");
await matchPayload(fixture("answer-out-of-options.payload.json"));
await sleep(600);
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC16 通过");
check("AC16 题目缺答案 1 题（不猜不补不报错）", await textOf("[data-ai-missing-answer]"), "题目缺答案 1 题");
checkTrue("AC16 仍可入库（覆盖率仍在）", await textOf("[data-ai-coverage]"), (t) => (t ?? "").includes("解析 20/20"));

// ───────────────────────── AC7：选词填空逐空覆盖率 k/10 ─────────────────────────
console.log("\n── AC7 逐空覆盖率（cloze 6/10）──");
const clozePayload = JSON.parse(fixture("cloze.payload.json"));
const partialBlanks = structuredClone(clozePayload);
partialBlanks.blankAnalyses = partialBlanks.blankAnalyses.slice(0, 6);

await openAiSession("cloze", "cloze.text.txt");
await matchPayload(JSON.stringify(partialBlanks));
await waitTrue(`!!document.querySelector('[data-ai-coverage]')`, 20000, "AC7 部分空解析通过");
check("AC7 逐空覆盖率 6/10（少给空解析不拒收）", await textOf("[data-ai-blank-coverage]"), "逐空 6/10");
check("AC7 解析覆盖率 13/13", await textOf("[data-ai-coverage]"), "解析 13/13 · 题目 10 · 词条 74");
await matchPayload(fixture("cloze.payload.json"));
await sleep(600);
check("AC7 补齐后逐空覆盖率 10/10（累加）", await textOf("[data-ai-blank-coverage]"), "逐空 10/10");

console.log("\n── 汇总 ──");
console.log(`判据项：${results.filter((r) => r.ok).length}/${results.length} 通过`);
console.log(`本次新建文章 id：${createdArticleIds.join(", ")}`);
ws.close();
if (failed) {
  console.error("FAIL: 运行期 AI 解析导入断言未通过");
  process.exit(1);
}
console.log("PASS: 运行期 AI 解析导入断言全部通过");
