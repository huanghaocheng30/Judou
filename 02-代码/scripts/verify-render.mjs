#!/usr/bin/env node
// 机器证据脚本（02 §四）：AC1 目录五项字段 / AC4 全量 token 切片 / AC5+AC8+AC9① 纯函数断言。
// 用法：node scripts/verify-render.mjs --catalog|--tokens|--nodes|--all
// 依赖：Node 24（内置 node:sqlite 只读打开应用库；库由 src-tauri/tests/import_flow.rs 生成）
// 纪律：每条断言失败都打印期望/实际；退出码非 0 即不通过。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packDir = path.join(root, 'content-pack');
const dbPath = path.resolve(root, '..', '.tmp', 'TP1', 'verify', 'app.db');

let failures = 0;
let checks = 0;
function check(cond, label, detail = '') {
  checks += 1;
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

function readPack(file) {
  return JSON.parse(fs.readFileSync(path.join(packDir, file), 'utf8'));
}
function listPackFiles() {
  return fs
    .readdirSync(packDir)
    .filter((f) => /^cet4-2023-12-.*\.json$/.test(f))
    .sort();
}
function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
}
function openDb() {
  if (!fs.existsSync(dbPath)) {
    console.error(`库文件不存在：${dbPath}\n请先运行 Rust 集成测试生成：cd src-tauri; cargo test -- --test-threads=1 --nocapture`);
    process.exit(2);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

// AC1 的五项字段期望值（02 §一 AC1 原文；顺序＝manifest 顺序 setNo → 题型 → sourceKey）
const EXPECT = [
  ['cet4-2023-12-set1A', 350, 20],
  ['cet4-2023-12-set1B', 345, 15],
  ['cet4-2023-12-set1Long', 1023, 42],
  ['cet4-2023-12-set1Cloze', 228, 9],
  ['cet4-2023-12-set2A', 348, 15],
  ['cet4-2023-12-set2B', 344, 17],
  ['cet4-2023-12-set2Long', 990, 39],
  ['cet4-2023-12-set2Cloze', 237, 10],
  ['cet4-2023-12-set3A', 345, 19],
  ['cet4-2023-12-set3B', 343, 21],
  ['cet4-2023-12-set3Long', 1030, 58],
  ['cet4-2023-12-set3Cloze', 237, 9],
];

const ORDER_SQL = `ORDER BY setNo,
  CASE section WHEN '仔细阅读' THEN 0 WHEN '长篇阅读' THEN 1 WHEN '选词填空' THEN 2 ELSE 3 END,
  sourceKey`;

async function catalog() {
  section('AC1 数据侧：库内 12 篇五项字段 vs manifest');
  const manifest = readManifest();
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT sourceKey, title, examYear, examMonth, section, wordCount, sentenceCount
       FROM article ${ORDER_SQL}`,
    )
    .all();
  db.close();

  const manifestByKey = new Map(manifest.articles.map((a) => [a.sourceKey, a]));
  console.log('序号 | 篇名 | 年份 | 题型 | 词数 | 句数');
  rows.forEach((r, i) => {
    console.log(
      `${i + 1} | ${r.title} | ${r.examYear} 年 ${r.examMonth} 月 | ${r.section} | ${r.wordCount} 词 | ${r.sentenceCount} 句`,
    );
  });

  check(rows.length === 12, '库内 12 篇', `实际 ${rows.length}`);
  check(manifest.articles.length === 12, 'manifest 12 篇', `实际 ${manifest.articles.length}`);

  rows.forEach((r, i) => {
    const exp = EXPECT[i];
    const m = manifestByKey.get(r.sourceKey);
    const ok =
      exp &&
      r.sourceKey === exp[0] &&
      r.wordCount === exp[1] &&
      r.sentenceCount === exp[2] &&
      r.examYear === 2023 &&
      r.examMonth === 12 &&
      typeof r.title === 'string' &&
      r.title.length > 0 &&
      typeof r.section === 'string' &&
      r.section.length > 0;
    check(ok, `第 ${i + 1} 行五项字段与 02 §一 一致（${r.sourceKey}）`,
      `期望 ${exp ? exp.join('/') : '缺失'} 实际 ${[r.sourceKey, r.wordCount, r.sentenceCount].join('/')}`);
    check(!!m && m.sentenceCount === r.sentenceCount, `manifest.sentenceCount 与库一致（${r.sourceKey}）`,
      `manifest=${m && m.sentenceCount} db=${r.sentenceCount}`);
  });
  check(new Set(rows.map((r) => r.examYear + '-' + r.examMonth)).size === 1 && rows[0].examYear === 2023, '年份统一 2023/12');
}

async function tokens() {
  section('AC4 全量：6699 个 token 的 start/end 切片与 sentence.text 逐字相符');
  const db = openDb();
  const sentences = db
    .prepare('SELECT articleKey, paraIdx, idx, text FROM sentence ORDER BY articleKey, paraIdx, idx')
    .all();
  const tokenRows = db
    .prepare('SELECT articleKey, paraIdx, sentIdx, idx, start, "end" AS endOffset, surface FROM token ORDER BY articleKey, paraIdx, sentIdx, idx')
    .all();
  db.close();

  const bySentence = new Map();
  for (const s of sentences) {
    bySentence.set(`${s.articleKey}|${s.paraIdx}|${s.idx}`, s);
  }
  let total = 0;
  let mismatch = 0;
  const samples = [];
  for (const t of tokenRows) {
    total += 1;
    const s = bySentence.get(`${t.articleKey}|${t.paraIdx}|${t.sentIdx}`);
    if (!s) {
      mismatch += 1;
      if (samples.length < 3) samples.push(`缺句 ${t.articleKey} ${t.paraIdx}/${t.sentIdx}`);
      continue;
    }
    const slice = s.text.slice(t.start, t.endOffset);
    if (slice !== t.surface) {
      mismatch += 1;
      if (samples.length < 3) samples.push(`${t.articleKey} ${t.paraIdx}/${t.sentIdx}/${t.idx}: 期望 ${JSON.stringify(t.surface)} 实际 ${JSON.stringify(slice)}`);
    }
  }
  console.log(`token 总数 ${total}，切片一致 ${total - mismatch}，mismatch ${mismatch}`);
  if (samples.length) samples.forEach((s) => console.log(`  样本差异：${s}`));
  check(total === 6699, 'token 总数 6699', `实际 ${total}`);
  check(mismatch === 0, 'mismatch=0', `实际 ${mismatch}`);

  // 段落/句子级一致：每段由句子按 start/end 覆盖，句间间隙只允许空白（证明正文顺序与内容包一致）
  const dbForParagraphs = openDb();
  const paraRows = dbForParagraphs.prepare('SELECT articleKey, idx, text FROM paragraph ORDER BY articleKey, idx').all();
  const sentenceRows = dbForParagraphs
    .prepare('SELECT articleKey, paraIdx, idx, start, "end" AS endOffset, text FROM sentence ORDER BY articleKey, paraIdx, idx')
    .all();
  dbForParagraphs.close();
  const sentencesByPara = new Map();
  for (const s of sentenceRows) {
    const k = `${s.articleKey}|${s.paraIdx}`;
    const list = sentencesByPara.get(k) ?? [];
    list.push(s);
    sentencesByPara.set(k, list);
  }
  let paraMismatch = 0;
  const paraSamples = [];
  for (const para of paraRows) {
    const sents = sentencesByPara.get(`${para.articleKey}|${para.idx}`) ?? [];
    if (!sents.length) {
      paraMismatch += 1;
      paraSamples.push(`${para.articleKey} p${para.idx} 无句子`);
      continue;
    }
    const first = sents[0];
    const last = sents[sents.length - 1];
    let ok = first.start === 0 && last.endOffset === para.text.length;
    let cursor = 0;
    for (const s of sents) {
      if (s.start < cursor || s.text !== para.text.slice(s.start, s.endOffset)) ok = false;
      if (s.start > cursor && !/^\s*$/.test(para.text.slice(cursor, s.start))) ok = false;
      cursor = s.endOffset;
    }
    if (!ok) {
      paraMismatch += 1;
      if (paraSamples.length < 3) paraSamples.push(`${para.articleKey} p${para.idx}`);
    }
  }
  console.log(`段落覆盖：${paraRows.length} 段，句子 ${sentenceRows.length} 句，段落不一致 ${paraMismatch}`);
  if (paraSamples.length) console.log(`  段落异常样本：${paraSamples.join(', ')}`);
  check(paraRows.length === 90, '段落总数 90', `实际 ${paraRows.length}`);
  check(sentenceRows.length === 274, '句子总数 274', `实际 ${sentenceRows.length}`);
  check(paraMismatch === 0, '90 段全部由句子按偏移完整覆盖（间隙仅空白）', `不一致 ${paraMismatch}`);

  // AC4② 抽查：第 3 套长篇 paragraph idx=5（第 6 段，3 句）与内容包逐字相符
  const pack = readPack('cet4-2023-12-set3Long.json');
  const para = pack.paragraphs.find((p) => p.idx === 5);
  const db2 = openDb();
  const dbPara = db2.prepare('SELECT text FROM paragraph WHERE articleKey = ? AND idx = ?').get('cet4-2023-12-set3Long', 5);
  const paraSentences = db2
    .prepare('SELECT idx, start, "end" AS endOffset, text FROM sentence WHERE articleKey = ? AND paraIdx = ? ORDER BY idx')
    .all('cet4-2023-12-set3Long', 5);
  db2.close();
  console.log(`set3Long paragraph idx=5 句数 ${paraSentences.length}`);
  paraSentences.forEach((s) => console.log(`  [${s.idx}] ${s.text}`));
  check(paraSentences.length === 3, '抽查段落 3 句', `实际 ${paraSentences.length}`);
  check(dbPara.text === para.text, '抽查段落文本与内容包逐字相符');
  const sentencesOk = paraSentences.every((s) => {
    const packSent = para.sentences.find((x) => x.idx === s.idx);
    return packSent && packSent.text === s.text && packSent.start === s.start && packSent.end === s.endOffset;
  });
  check(sentencesOk, '抽查段落 3 句文本与 start/end 与内容包逐字相符');
  const packSentenceCount = pack.paragraphs.reduce((n, p) => n + p.sentences.length, 0);
  check(packSentenceCount === 58, 'set3Long 句数 58', `实际 ${packSentenceCount}`);
}

async function nodes() {
  section('AC5 / AC8 / AC9① 纯函数断言（node 直接 import，无 DOM）');
  const { renderTokens } = await import('../src/render/tokens.ts');
  const { renderErrorState } = await import('../src/render/error.ts');
  const { matchRoute, backAction, ROUTES } = await import('../src/router.ts');
  const { renderCatalogPage } = await import('../src/pages/catalog.ts');
  const { renderErrorPage } = await import('../src/pages/error.ts');

  // ---- AC5 样本 1：普通句（set1Long 第一段第一句）
  const long = readPack('cet4-2023-12-set1Long.json');
  const s1 = long.paragraphs[0].sentences[0];
  const n1 = renderTokens(s1.text, s1.tokens, []);
  const wordTokens1 = s1.tokens.filter((t) => t.isWord);
  check(wordTokens1.length > 0, '样本1 存在单词 token', `实际 ${wordTokens1.length}`);
  const wordsOk1 = wordTokens1.every((t) => {
    const node = n1.find((n) => n.type === 'word' && n.start === t.start);
    return node && node.n === t.normalized && node.text === t.surface;
  });
  check(wordsOk1, '样本1 每个 isWord token → {type:word, n:normalized, start}');
  check(n1.map((n) => n.text).join('') === s1.text, '样本1 节点拼接复原原句');
  console.log(`  [样本1] ${s1.text}`);

  // ---- AC5 样本 2：同句含空号 27/28 与正文数字 75/150（set1Cloze paragraph idx=1 sentence idx=2）
  const cloze = readPack('cet4-2023-12-set1Cloze.json');
  const para1 = cloze.paragraphs.find((p) => p.idx === 1);
  const s2 = para1.sentences[2];
  const blankNos = cloze.blankNos;
  const n2 = renderTokens(s2.text, s2.tokens, blankNos);
  console.log(`  [样本2] ${s2.text}`);
  console.log(`  [样本2] blankNos=${JSON.stringify(blankNos)}`);
  console.log('  [样本2] 节点：' + n2.map((n) => `${n.type}(${JSON.stringify(n.text)}${n.blankNo ? '#' + n.blankNo : ''}${n.n ? '/' + n.n : ''})`).join(' '));
  const b27 = n2.find((n) => n.type === 'blank' && n.blankNo === 27);
  const b28 = n2.find((n) => n.type === 'blank' && n.blankNo === 28);
  check(!!b27 && b27.text === '27', '样本2 surface="27"（∈ blankNos）→ blank#27', JSON.stringify(b27));
  check(!!b28 && b28.text === '28', '样本2 surface="28"（∈ blankNos）→ blank#28', JSON.stringify(b28));
  for (const surface of ['75', '150']) {
    const t = s2.tokens.find((x) => x.surface === surface);
    const node = n2.find((n) => n.type === 'text' && n.text === surface);
    const asBlank = n2.find((n) => n.type === 'blank' && n.text === surface);
    check(!!t, `样本2 原句含正文数字 ${surface}`);
    check(!!node, `样本2 正文数字 ${surface}（∉ blankNos）→ text 节点`, JSON.stringify(asBlank || node));
    check(!asBlank, `样本2 正文数字 ${surface} 不得判为 blank`, JSON.stringify(asBlank));
  }
  check(n2.map((n) => n.text).join('') === s2.text, '样本2 节点拼接复原原句');

  // ---- AC5 样本 3：标点与空白覆盖（token 之间的字符必须原样产出 text 节点）
  const gaps = [];
  let cursor = 0;
  for (const t of [...s2.tokens].sort((a, b) => a.start - b.start)) {
    if (t.start > cursor) gaps.push(s2.text.slice(cursor, t.start));
    cursor = Math.max(cursor, t.end);
  }
  if (cursor < s2.text.length) gaps.push(s2.text.slice(cursor));
  check(gaps.length > 0, '样本2 存在 token 间隙（空格/标点）', `间隙 ${JSON.stringify(gaps)}`);
  const textNodes = n2.filter((n) => n.type === 'text').map((n) => n.text);
  const gapsCovered = gaps.every((g) => textNodes.includes(g));
  check(gapsCovered, '样本2 每个间隙都由 text 节点原样产出', `text 节点 ${JSON.stringify(textNodes)}`);

  // ---- AC8：路由表两条记录 + 回退决策 + 目录渲染
  check(Array.isArray(ROUTES) && ROUTES.length === 2, '路由表含两条记录', JSON.stringify(ROUTES));
  check(matchRoute('#/').name === 'catalog', "matchRoute('#/') → catalog", JSON.stringify(matchRoute('#/')));
  const r = matchRoute('#/article/cet4-2023-12-set1A');
  check(r.name === 'article' && r.sourceKey === 'cet4-2023-12-set1A', "matchRoute('#/article/x') → article/x", JSON.stringify(r));
  check(matchRoute('#/article/').name === 'notFound', "matchRoute('#/article/') → notFound");
  check(backAction({ fromCatalog: true }) === 'history-back', '从目录进入时回退走 history.back()');
  check(backAction(null) === 'navigate-catalog', '无目录来源时回退跳 #/');

  const articles = listPackFiles().map((f) => {
    const p = readPack(f);
    return {
      sourceKey: p.sourceKey,
      setNo: p.meta.setNo,
      title: p.meta.title,
      examYear: p.meta.examYear,
      examMonth: p.meta.examMonth,
      section: p.meta.section,
      wordCount: p.meta.wordCount,
      sentenceCount: p.paragraphs.reduce((n, para) => n + para.sentences.length, 0),
    };
  });
  const html = renderCatalogPage(articles, null);
  const links = html.match(/#\/article\/[A-Za-z0-9-]+/g) || [];
  check(links.length === 12, '目录 HTML 含 12 个篇目链接', `实际 ${links.length}`);
  check(/第 1 套/.test(html) && /第 2 套/.test(html) && /第 3 套/.test(html), '目录 HTML 含三套分组');
  check(articles.every((a) => html.includes(`${a.wordCount} 词`) && html.includes(`${a.sentenceCount} 句`)), '目录 HTML 含逐篇词数/句数');
  check(articles.every((a) => html.includes(a.title)), '目录 HTML 含逐篇篇名');
  check(/<a class="card" href="#\/article\//.test(html), '篇目卡为 <a>（天然可 Tab 聚焦）');

  // ---- AC5 DOM 层静态检查：节点属性契约与可聚焦（纯函数只产数据，DOM 层负责落地）
  const articleSrc = fs.readFileSync(path.join(root, 'src', 'pages', 'article.ts'), 'utf8');
  check(/el\.tabIndex = 0/.test(articleSrc), '正文节点设置 tabIndex=0（可 Tab 聚焦）');
  check(/dataset\.n =/.test(articleSrc) && /dataset\.start =/.test(articleSrc), '单词节点写 data-n / data-start');
  check(/dataset\.blankNo =/.test(articleSrc) && /dataset\.start =/.test(articleSrc), '空格节点写 data-blank-no / data-start');
  check(/createElement\('button'\)/.test(articleSrc) && /aria-label/.test(articleSrc), '句末「析」为 <button> 且有 aria-label');
  check(/href="#\/"/.test(articleSrc) && /aria-label="返回目录"/.test(articleSrc), '页头返回链接为 <a href="#/"> 且 aria-label 完整');

  // ---- AC9①：错误页纯函数
  const miss = renderErrorState({ kind: 'packMissing', file: 'manifest.json' });
  console.log(`  [AC9①] ${JSON.stringify(miss)}`);
  check(miss.fileName === 'manifest.json', 'AC9① 错误页文件名=manifest.json', miss.fileName);
  check(miss.detail.includes('manifest.json'), 'AC9① 错误页文案含缺失文件名');
  check(/重新安装|检查内容包/.test(miss.detail), 'AC9① 错误页文案含处置建议');
  const corrupt = renderErrorState({ kind: 'packCorrupt', file: 'cet4-2023-12-set1A.json', detail: 'expected value at line 1' });
  check(corrupt.fileName === 'cet4-2023-12-set1A.json', 'AC9① 损坏错误页含损坏文件名', corrupt.fileName);
  check(corrupt.detail.includes('cet4-2023-12-set1A.json'), 'AC9① 损坏错误页文案含文件名');
  const errHtml = renderErrorPage(miss);
  console.log(`  [AC9①错误页HTML] ${errHtml.replace(/\s+/g, ' ')}`);
  check(!/#\/article\//.test(errHtml), 'AC9① 错误页无篇目列表（不进入空壳目录）');
  check(!/12 篇/.test(errHtml), 'AC9① 错误页无「12 篇」占位文案');
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--all';
  if (mode === '--catalog' || mode === '--all') await catalog();
  if (mode === '--tokens' || mode === '--all') await tokens();
  if (mode === '--nodes' || mode === '--all') await nodes();
  console.log(`\n== 断言 ${checks} 条，失败 ${failures} 条 ==`);
  if (failures > 0) {
    console.log('结果：FAIL');
    process.exitCode = 1;
  } else {
    console.log('结果：PASS');
  }
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exitCode = 3;
});
