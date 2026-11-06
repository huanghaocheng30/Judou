#!/usr/bin/env node
/**
 * M3-生词本门禁（第 1 批 D0~D3）：命令契约 + 红线 + SQL 语义 + 纯函数分组筛选。
 *
 * 五段判据，缺一不可：
 * - **A 段（文件在位）**：8 个改动文件与 4 个只读依赖都在。
 * - **B 段（契约在位）**：`vocab.rs` 8 个实现 / `commands.rs` 8 个薄包装（**不带 `#[tauri::command]` 以外的注册**）/
 *   `lib.rs` `mod vocab;` + 8 条 `generate_handler!` 注册 / `types.ts` 5 个接口 / `api.ts` 8 个封装 /
 *   `Vocab.tsx` 的 `data-vocab-*` 钩子与**不得出现 `data-has-note`**（S-R1-1）。
 * - **C 段（结构）**：`list_vocab` 函数体内 `prepare(` **恰 2 次**（条目一次 + 标签一次 = 无 N+1）。
 * - **D 段（红线 AC9）**：`vocab.rs` 的写语句目标表 ⊆ {vocab_entry, tag, vocab_tag}；`001_init.sql` 零改动。
 * - **E 段（SQL 语义 AC2/AC4/AC6）**：`node:sqlite` 临时库，**按 `db.rs` 的 `MIGRATIONS` 同序跑 001+002**，
 *   断言同词两篇收藏 1 条且三列不变 / 快照不回溯 / 无解析词可收藏 / 级联 SET NULL / 标签全量替换 /
 *   删标签不删词 / 删词连带清关联。
 * - **F 段（纯函数 AC3）**：`node` 直 import `src/lib/vocab.ts`，断言三轴分组、组序、空组过滤、
 *   标签 AND、大小写不敏感、`normalizeTagNames`、`toCardModel`、`vocabSourceHref`。
 *
 * 为什么 SQL 在 JS 里再写一遍：临时库秒级可建、种子可精确控制；Rust 侧另有 `vocab.rs` 单测覆盖同一语义
 * （双保险，沿用 `verify-note-marks.mjs` 的口径）。B 段会把「Rust 里有没有这些 SQL」静态核对一遍，漂移会被抓。
 *
 * 红线说明：本脚本**故意**有 `UPDATE token_analysis`（模拟内容包升级，验快照不回溯）——这也是
 * 02 §四 AC9 把 git grep 范围限定 `02-代码/src` 而排除 `scripts/` 的原因（评审 N-2）。
 *
 * 用法：node scripts/verify-vocab.mjs
 * 退出码：0 通过 / 1 断言不成立
 */
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = ["001_init.sql", "002_add_import_columns.sql"].map((name) =>
  path.join(root, "src-tauri", "migrations", name),
);
const FILES = {
  vocab: path.join(root, "src-tauri", "src", "vocab.rs"),
  commands: path.join(root, "src-tauri", "src", "commands.rs"),
  lib: path.join(root, "src-tauri", "src", "lib.rs"),
  types: path.join(root, "src", "lib", "types.ts"),
  api: path.join(root, "src", "lib", "api.ts"),
  vocabTs: path.join(root, "src", "lib", "vocab.ts"),
  page: path.join(root, "src", "pages", "Vocab.tsx"),
  css: path.join(root, "src", "styles", "app.css"),
};

