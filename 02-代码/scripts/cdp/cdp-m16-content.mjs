#!/usr/bin/env node
/**
 * M16 AC4 真窗口取证：72 篇导入后抽 3 篇新文章（2024-06 / 2025-12 / 2026-06）验
 * body / 逐句解析 / 词卡 / 题目。走 WebView2 的 CDP（9222），不用 Emulation。
 *
 * 用法（在 `02-代码/` 下）：
 *   1. `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; npm run tauri dev`
 *   2. `node scripts/cdp/cdp-m16-content.mjs`
 * 端口可用 `CDP_PORT` 覆盖；截图目录可用 `OUT_DIR` 覆盖。
 *
 * 断言口径：每篇必须
 *   ① body句数 === manifest 的 sentenceCount（内容真的进来了，不是空壳）
 *   ② 词卡 `[data-word-card]` 有释义文本（lexicon 生效的关键）
 *   ③ 句子卡 `[data-sentence-card]` 有原句 + 至少 2 个非空段（翻译/主干）
 *   ④ 题目区题数 === manifest questionCount，且「显示答案」能读出答案
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.CDP_PORT ?? 9222);
const OUT_DIR = process.env.OUT_DIR ?? "../04-测试/M16/证据";
const TARGETS = [
  { year: "2024", month: 6, expectSentences: 15, expectQuestions: 5 },
  { year: "2025", month: 12, expectSentences: 15, expectQuestions: 5 },
  { year: "2026", month: 6, expectSentences: 15, expectQuestions: 5 },
];

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
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
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
    ws.addEventListener("error", reject);
    ws.addEventListener("open", () =>
      resolve({
        send: (method, params) =>
          new Promise((res, rej) => {
            const myId = ++id;
            pending.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
          }),
        close: () => ws.close(),
      }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
  return result.result.value;
}

/** 轮询直到表达式返回真（最多 timeoutMs） */
async function waitFor(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(200);
  }
  return false;
}

const list = await targets();
const page = list.find((t) => t.type === "page" && /localhost|tauri|127\.0\.0\.1|^http/.test(t.url));
if (!page) {
  console.error("FAIL[前置]: 找不到应用页面 target（dev 是否带 --remote-debugging-port=9222 起了？）");
  console.error(JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })), null, 1));
  process.exit(2);
}
log(`页面: ${page.url}`);
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
mkdirSync(OUT_DIR, { recursive: true });

const shot = async (name) => {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT_DIR, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  log(`  截图 ${file}`);
};

// ── ① 文章库篇数 ─────────────────────────────────────────────
await evaluate(cdp, `location.hash = "#/library"`);
await waitFor(cdp, `(document.querySelector('[data-testid="library-count"]')?.textContent ?? "").includes("共")`, 20000);
const countText = await evaluate(cdp, `document.querySelector('[data-testid="library-count"]')?.textContent ?? "<缺失>"`);
const cardCount = await evaluate(cdp, `document.querySelectorAll('[data-testid="article-card"]').length`);
const yearCounts = await evaluate(
  cdp,
  `Array.from(document.querySelectorAll('[data-testid="article-card"]')).reduce((m,c)=>{const y=c.dataset.year||"?";m[y]=(m[y]||0)+1;return m;},{})`,
);
log(`\n── ① 文章库 ──`);
log(`  library-count = ${countText}｜卡片数 ${cardCount}｜按年 ${JSON.stringify(yearCounts)}`);
check("文章库显示 72 篇", countText.includes("72"), `实测「${countText}」`);
check("卡片数 72", cardCount === 72, `实测 ${cardCount}`);
check(
    "各年篇数 = 批次×12（2024/2025 各 2 批、2026 1 批）",
    yearCounts["2023"] === 12 && yearCounts["2024"] === 24 && yearCounts["2025"] === 24 && yearCounts["2026"] === 12,
    JSON.stringify(yearCounts),
  );
await shot("m16-library-72.png");

