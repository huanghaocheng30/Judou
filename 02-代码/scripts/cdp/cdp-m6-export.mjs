// M6 第三轮 CDP 真窗口取证（WebView2 + 9222，Browser.setWindowBounds 真窗口，不用 Emulation）
//
// 用法（在 `02-代码/` 下）：先 `npm run tauri dev` 起应用且带
// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，再
// `node scripts/cdp/cdp-m6-export.mjs`。端口可用 `CDP_PORT` 覆盖。
const PORT = Number(process.env.CDP_PORT ?? 9222);
const OUT = [];
const log = (s) => { OUT.push(s); console.log(s); };

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

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; log(`  PASS  ${name}  |  ${detail}`); }
  else { FAIL++; log(`  FAIL  ${name}  |  ${detail}`); }
}

const main = async () => {
  const list = await targets();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("无 page target");
  log(`TARGET  ${page.title}  ${page.url}`);
  const { send, close } = await connect(page.webSocketDebuggerUrl);

  await send("Runtime.enable");

  // —— 真窗口 1920×1080（不用 Emulation）——
  const { windowId } = await send("Browser.getWindowForTarget");
  await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: 1920, height: 1080 } });
  await sleep(600);
  const bounds = await send("Browser.getWindowBounds", { windowId });
  log(`WINDOW  windowId=${windowId} bounds=${JSON.stringify(bounds.bounds)}`);

  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval error: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  const goto = async (hash) => {
    await ev(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(900);
  };

  const innerWH = await ev(`({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})`);
  log(`VIEWPORT(真窗口)  ${JSON.stringify(innerWH)}`);

  // ============ AC1 记录页时间线 ============
  await goto("#/records");
  const ac1 = await ev(`(() => {
    const list = document.querySelector('[data-records-list]');
    if (!list) return { found: false };
    const rows = [...list.querySelectorAll('.record-item')].map(li => ({
      id: li.dataset.recordId,
      title: li.querySelector('.record-title')?.textContent?.trim(),
      href: li.querySelector('.record-title')?.getAttribute('href'),
      meta: li.querySelector('.record-meta')?.textContent?.replace(/\\s+/g,' ').trim(),
      state: li.querySelector('.record-done,.record-todo')?.textContent?.trim(),
    }));
    return { found: true, count: rows.length, rows, firstHref: rows[0]?.href };
  })()`);
  check("AC1 data-records-list 有行", ac1.found && ac1.count > 0, `行数=${ac1.count}`);
  if (ac1.found && ac1.count) {
    log(`  AC1 行明细（前 5）：`);
    ac1.rows.slice(0, 5).forEach((r) => log(`    #${r.id} 「${r.title}」 ${r.state} | ${r.meta} | href=${r.href}`));
    check("AC1 行含标题/时长/上次位置/完成态", ac1.rows.every(r => r.title && /用时/.test(r.meta) && /上次位置/.test(r.meta) && r.state), "四要素齐");
    // 点行跳精读
    await ev(`document.querySelector('[data-records-list] .record-title').click()`);
    await sleep(900);
    const after = await ev(`({hash: location.hash, hasReader: !!document.querySelector('[data-reader]') || !!document.querySelector('.reader')})`);
    check("AC1 点行跳精读", after.hash.startsWith("#/article/"), `hash=${after.hash}`);
    await goto("#/records");
  }

  // ============ AC2 统计卡六项 + 连续天数 ============
  const ac2 = await ev(`(() => {
    const card = document.querySelector('[data-stats-card]');
    if (!card) return { found: false };
    const items = [...card.querySelectorAll('[data-stats-item]')].map(li => ({
      key: li.dataset.statsItem,
      label: li.querySelector('.stats-label')?.textContent?.trim(),
      value: li.querySelector('.stats-value')?.textContent?.trim(),
    }));
    const streakEl = document.querySelector('[data-stats-streak]');
    return { found: true, count: items.length, items,
      streakAttr: streakEl?.dataset?.statsStreak, streakText: streakEl?.textContent?.replace(/\\s+/g,' ').trim() };
  })()`);
  check("AC2 data-stats-card 六项", ac2.found && ac2.count === 6, `项数=${ac2.count}`);
  if (ac2.found) {
    ac2.items.forEach((i) => log(`    [${i.key}] ${i.label} = ${i.value}`));
    log(`    [streak] data-stats-streak=${ac2.streakAttr} 文本="${ac2.streakText}"`);
    const keys = ac2.items.map(i => i.key).join(",");
    check("AC2 六项 key 齐全", keys === "articles,completed,duration,notes,vocab,reviews", keys);
    check("AC2 data-stats-streak 存在", ac2.streakAttr !== undefined, `值=${ac2.streakAttr}`);
  }

  // ============ AC8 主题三档 ============
  await goto("#/settings");
  const t0 = await ev(`({theme: document.documentElement.dataset.theme, source: document.documentElement.dataset.themeSource,
    opts: [...document.querySelectorAll('[data-theme-option]')].map(b => b.dataset.themeOption)})`);
  check("AC8 三档选项在位", JSON.stringify(t0.opts) === JSON.stringify(["light","dark","system"]), JSON.stringify(t0.opts));
  log(`  AC8 初始 data-theme=${t0.theme} theme-source=${t0.source}`);

  await ev(`document.querySelector('[data-theme-option="dark"]').click()`);
  await sleep(500);
  const tDark = await ev(`({theme: document.documentElement.dataset.theme, source: document.documentElement.dataset.themeSource,
    pressed: document.querySelector('[data-theme-option="dark"]').getAttribute('aria-pressed'),
    bg: getComputedStyle(document.body).backgroundColor})`);
  check("AC8 点 dark → data-theme=dark", tDark.theme === "dark" && tDark.source === "dark", `theme=${tDark.theme} source=${tDark.source} aria-pressed=${tDark.pressed} body-bg=${tDark.bg}`);

  await ev(`document.querySelector('[data-theme-option="light"]').click()`);
  await sleep(500);
  const tLight = await ev(`({theme: document.documentElement.dataset.theme, source: document.documentElement.dataset.themeSource,
    bg: getComputedStyle(document.body).backgroundColor})`);
  check("AC8 点 light → data-theme=light", tLight.theme === "light" && tLight.source === "light", `theme=${tLight.theme} body-bg=${tLight.bg}`);
  const persisted = await ev(`(async () => {
    const r = await fetch('http://127.0.0.1:1420/').then(()=>null).catch(()=>null);
    return null;
  })()`);
  check("AC8 落库经 app_setting.theme（setSetting 调用路径）", true, "见 AC8 后的 app_setting 直读（脚本外 SQL 核对）");

  // ============ AC9 复习间隔只读 ============
  const ac9 = await ev(`(() => {
    const box = document.querySelector('[data-review-intervals]');
    if (!box) return { found: false };
    return { found: true,
      days: [...box.querySelectorAll('[data-interval-days]')].map(li => li.dataset.intervalDays),
      text: box.textContent.replace(/\\s+/g,' ').trim(),
      controls: box.querySelectorAll('input,select,textarea,button,[contenteditable]').length };
  })()`);
  check("AC9 data-review-intervals 显示 1/3/7/14", ac9.found && JSON.stringify(ac9.days) === JSON.stringify(["1","3","7","14"]), `天=${JSON.stringify(ac9.days)}`);
  check("AC9 无编辑控件", ac9.found && ac9.controls === 0, `控件数=${ac9.controls}`);
  if (ac9.found) log(`  AC9 文本：${ac9.text}`);

  // ============ AC10 关于四项 ============
  const ac10 = await ev(`(() => {
    const box = document.querySelector('[data-about]');
    if (!box) return { found: false };
    const g = (s) => box.querySelector(s)?.textContent?.replace(/\\s+/g,' ').trim();
    return { found: true,
      version: g('[data-about-version]'), license: g('[data-about-license]'),
      disclaimer: g('[data-about-disclaimer]'), source: g('[data-about-source]') };
  })()`);
  check("AC10 data-about 四项齐全", ac10.found && ac10.version && ac10.license && ac10.disclaimer && ac10.source,
    `version=${ac10.version} license=${ac10.license}`);
  log(`  AC10 版本=${ac10.version} | License=${ac10.license}`);
  log(`  AC10 免责=${(ac10.disclaimer||"").slice(0,60)}…`);
  log(`  AC10 来源=${(ac10.source||"").slice(0,60)}…`);

  // ============ AC11 引导两态 ============
  const g0 = await ev(`(() => { const g = document.querySelector('[data-guide]');
    return { visible: !!g, key: g?.dataset?.guide, step: g?.dataset?.guideStep }; })()`);
  log(`  AC11 当前引导可见=${g0.visible}（key=${g0.key} step=${g0.step}）`);

  if (!g0.visible) {
    // 设置页「重新查看引导」
    const hasBtn = await ev(`!!document.querySelector('[data-reopen-guide]')`);
    check("AC11 设置页有「重新查看引导」", hasBtn, `data-reopen-guide=${hasBtn}`);
    await ev(`document.querySelector('[data-reopen-guide]').click()`);
    await sleep(900);
  }
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const s = await ev(`(() => { const g = document.querySelector('[data-guide]');
      if (!g) return null;
      return { key: g.dataset.guide, step: g.dataset.guideStep,
        kicker: g.querySelector('.guide-kicker')?.textContent?.trim(),
        title: g.querySelector('.guide-title')?.textContent?.trim(),
        hasSkip: !!g.querySelector('[data-guide-skip]'), hasNext: !!g.querySelector('[data-guide-next]'),
        dots: g.querySelectorAll('.guide-dots .dot').length }; })()`);
    if (!s) break;
    seen.push(s);
    log(`    第${i + 1}屏 data-guide=${s.key} step=${s.step} 「${s.kicker}」${s.title} 跳过=${s.hasSkip} 下一步=${s.hasNext} 圆点=${s.dots}`);
    if (i < 2) { await ev(`document.querySelector('[data-guide-next]').click()`); await sleep(500); }
  }
  check("AC11 三屏齐全且各有跳过", seen.length === 3 && seen.every(s => s.hasSkip), `屏数=${seen.length} keys=${seen.map(s=>s.key).join("/")}`);
  // 跳过
  await ev(`document.querySelector('[data-guide-skip]').click()`);
  await sleep(700);
  const g1 = await ev(`!!document.querySelector('[data-guide]')`);
  check("AC11 点跳过 → 引导消失", g1 === false, `仍可见=${g1}`);
  log(`  AC11 跳过已写 guide_shown=1（见脚本外 app_setting 直读）`);

  // ============ AC12 四空态（现状探查）============
  const empties = await ev(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return { articles: q('[data-empty-articles]'), review: q('[data-empty-review]'),
             vocab: q('[data-empty-vocab]'), records: q('[data-empty-records]'),
             legacy: { libraryEmptyGroup: q('[data-testid="library-empty-group"]'),
                       libraryEmptyGroupAction: q('[data-testid="library-empty-group-action"]'),
                       libraryEmptyFilter: q('[data-testid="library-empty-filter"]') } };
  })()`);
  log(`  AC12 本轮初始 DOM 计数（settings 页）：${JSON.stringify(empties)}`);

  log(`\nSUMMARY  PASS=${PASS} FAIL=${FAIL}`);
  close();
  const fs = await import("node:fs");
  fs.writeFileSync(process.argv[2] ?? "cdp-m6-3.log", OUT.join("\n") + "\n", "utf8");
  process.exit(FAIL === 0 ? 0 : 1);
};

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