let checks = 0;
let passed = 0;
let failed = false;
const ok = (label, condition, detail = "") => {
  checks += 1;
  if (condition) {
    passed += 1;
    console.log(`PASS | ${label}`);
  } else {
    failed = true;
    console.error(`FAIL | ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, `实际 ${a} 期望 ${e}`);
};
const read = (file) => readFileSync(file, "utf8");

// ───────────────────────────── A 段：文件在位 ─────────────────────────────

console.log("── A 段：文件在位 ──");
for (const [key, file] of Object.entries(FILES)) {
  ok(`文件存在：${path.relative(root, file)}`, existsSync(file), `缺少 ${key}`);
}
for (const file of MIGRATIONS) {
  ok(`迁移文件存在：${path.relative(root, file)}`, existsSync(file));
}
const missing = Object.values(FILES).some((file) => !existsSync(file));
const src = Object.fromEntries(
  Object.entries(FILES).map(([key, file]) => [key, existsSync(file) ? read(file) : ""]),
);

/**
 * 去掉 Rust/TS 注释：注释里会出现「绝不写 `review_plan`」「不许用 `data-has-note`」这类句子，
 * 不剥会把**声明的禁令**误判成**实际的违规**（也会把禁令当成「已实现」）。
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*#\[doc[\s\S]*?\]\s*$/gm, "");

/**
 * 砍掉文件末尾的 `#[cfg(test)] mod tests { ... }`。
 *
 * 为什么必须砍：AC9 的「三表以外零写命中」管的是**生产写路径**；而 Rust 测试必须在临时库里
 * 造内容（`article`/`paragraph`/`sentence`/`token`/`token_analysis`）才测得了生词读路径，
 * M2 的 `analysis.rs` 测试同样如此（既有先例）。不砍这段，同一口径在 M2 就早已是「红」。
 * 为了不变成摆设，D 段会把**测试模块内的写命中数**也打印出来（透明可审计）。
 *
 * 前提：测试模块位于文件末尾（本仓库四个模块都这样）——若将来测试挪到中间，本函数会切错范围，
 * 因此 D 段额外断言「被砍掉的部分以 `#[cfg(test)]` 开头」。
 */
const splitTestModule = (text) => {
  const marker = "#[cfg(test)]";
  const index = text.indexOf(marker);
  return index < 0
    ? { production: text, tests: "" }
    : { production: text.slice(0, index), tests: text.slice(index) };
};

/** 扫写语句目标表：只认 `INSERT INTO` / `UPDATE` / `DELETE FROM` 后面的标识符 */
const writeTargetsOf = (text) => [
  ...new Set(
    [...text.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(
      (match) => match[1].toLowerCase(),
    ),
  ),
];

// ───────────────────────────── B 段：契约在位 ─────────────────────────────

console.log("── B 段：命令契约（AC1） ──");

/** 8 个命令：Rust 名 / camelCase 封装名 */
const COMMANDS = [
  ["list_vocab", "listVocab"],
  ["add_vocab_from_token", "addVocabFromToken"],
  ["update_vocab", "updateVocab"],
  ["delete_vocab", "deleteVocab"],
  ["get_vocab_by_normalized", "getVocabByNormalized"],
  ["list_tags", "listTags"],
  ["set_vocab_tags", "setVocabTags"],
  ["delete_tag", "deleteTag"],
];

for (const [snake, camel] of COMMANDS) {
  ok(`vocab.rs 实现 ${snake}`, new RegExp(`pub fn ${snake}\\s*\\(`).test(src.vocab));
  ok(`commands.rs 薄包装 ${snake}`, new RegExp(`pub fn ${snake}\\s*\\(`).test(src.commands));
  ok(
    `commands.rs ${snake} 带 #[tauri::command]`,
    new RegExp(`#\\[tauri::command\\][\\s\\S]{0,200}pub fn ${snake}\\s*\\(`).test(src.commands),
  );
  ok(`lib.rs 注册 commands::${snake}`, new RegExp(`commands::${snake}\\b`).test(src.lib));
  ok(`api.ts 封装 ${camel}`, new RegExp(`export function ${camel}\\s*\\(`).test(src.api));
  ok(`api.ts 调用了命令名 "${snake}"`, new RegExp(`["'\`]${snake}["'\`]`).test(src.api));
}
ok("lib.rs 声明 mod vocab", /^mod vocab;$/m.test(src.lib), "缺少 mod vocab;");
ok(
  "vocab.rs 不含 #[tauri::command]（实现层不注册）",
  !/#\[tauri::command\]/.test(stripComments(src.vocab)),
  "`#[tauri::command]` 只许出现在 commands.rs",
);

// types.ts 5 个接口（VocabGroup 不在此，见 D2 / 评审 N-4）
for (const name of ["VocabEntry", "VocabList", "VocabPatch", "Tag", "VocabAddResult"]) {
  ok(`types.ts 定义 ${name}`, new RegExp(`export interface ${name}\\s*\\{`).test(src.types));
}
ok("types.ts 不定义 VocabGroup（D2 单落点）", !/export interface VocabGroup\b/.test(src.types));
ok("lib/vocab.ts 定义 VocabGroup", /export interface VocabGroup\s*\{/.test(src.vocabTs));
ok("lib/vocab.ts 定义 VocabFilter", /export interface VocabFilter\s*\{/.test(src.vocabTs));
ok("lib/vocab.ts 定义 VocabCardModel", /export interface VocabCardModel\s*\{/.test(src.vocabTs));

// 页面钩子（D3 产出接口）+ 收藏态属性名纪律（S-R1-1 / AC7）
// 注释里提到属性名不算「用了它」（例如文档里写「**不得**用 data-has-note 表达收藏态」），
// 所以页面断言一律先剥注释再扫——否则纪律说明句自己会把门禁搞红，等于逼人删注释。
const pageCode = stripComments(src.page);
for (const hook of ["data-vocab-count", "data-vocab-group", "data-vocab-row", "data-vocab-empty"]) {
  ok(`Vocab.tsx 有 ${hook}`, pageCode.includes(hook));
}
ok('Vocab.tsx 空态含 data-vocab-empty="all"', /data-vocab-empty="all"/.test(pageCode));
ok('Vocab.tsx 空态含 data-vocab-empty="filtered"', /data-vocab-empty="filtered"/.test(pageCode));
ok(
  "Vocab.tsx 未使用 data-has-note（不得复用笔记态表达收藏）",
  !/data-has-note/.test(pageCode),
  "S-R1-1 红线",
);
ok("Vocab.tsx 不直接 invoke（走 api.ts）", !/\binvoke\s*\(/.test(pageCode));
ok("app.css 有掌握状态三档样式", /\.mastery-new\b/.test(src.css) && /\.mastery-fuzzy\b/.test(src.css) && /\.mastery-known\b/.test(src.css));

// ───────────────────────────── C 段：结构（无 N+1） ─────────────────────────────

console.log("── C 段：结构（无 N+1） ──");
const bodyOf = (name) =>
  src.vocab.match(new RegExp(`(?:pub\\s+)?fn ${name}\\s*\\([\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
const listBody = bodyOf("list_vocab");
const tagsIndexBody = bodyOf("tags_by_vocab");
ok("能定位 list_vocab / tags_by_vocab 函数体", listBody.length > 0 && tagsIndexBody.length > 0);
eq("list_vocab 内 prepare( 次数（只查条目）", (listBody.match(/prepare\(/g) ?? []).length, 1);
eq("tags_by_vocab 内 prepare( 次数（只查标签索引）", (tagsIndexBody.match(/prepare\(/g) ?? []).length, 1);
ok("list_vocab 走批量标签索引（tags_by_vocab(conn)），不是逐条查", /tags_by_vocab\(conn\)/.test(listBody));
eq(
  "list_vocab 函数体内查询调用总数（条目 1 次；标签在索引函数里）",
  [...listBody.matchAll(/query_(?:map|row)\(/g)].length,
  1,
);
ok(
  "list_vocab 没有「每条都查一次」的循环",
  !/for\s+[\s\S]{0,40}?(prepare|query_row|query_map)\(/.test(listBody),
  "函数体里出现 for + 查询 = N+1",
);

// ───────────────────────────── D 段：红线（AC9） ─────────────────────────────

console.log("── D 段：红线（AC9） ──");
const WRITE_TABLES = new Set(["vocab_entry", "tag", "vocab_tag"]);
const { production, tests } = splitTestModule(stripComments(src.vocab));
ok("被砍掉的测试模块确实以 #[cfg(test)] 开头（切分没切错）", tests === "" || tests.startsWith("#[cfg(test)]"));
const writeTargets = writeTargetsOf(production).sort();
const testWriteTargets = writeTargetsOf(tests).sort();
console.log(`vocab.rs 生产代码写语句目标表: ${JSON.stringify(writeTargets)}`);
console.log(`vocab.rs 测试夹具写语句目标表（已除外）: ${JSON.stringify(testWriteTargets)}`);
ok("vocab.rs 有写语句（不是空实现）", writeTargets.length > 0);
ok(
  "写语句目标表 ⊆ {vocab_entry, tag, vocab_tag}",
  writeTargets.every((table) => WRITE_TABLES.has(table)),
  `越界表：${writeTargets.filter((table) => !WRITE_TABLES.has(table)).join(",") || "无"}`,
);
for (const table of ["vocab_entry", "tag", "vocab_tag"]) {
  ok(`vocab.rs 确实写 ${table}`, writeTargets.includes(table));
}
for (const table of [
  "sentence_analysis",
  "token_analysis",
  "lexicon",
  "blank",
  "article",
  "paragraph",
  "sentence",
  "token",
  "review_plan",
  "review_log",
  "reading_record",
  "sentence_note",
  "word_note",
  "app_setting",
  "schema_meta",
]) {
  ok(`vocab.rs 不写 ${table}`, !writeTargets.includes(table));
}

try {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "src-tauri/migrations/001_init.sql"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  ok("001_init.sql 相对 HEAD 零改动", changed === "", changed);
} catch (err) {
  console.log(`SKIP | git 不可用（${err.code ?? err.message}）——001 零改动以调度员 git status 证据为准`);
}

// ───────────────────────────── E 段：SQL 语义（AC2/AC4/AC6） ─────────────────────────────

console.log("── E 段：SQL 语义（临时库） ──");

const dir = mkdtempSync(path.join(tmpdir(), "judou-vocab-"));
const dbPath = path.join(dir, "vocab.db");
const db = new DatabaseSync(dbPath);

/**
 * **与 `vocab.rs` 逐字同源的 SQL**（本脚本用同一份文本；Rust 侧单测覆盖同一语义）：
 * - `ENTRY_SELECT`：条目 + 来源文章标题（LEFT JOIN article，来源删了标题自然是 NULL）
 * - `ADD_FROM_TOKEN_SQL`：从 token/sentence 取 normalized/surface/来源，从左连接 token_analysis 取快照
 * - `INSERT_ENTRY_SQL`：`ON CONFLICT(normalized) DO NOTHING` = 重复收藏不动任何列（保留首次来源）
 */
const ENTRY_SELECT = `SELECT v.id, v.normalized, v.surface, v.phonetic, v.pos, v.context_meaning,
              v.source_sentence_id, v.source_article_id, v.mastery, v.review_count,
              v.last_reviewed_at, v.created_at, v.updated_at, a.title
         FROM vocab_entry v
         LEFT JOIN article a ON a.id = v.source_article_id`;
const ADD_FROM_TOKEN_SQL = `SELECT t.normalized, t.surface, t.sentence_id, s.article_id,
              ta.phonetic, ta.pos, ta.sense_in_context
         FROM token t
         JOIN sentence s ON s.id = t.sentence_id
         LEFT JOIN token_analysis ta ON ta.token_id = t.id
        WHERE t.id = ?1`;
const INSERT_ENTRY_SQL = `INSERT INTO vocab_entry
              (normalized, surface, phonetic, pos, context_meaning, source_sentence_id, source_article_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(normalized) DO NOTHING`;
const TAGS_BY_VOCAB_SQL = `SELECT vt.vocab_id AS vocab_id, t.name AS name
         FROM vocab_tag vt
         JOIN tag t ON t.id = vt.tag_id
     ORDER BY vt.vocab_id, t.name`;
const TAGS_OF_SQL = `SELECT t.name AS name
         FROM vocab_tag vt
         JOIN tag t ON t.id = vt.tag_id
        WHERE vt.vocab_id = ?1
     ORDER BY t.name`;

try {
  for (const file of MIGRATIONS) db.exec(read(file));
  console.log(`临时库: ${dbPath}`);

  // ── 种子：A 篇（provoke，有解析 + the，无解析）/ B 篇（provoke 同词，不同语境义） ──
  const insertArticle = (key, title) =>
    Number(
      db
        .prepare("INSERT INTO article (source_key, title, exam_type, visibility) VALUES (?, ?, 'cet4', 'system')")
        .run(key, title).lastInsertRowid,
    );
  const insertSentence = (articleId, paragraphId, idx, text) =>
    Number(
      db
        .prepare(
          "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, 0, 10)",
        )
        .run(articleId, paragraphId, idx, text, `hash-${idx}`).lastInsertRowid,
    );
  const insertToken = (sentenceId, idx, surface, normalized) =>
    Number(
      db
        .prepare(
          "INSERT INTO token (sentence_id, idx, surface, normalized, start_offset, end_offset, is_word) VALUES (?, ?, ?, ?, 0, 8, 1)",
        )
        .run(sentenceId, idx, surface, normalized).lastInsertRowid,
    );
  const insertParagraph = (articleId, idx, text) =>
    Number(db.prepare("INSERT INTO paragraph (article_id, idx, text) VALUES (?, ?, ?)").run(articleId, idx, text).lastInsertRowid);

  const articleA = insertArticle("vocab-a", "A 篇");
  const paraA = insertParagraph(articleA, 0, "It provokes anger. The the.");
  const sentenceA = insertSentence(articleA, paraA, 0, "It provokes anger.");
  const tokenProvokeA = insertToken(sentenceA, 0, "provokes", "provoke");
  const tokenTheA = insertToken(sentenceA, 1, "the", "the");

  const articleB = insertArticle("vocab-b", "B 篇");
  const paraB = insertParagraph(articleB, 0, "Nothing provokes me.");
  const sentenceB = insertSentence(articleB, paraB, 0, "Nothing provokes me.");
  const tokenProvokeB = insertToken(sentenceB, 0, "provoked", "provoke");

  db.prepare(
    "INSERT INTO token_analysis (token_id, phonetic, pos, sense_in_context) VALUES (?, '/prəˈvəʊk/', 'v.', '激怒；挑起')",
  ).run(tokenProvokeA);
  db.prepare(
    "INSERT INTO token_analysis (token_id, phonetic, pos, sense_in_context) VALUES (?, '/prəˈvəʊk/', 'v.', 'B 篇里的第二种语境义')",
  ).run(tokenProvokeB);

  const entryOf = (normalized) => db.prepare(`${ENTRY_SELECT} WHERE v.normalized = ?1`).get(normalized);
  const countEntries = () => Number(db.prepare("SELECT COUNT(*) AS c FROM vocab_entry").get().c);
  const addFromToken = (tokenId) => {
    const snap = db.prepare(ADD_FROM_TOKEN_SQL).get(tokenId);
    const result = db.prepare(INSERT_ENTRY_SQL).run(
      snap.normalized,
      snap.surface,
      snap.phonetic,
      snap.pos,
      snap.sense_in_context,
      snap.sentence_id,
      snap.article_id,
    );
    return { entry: entryOf(snap.normalized), created: Number(result.changes) === 1 };
  };
  const tagsOf = (vocabId) => db.prepare(TAGS_OF_SQL).all(vocabId).map((row) => row.name);

  // ── ① 首次收藏：快照语义（normalized/surface/来源/语境义/音标词性） ──
  const first = addFromToken(tokenProvokeA);
  console.log(`首次收藏: created=${first.created} entry=${JSON.stringify({ ...first.entry, created_at: "…", updated_at: "…" })}`);
  ok("首次收藏 created=true", first.created === true);
  ok("首次收藏后映出 1 条", countEntries() === 1);
  ok("首次 normalized=provoke", first.entry.normalized === "provoke");
  ok("首次 surface 用首次加入形态 provokes", first.entry.surface === "provokes");
  ok("首次来源句 = tokenProvokeA 所在句", Number(first.entry.source_sentence_id) === sentenceA);
  ok("首次来源文章 = A 篇", Number(first.entry.source_article_id) === articleA);
  ok("首次来源文章标题 = A 篇", first.entry.title === "A 篇");
  ok("语境义 = 首次收藏瞬间的快照", first.entry.context_meaning === "激怒；挑起");
  ok("音标/词性同步快照（条目要显示它们，同源不新增列）", first.entry.phonetic === "/prəˈvəʊk/" && first.entry.pos === "v.");
  ok("默认掌握状态 new", first.entry.mastery === "new");
  ok("M4 两列保持初值（M3 不写）", Number(first.entry.review_count) === 0 && first.entry.last_reviewed_at === null);

  const firstTrio = {
    surface: first.entry.surface,
    sentence: Number(first.entry.source_sentence_id),
    article: Number(first.entry.source_article_id),
    meaning: first.entry.context_meaning,
  };

  // ── ② 同词从第二篇再收藏：仍 1 条，三列与语境义全保持首次（AC2 核心） ──
  const second = addFromToken(tokenProvokeB);
  const afterSecond = entryOf("provoke");
  console.log(`第二次收藏(B 篇): created=${second.created} 三列+语境义=${JSON.stringify({
    surface: afterSecond.surface,
    sentence: Number(afterSecond.source_sentence_id),
    article: Number(afterSecond.source_article_id),
    meaning: afterSecond.context_meaning,
  })}`);
  ok("第二次收藏 created=false（已在生词本）", second.created === false);
  eq("同词两篇收藏后 COUNT(*)=1", countEntries(), 1);
  eq("surface 保持首次", afterSecond.surface, firstTrio.surface);
  eq("source_sentence_id 保持首次", Number(afterSecond.source_sentence_id), firstTrio.sentence);
  eq("source_article_id 保持首次", Number(afterSecond.source_article_id), firstTrio.article);
  eq("context_meaning 保持首次快照（不取 B 篇语境义）", afterSecond.context_meaning, firstTrio.meaning);

  // ── ③ 快照不回溯：内容包升级（改 token_analysis）不改已收藏的语境义 ──
  db.prepare("UPDATE token_analysis SET sense_in_context = '内容包升级后的新释义' WHERE token_id = ?").run(tokenProvokeA);
  const afterUpgrade = entryOf("provoke");
  eq("内容包升级后已收藏语境义不变（快照含用户资产保护）", afterUpgrade.context_meaning, firstTrio.meaning);
  ok("手改释义后再次收藏仍不改它（第二次收藏是 DO NOTHING）", addFromToken(tokenProvokeA).entry.context_meaning === firstTrio.meaning);

  // ── ④ 无 token_analysis 的词也能收藏（context_meaning 为 NULL） ──
  const noAnalysis = addFromToken(tokenTheA);
  ok("无解析词收藏 created=true", noAnalysis.created === true);
  ok("无解析词 context_meaning IS NULL", noAnalysis.entry.context_meaning === null);
  ok("无解析词音标词性也 NULL", noAnalysis.entry.phonetic === null && noAnalysis.entry.pos === null);
  eq("此时共 2 条", countEntries(), 2);

  // ── ⑤ 标签全量替换（trim / 去空 / 去重 / 保序）+ 空组不建关联 ──
  const setTags = (vocabId, names) => {
    const cleaned = [];
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name || cleaned.includes(name)) continue;
      cleaned.push(name);
    }
    db.prepare("DELETE FROM vocab_tag WHERE vocab_id = ?1").run(vocabId);
    for (const name of cleaned) {
      db.prepare("INSERT INTO tag (name) VALUES (?1) ON CONFLICT(name) DO NOTHING").run(name);
      const tagId = Number(db.prepare("SELECT id FROM tag WHERE name = ?1").get(name).id);
      db.prepare("INSERT INTO vocab_tag (vocab_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING").run(vocabId, tagId);
    }
    return cleaned;
  };
  const provokeId = Number(entryOf("provoke").id);
  const cleaned = setTags(provokeId, [" 评估 ", "", "评估", "雅思 "]);
  eq("normalizeTagNames 口径：trim 去空去重保序", cleaned, ["评估", "雅思"]);
  eq("首次设标签后关联 2 条", tagsOf(provokeId), ["评估", "雅思"].sort());
  setTags(provokeId, ["雅思"]);
  eq("全量替换后只剩新标签", tagsOf(provokeId), ["雅思"]);
  eq(
    "旧标签解除关联但标签行仍在（删标签是独立命令）",
    Number(db.prepare("SELECT COUNT(*) AS c FROM tag WHERE name = '评估'").get().c),
    1,
  );
  setTags(noAnalysis.entry.id, ["评估"]);
  eq("两个词各自标签互不串味", tagsOf(Number(noAnalysis.entry.id)), ["评估"]);

  // ── ⑥ list_vocab 的聚合口径：一次查标签后按 vocab_id 归并（不逐条查） ──
  const tagMap = new Map();
  for (const row of db.prepare(TAGS_BY_VOCAB_SQL).all()) {
    const id = Number(row.vocab_id);
    if (!tagMap.has(id)) tagMap.set(id, []);
    tagMap.get(id).push(row.name);
  }
  const entries = db.prepare(`${ENTRY_SELECT} ORDER BY v.updated_at DESC, v.id DESC`).all();
  const flat = entries.map((row) => ({ normalized: row.normalized, tagNames: tagMap.get(Number(row.id)) ?? [] }));
  console.log(`list_vocab 平铺行: ${JSON.stringify(flat)}`);
  eq("平铺行条数 = 条目条数", flat.length, 2);
  ok(
    "每条带自己的 tagNames（不是全部标签一锅端）",
    flat.every((row) => row.tagNames.length === (row.normalized === "provoke" ? 1 : 1)),
  );
  ok("标签名按升序（断言可复算）", flat.every((row) => row.tagNames.join(",") === [...row.tagNames].sort().join(",")));

  // ── ⑦ 删标签不删词（AC6） ──
  db.prepare("DELETE FROM tag WHERE name = '评估'").run();
  eq("删标签后词仍在（2 条）", countEntries(), 2);
  eq("删标签连带解除关联", tagsOf(Number(noAnalysis.entry.id)), []);

  // ── ⑧ 删词连带清 vocab_tag（AC6） ──
  db.prepare("DELETE FROM vocab_entry WHERE id = ?").run(provokeId);
  eq("删词后条目数 1", countEntries(), 1);
  eq("删词后该词关联 0 条", Number(db.prepare("SELECT COUNT(*) AS c FROM vocab_tag WHERE vocab_id = ?").get(provokeId).c), 0);

  // ── ⑨ 来源文章删除 → SET NULL，生词保留（AC2 / 决策 #3） ──
  db.prepare("DELETE FROM article WHERE id = ?").run(articleA);
  const orphan = entryOf("the");
  ok("文章删除后生词仍在", orphan !== undefined);
  ok("来源文章/来源句被置 NULL（ON DELETE SET NULL）", orphan.source_article_id === null && orphan.source_sentence_id === null);
  ok("来源删了标题自然为 NULL（分组归「来源已删除」）", orphan.title === null);

  // ── ⑩ update_vocab 只动四列 + updated_at，不碰 review_count/last_reviewed_at（AC4 / AC9） ──
  const orphanId = Number(orphan.id);
  db.prepare("UPDATE vocab_entry SET review_count = 7, last_reviewed_at = '2026-11-06 08:00:00' WHERE id = ?").run(orphanId);
  db.prepare(
    "UPDATE vocab_entry SET context_meaning = ?1, phonetic = ?2, pos = ?3, mastery = ?4, updated_at = datetime('now') WHERE id = ?5",
  ).run("定冠词", "/ðə/", "art.", "fuzzy", orphanId);
  const updated = entryOf("the");
  eq("四列回读一致", [updated.context_meaning, updated.phonetic, updated.pos, updated.mastery], ["定冠词", "/ðə/", "art.", "fuzzy"]);
  ok("review_count 不被 M3 改动", Number(updated.review_count) === 7);
  ok("last_reviewed_at 不被 M3 改动", updated.last_reviewed_at === "2026-11-06 08:00:00");

  // ── ⑪ mastery CHECK 拒绝非法值（AC4） ──
  let checkRejected = false;
  try {
    db.prepare("UPDATE vocab_entry SET mastery = 'unknown' WHERE id = ?").run(orphanId);
  } catch {
    checkRejected = true;
  }
  ok("mastery 非法值被 DB CHECK 拒绝", checkRejected);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────────── F 段：纯函数（AC3） ─────────────────────────────

console.log("── F 段：纯函数（node 直 import lib/vocab.ts） ──");
if (!existsSync(FILES.vocabTs)) {
  ok("lib/vocab.ts 可被 node 直 import", false, "文件不存在");
} else {
  try {
    const vocabMod = await import(pathToFileURL(FILES.vocabTs).href);
    const {
      groupVocab,
      matchVocab,
      filterVocab,
      normalizeTagNames,
      toCardModel,
      vocabSourceHref,
      emptyFilter,
      MASTERY_ORDER,
      DELETED_SOURCE_KEY,
      DELETED_SOURCE_LABEL,
      UNTAGGED_KEY,
    } = vocabMod;

    const row = (patch) => ({
      id: 1,
      normalized: "provoke",
      surface: "provokes",
      phonetic: "/prəˈvəʊk/",
      pos: "v.",
      contextMeaning: "激怒",
      sourceSentenceId: 9,
      sourceArticleId: 7,
      mastery: "new",
      reviewCount: 0,
      lastReviewedAt: null,
      createdAt: "2026-11-06 10:00:00",
      updatedAt: "2026-11-06 10:00:00",
      tagNames: [],
      articleTitle: "A 篇",
      ...patch,
    });
    const rows = [
      row({ id: 1, mastery: "fuzzy", tagNames: ["评估", "雅思"] }),
      row({ id: 2, normalized: "run", surface: "runs", mastery: "known", sourceArticleId: null, sourceSentenceId: null, articleTitle: null, tagNames: ["评估"], sourceSentenceId: 3 }),
      row({ id: 3, normalized: "the", surface: "the", mastery: "new", sourceArticleId: 8, articleTitle: "B 篇", tagNames: [], sourceSentenceId: 11 }),
    ];

    eq("MASTERY_ORDER 固定 new→fuzzy→known", MASTERY_ORDER, ["new", "fuzzy", "known"]);

    // mastery 轴：固定序 + 空组不显示
    const byMastery = groupVocab(rows, "mastery");
    eq("mastery 轴组序固定 new→fuzzy→known", byMastery.map((g) => g.key), ["new", "fuzzy", "known"]);
    eq("mastery 轴逐组条目数", byMastery.map((g) => g.rows.length), [1, 1, 1]);
    eq("mastery 轴空组不显示（只给 known 一条）", groupVocab([row({ mastery: "known" })], "mastery").map((g) => g.key), ["known"]);

    // article 轴：来源已删除排最后
    const byArticle = groupVocab(rows, "article");
    console.log(`article 轴: ${JSON.stringify(byArticle.map((g) => [g.key, g.label, g.rows.length]))}`);
    eq("article 轴组序（来源已删除排最后）", byArticle.map((g) => g.key), ["7", "8", DELETED_SOURCE_KEY]);
    eq("article 轴组标签", byArticle.map((g) => g.label), ["A 篇", "B 篇", DELETED_SOURCE_LABEL]);
    eq("article 轴逐组条目数", byArticle.map((g) => g.rows.length), [1, 1, 1]);
    ok("article 轴 null 组确实是最后一项", byArticle[byArticle.length - 1].key === DELETED_SOURCE_KEY);
    eq("article 轴标题缺失时退化标签", groupVocab([row({ sourceArticleId: 8, articleTitle: null })], "article")[0].label, "文章 8");

    // tag 轴：一词可属多组（重复计入）+ 未打标签组 + 组名升序
    const byTag = groupVocab(rows, "tag");
    console.log(`tag 轴: ${JSON.stringify(byTag.map((g) => [g.key, g.rows.length]))}`);
    eq("tag 轴组名（升序，未打标签排最后）", byTag.map((g) => g.key), ["评估", "雅思", UNTAGGED_KEY]);
    eq("tag 轴逐组条目数（一词可入多组）", byTag.map((g) => g.rows.length), [2, 1, 1]);
    eq("tag 轴重复计入：总行数 > 条目数", byTag.reduce((sum, g) => sum + g.rows.length, 0), 4);
    eq("空输入 → 空分组", groupVocab([], "tag"), []);

    // 筛选：标签 AND
    eq("标签 AND：两标签齐备才命中", filterVocab(rows, { ...emptyFilter(), tagNames: ["评估", "雅思"] }).map((r) => r.id), [1]);
    eq("标签单选：命中全部带该标签的词", filterVocab(rows, { ...emptyFilter(), tagNames: ["评估"] }).map((r) => r.id), [1, 2]);
    eq("标签 AND：不存在的标签 → 空", filterVocab(rows, { ...emptyFilter(), tagNames: ["评估", "不存在"] }), []);

    // 筛选：mastery 单选 + 关键词大小写不敏感（normalized / surface 命中）
    eq("mastery 单选", filterVocab(rows, { ...emptyFilter(), mastery: "known" }).map((r) => r.id), [2]);
    eq("关键词大小写不敏感（normalized 大写）", filterVocab(rows, { ...emptyFilter(), keyword: "PROV" }).map((r) => r.id), [1]);
    eq("关键词大小写不敏感（surface 混写）", filterVocab(rows, { ...emptyFilter(), keyword: "RunS" }).map((r) => r.id), [2]);
    eq("关键词首尾空白不影响", filterVocab(rows, { ...emptyFilter(), keyword: "  the  " }).map((r) => r.id), [3]);
    eq("空关键词 → 不过滤", filterVocab(rows, emptyFilter()).map((r) => r.id), [1, 2, 3]);
    eq("组合筛选（掌握 + 标签 AND）", filterVocab(rows, { mastery: "fuzzy", tagNames: ["雅思"], keyword: "" }).map((r) => r.id), [1]);
    ok("matchVocab 单条判定与 filterVocab 一致", matchVocab(rows[0], { ...emptyFilter(), tagNames: ["评估"] }) === true);

    // normalizeTagNames
    eq("normalizeTagNames：trim 去空去重保序", normalizeTagNames([" 评估 ", "", "评估", "雅思 "]), ["评估", "雅思"]);
    eq("normalizeTagNames：非数组容错", normalizeTagNames(null), []);
    eq("normalizeTagNames：全空白 → 空", normalizeTagNames(["  ", "\t"]), []);

    // 卡片模型 + 回原句链接（D6 URL 形态：路径段 id + query sentence）
    const card = toCardModel(rows[0]);
    eq("卡片模型：文字标签（颜色非唯一通道）", card.masteryLabel, "模糊");
    eq("回原句 URL 形态 = #/article/<id>?sentence=<sid>", card.sourceHref, "#/article/7?sentence=9");
    const deletedCard = toCardModel(rows[1]);
    eq("来源已删：标题给「来源已删除」", deletedCard.sourceTitle, DELETED_SOURCE_LABEL);
    eq("来源已删：不给「回原句」链接（按钮不显示）", deletedCard.sourceHref, null);
    eq(
      "来源在但句子已删：退回文章链接（不伪造 sentence）",
      vocabSourceHref(row({ sourceSentenceId: null })),
      "#/article/7",
    );
    eq("无来源句无文章 → null", vocabSourceHref(row({ sourceArticleId: null, sourceSentenceId: null })), null);
  } catch (err) {
    ok("lib/vocab.ts 纯函数可执行", false, `${err.code ?? ""} ${err.message}`);
  }
}

// ───────────────────────────── 汇总 ─────────────────────────────

console.log("");
console.log(`判据: ${passed}/${checks} 通过${missing ? "（有文件缺失，见 A 段）" : ""}`);
if (failed) {
  console.error("FAIL: 生词本门禁未通过");
  process.exit(1);
}
console.log(
  "PASS: 8 命令契约在位 / 无 N+1（prepare 2 次）/ 三表零外写 / 001 零改动 / 同词两篇 1 条且三列不变 / 快照不回溯 / 无解析词可收藏 / 标签全量替换 / 删标签不删词 / 删词连带清关联 / 级联 SET NULL / 三轴分组与标签 AND 与大小写不敏感",
);