// ── ② 抽 3 篇 ────────────────────────────────────────────────
for (const target of TARGETS) {
  log(`\n── ② ${target.year}-${String(target.month).padStart(2, "0")} 抽查 ──`);
  await evaluate(cdp, `location.hash = "#/library"`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="article-card"]')`);
  // 该年第一批卡片即 -06 那批（manifest 排序：年 → 月 → 套 → 题型）
  const title = await evaluate(
    cdp,
    `(() => {
      const card = document.querySelector('[data-testid="article-card"][data-year="${target.year}"]');
      if (!card) return null;
      const t = card.dataset.title;
      card.click();
      return t;
    })()`,
  );
  check(`打开 ${target.year} 篇`, Boolean(title), `标题「${title}」`);
  const ok = await waitFor(cdp, `!!document.querySelector('.sentence[data-sentence-id]')`, 12000);
  check("body渲染出句节点", ok, `等待 .sentence`);

  const body = await evaluate(
    cdp,
    `(() => {
      const s = document.querySelectorAll('.sentence[data-sentence-id]');
      const toks = document.querySelectorAll('.tok[data-token-id]');
      return { sentences: s.length, tokens: toks.length, firstSentence: s[0]?.textContent?.slice(0, 80) ?? "" };
    })()`,
  );
  log(`  body：${body.sentences} 句 / ${body.tokens} 词｜首句「${body.firstSentence}」`);
  check("有句节点", body.sentences > 0, `${body.sentences} 句`);
  check("有词节点", body.tokens > 0, `${body.tokens} 词`);

  // ③ 点词 → 词卡释义（lexicon 生效的关键）
  //    文首常是虚词（with / is / the），虚词「暂无预置解析」是设计行为 → 逐个试到实词为止
  const word = await evaluate(
    cdp,
    `(async () => {
      const els = Array.from(document.querySelectorAll('.tok[data-token-id][data-n]')).filter(
        (el) => (el.dataset.n || "").length >= 6,
      );
      const tried = [];
      for (const el of els.slice(0, 4)) {
        el.click();
        await new Promise((r) => setTimeout(r, 500));
        const card = document.querySelector('[data-word-card]');
        const mode = card?.dataset.wordMode;
        tried.push(el.dataset.n + ":" + mode);
        if (card && mode && mode !== "none") {
          return { word: el.dataset.n, mode, text: card.innerText.replace(/\\s+/g, " ").slice(0, 220), tried };
        }
      }
      return { word: null, mode: "none", text: "", tried };
    })()`,
  );
  const wordReady = Boolean(word);
  log(`  词卡 ${word?.word} mode=${word?.mode}｜${word?.text?.slice(0, 150)}`);
  check("词卡出现", wordReady, `试过 ${JSON.stringify(word?.tried)}`);
  check(
    "实词词卡有释义（lexicon 生效）",
    Boolean(word?.word && word.text.length > 8 && word.mode !== "none"),
    `${word?.word} → ${word?.mode}｜${word?.text?.slice(0, 60)}`,
  );

  // ④ 点句 → 句子卡（原句 + 段）
  await evaluate(cdp, `(() => { const s = document.querySelector('.sentence[data-sentence-id]'); const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 })); return true; })()`);
  const sentReady = await waitFor(cdp, `!!document.querySelector('[data-sentence-card]')`, 8000);
  const sentence = await evaluate(
    cdp,
    `(() => {
      const card = document.querySelector('[data-sentence-card]');
      if (!card) return null;
      const quote = card.querySelector('[data-quote-text]')?.textContent?.trim() ?? "";
      const segs = Array.from(card.querySelectorAll('[data-segment]')).map((el) => ({
        seg: el.dataset.segment, empty: el.dataset.segmentEmpty, text: el.innerText.replace(/\\s+/g, " ").trim().slice(0, 60),
      }));
      return { quote: quote.slice(0, 90), segCount: segs.length, nonEmpty: segs.filter((s) => s.empty !== "true" && s.text).length, segs };
    })()`,
  );
  log(`  句子卡：原句「${sentence?.quote}」｜非空段 ${sentence?.nonEmpty}/${sentence?.segCount}`);
  check("句子卡出现且有原句", sentReady && Boolean(sentence?.quote), `「${sentence?.quote?.slice(0, 40)}」`);
  check("解析段至少 2 段非空（翻译/主干）", (sentence?.nonEmpty ?? 0) >= 2, `${sentence?.nonEmpty}/${sentence?.segCount}`);

  // ⑤ 题目：题数 + 显示答案
  const questions = await evaluate(
    cdp,
    `(() => {
      const box = document.querySelector('[data-testid="questions"]');
      if (!box) return null;
      const items = box.querySelectorAll('[data-question-no]');
      const first = items[0];
      const toggle = first?.querySelector('[data-question-toggle]');
      toggle?.click();
      return { count: Number(box.dataset.questionCount), items: items.length, firstStem: first?.querySelector('.question-stem')?.textContent?.trim().slice(0, 70) ?? "", optionCount: first?.querySelectorAll('[data-option-key]').length ?? 0 };
    })()`,
  );
  await sleep(300);
  const answer = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector('[data-question-answer]');
      return el ? { value: el.dataset.questionAnswer, text: el.textContent.trim().slice(0, 60) } : null;
    })()`,
  );
  log(`  题目：${questions?.items} 题｜首题「${questions?.firstStem}」｜选项 ${questions?.optionCount}｜答案 ${JSON.stringify(answer)}`);
  check("题目区出现", Boolean(questions), `${questions?.count} 题`);
  check("题数与 manifest 一致（5）", questions?.count === 5 && questions?.items === 5, `实测 ${questions?.count}/${questions?.items}`);
  check("首题有 4 个选项", questions?.optionCount === 4, `实测 ${questions?.optionCount}`);
  check("「显示答案」能读出答案", Boolean(answer?.value) && answer.value !== "none", JSON.stringify(answer));

  await shot(`m16-${target.year}-${String(target.month).padStart(2, "0")}-reader.png`);
}

log(`\n结果：PASS ${PASS} / FAIL ${FAIL}`);
cdp.close();
process.exit(FAIL === 0 ? 0 : 1);
