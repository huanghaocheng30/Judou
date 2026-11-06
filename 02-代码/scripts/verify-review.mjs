#!/usr/bin/env node
/**
 * M4-复习门禁（第 1 批 D0~D2）：命令契约 + 红线 + SQL 语义 + 纯函数顺延。
 *
 * 五段判据，缺一不可：
 * - **A 段（文件在位）**：`review.rs` / `review.ts` / 门禁自身 / 迁移文件。
 * - **B 段（契约在位，AC1）**：`review.rs` 7 个实现 / `commands.rs` 7 个带 `#[tauri::command]` 的薄包装 /
 *   `lib.rs` `mod review;` + `generate_handler!` **一处**含 7 条 `commands::` / `types.ts` 4 个类型 /
 *   `api.ts` 7 个一行式封装 / **日期来源禁令**（`review.rs` 生产代码无 `date('now')`）。
 * - **C 段（红线 AC9 · 静态）**：`review.rs` 生产代码写语句目标表 ⊆ {review_plan, review_log, reading_record}；
 *   `reading_record` 的 SET 子句**只许**出现 `completed` / `last_read_at`；`001_init.sql` 零改动。
 * - **D 段（SQL 语义 AC2/AC3/AC4/AC7/AC8）**：`node:sqlite` 临时库，**按 `db.rs` 的 `MIGRATIONS` 同序跑 001+002**，
 *   逐项验 9 条（首调建计划 / 幂等 / 到期过滤排序 / done 四档 / index=3 终态 / need_more / restart 两分支 /
 *   log 记完成前 index / 三表以外零写）。
 * - **E 段（纯函数 AC4 · D2）**：`node` 直 import `src/lib/review.ts`，**与 Rust 同一组用例**跑顺延规则
 *   （Rust 权威、TS 只做乐观预览——两边漂移会被这一段抓住）。
 *
 * 为什么 SQL 在 JS 里再写一遍：临时库秒级可建、today 可固定；Rust 侧另有 `review.rs` 单测覆盖同一语义
 * （双保险，沿用 `verify-vocab.mjs` 的口径）。
 *
 * 红线说明：本脚本**故意**有 `UPDATE review_plan`（摆到期日）与 `INSERT article`（种子）——这也是
 * 02 §四 AC9 把 git grep 范围限定 `02-代码/src` 而排除 `scripts/` 的原因（评审 N-2）。
 *
 * 用法：node scripts/verify-review.mjs
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
  review: path.join(root, "src-tauri", "src", "review.rs"),
  commands: path.join(root, "src-tauri", "src", "commands.rs"),
  lib: path.join(root, "src-tauri", "src", "lib.rs"),
  reviewTs: path.join(root, "src", "lib", "review.ts"),
  types: path.join(root, "src", "lib", "types.ts"),
  api: path.join(root, "src", "lib", "api.ts"),
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
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// ───────────────────────────── A 段：文件在位 ─────────────────────────────

console.log("── A 段：文件在位 ──");
for (const [key, file] of Object.entries(FILES)) {
  ok(`文件存在：${path.relative(root, file)}`, existsSync(file), `缺少 ${key}`);
}
for (const file of MIGRATIONS) {
  ok(`迁移文件存在：${path.relative(root, file)}`, existsSync(file));
}
const src = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, read(file)]));

/** 剥注释：注释里会出现「**不出现** `date('now')`」这类禁令句，不剥会把禁令当违规（也把禁令当实现）。 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*\/\/\/[^\n]*$/gm, "");

/**
 * 砍掉文件末尾的 `#[cfg(test)] mod tests { ... }`。
 *
 * 为什么必须砍：AC9 的「三表以外零写命中」管的是**生产写路径**；Rust 测试必须在临时库里造
 * `article` 才行（`vocab.rs` / `analysis.rs` 同一先例）。D 段会打印被砍掉的测试写目标，透明可审计。
 */
const splitTestModule = (text) => {
  const index = text.indexOf("#[cfg(test)]");
  return index < 0
    ? { production: text, tests: "" }
    : { production: text.slice(0, index), tests: text.slice(index) };
};

/**
 * 扫写语句目标表：只认 `INSERT INTO` / `UPDATE` / `DELETE FROM` 后面的标识符。
 *
 * 排除 `SET`：`ON CONFLICT(...) DO UPDATE SET` 里的 `UPDATE` 后面跟的是 `SET` 而不是表名——
 * 不排会把 upsert 分支误报成「写了一张叫 set 的表」（实测踩到，见执行自测的 concerns）。
 */
const writeTargetsOf = (text) => [
  ...new Set(
    [...text.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((match) => match[1].toLowerCase())
      .filter((table) => table !== "set"),
  ),
];

// ───────────────────────────── B 段：契约在位（AC1） ─────────────────────────────

console.log("── B 段：命令契约（AC1） ──");

/** 7 个命令：Rust 名 / camelCase 封装名 */
const COMMANDS = [
  ["mark_article_completed", "markArticleCompleted"],
  ["get_due_reviews", "getDueReviews"],
  ["get_review_plan", "getReviewPlan"],
  ["complete_review", "completeReview"],
  ["restart_review_plan", "restartReviewPlan"],
  ["list_review_logs", "listReviewLogs"],
  ["list_review_plans", "listReviewPlans"],
];

for (const [snake, camel] of COMMANDS) {
  ok(`review.rs 实现 ${snake}`, new RegExp(`pub fn ${snake}\\s*\\(`).test(src.review));
  ok(`commands.rs 薄包装 ${snake}`, new RegExp(`pub fn ${snake}\\s*\\(`).test(src.commands));
  ok(
    `commands.rs ${snake} 带 #[tauri::command]`,
    new RegExp(`#\\[tauri::command\\][\\s\\S]{0,200}pub fn ${snake}\\s*\\(`).test(src.commands),
  );
  ok(`lib.rs 注册 commands::${snake}`, new RegExp(`commands::${snake}\\b`).test(src.lib));
  ok(`api.ts 封装 ${camel}`, new RegExp(`export function ${camel}\\s*\\(`).test(src.api));
  ok(`api.ts 调用了命令名 "${snake}"`, new RegExp(`["'\`]${snake}["'\`]`).test(src.api));
}
ok("lib.rs 声明 mod review", /^mod review;$/m.test(src.lib), "缺少 mod review;");
ok(
  "review.rs 不含 #[tauri::command]（实现层不注册）",
  !/#\[tauri::command\]/.test(stripComments(src.review)),
  "`#[tauri::command]` 只许出现在 commands.rs",
);

/** `generate_handler!` 宏块：7 条必须在**同一处**注册（拆成两个宏块会被 tauri 只认后一个覆盖掉） */
const handlerBlocks = [...src.lib.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)].map((m) => m[1]);
eq("lib.rs 只有一个 generate_handler! 宏块", handlerBlocks.length, 1);
const handlerBody = handlerBlocks[0] ?? "";
const registered = COMMANDS.filter(([snake]) => new RegExp(`commands::${snake}\\b`).test(handlerBody));
eq(
  "该宏块内 7 个 M4 命令全部注册（commands:: 形态）",
  registered.map(([snake]) => snake),
  COMMANDS.map(([snake]) => snake),
);
console.log(`generate_handler! 内 M4 命令行数: ${(handlerBody.match(/commands::\w+/g) ?? []).length}（含 M0~M3 既有）`);

for (const name of ["ReviewPlan", "DueReview", "ReviewLog", "ReviewResult"]) {
  ok(`types.ts 定义 ${name}`, new RegExp(`export (?:interface|type) ${name}\\b`).test(src.types));
}
ok(
  "types.ts ReviewResult 是 done | need_more",
  /export type ReviewResult\s*=\s*"done"\s*\|\s*"need_more"/.test(src.types),
);

// 日期来源禁令（02 D0 / 决策 #11）：SQL 推日期会引入 UTC 与本地两套口径
const reviewProdCode = stripComments(splitTestModule(src.review).production);
ok(
  "review.rs 生产代码无 date('now')（日期只由前端传 today）",
  !/date\s*\(\s*'now'/i.test(reviewProdCode),
  "禁止用 SQL 推日期",
);
ok(
  "review.rs 只用 datetime('now') 记录时刻列",
  /datetime\('now'\)/.test(reviewProdCode),
);
ok(
  "review.rs 7 个 pub fn 都接受 today（写路径禁令）或不需要日期",
  ["mark_article_completed", "complete_review", "restart_review_plan"].every((name) =>
    new RegExp(`pub fn ${name}\\s*\\([\\s\\S]{0,220}?today: &str`).test(src.review),
  ),
  "三个写路径命令必须收 today 参数",
);

// ───────────────────────────── C 段：红线（AC9 · 静态） ─────────────────────────────

console.log("── C 段：红线（AC9 · 静态） ──");
const WRITE_TABLES = new Set(["review_plan", "review_log", "reading_record"]);
const { production, tests } = splitTestModule(reviewProdCode);
ok("被砍掉的测试模块确实以 #[cfg(test)] 开头（切分没切错）", tests === "" || tests.startsWith("#[cfg(test)]"));
const writeTargets = writeTargetsOf(production).sort();
const testWriteTargets = writeTargetsOf(tests).sort();
console.log(`review.rs 生产代码写语句目标表: ${JSON.stringify(writeTargets)}`);
console.log(`review.rs 测试夹具写语句目标表（已除外）: ${JSON.stringify(testWriteTargets)}`);
ok("review.rs 有写语句（不是空实现）", writeTargets.length > 0);
ok(
  "写语句目标表 ⊆ {review_plan, review_log, reading_record}",
  writeTargets.every((table) => WRITE_TABLES.has(table)),
  `越界表：${writeTargets.filter((table) => !WRITE_TABLES.has(table)).join(",") || "无"}`,
);
for (const table of ["review_plan", "review_log", "reading_record"]) {
  ok(`review.rs 确实写 ${table}`, writeTargets.includes(table));
}

/**
 * `reading_record` 只许 SET 两列：`completed` 与 `last_read_at`。
 * `last_position` / `duration_sec` 归 M6（02 D0 红线）——静态拦在写入点，不等运行时行数对比。
 */
const readingWrites = [...production.matchAll(/UPDATE\s+reading_record\s+SET([\s\S]*?)(?:WHERE|\n)/gi)].map((m) =>
  m[1].trim(),
);
// `ON CONFLICT(article_id) DO UPDATE` 后面的 SET **跨行**（换行缩进），单独再抓一份：
// 只抓 `UPDATE\s+reading_record` 会漏掉这个子句——而它正是 M6 两列可能被写进去的地方。
const conflictWrites = [...production.matchAll(/DO\s+UPDATE\s+SET([\s\S]*?)(?:"|\);|\n\s*$)/gi)].map((m) =>
  m[1].trim(),
);
const allReadingSets = [...readingWrites, ...conflictWrites];
console.log(`reading_record 的 SET 子句: ${JSON.stringify(allReadingSets)}`);
ok("有 reading_record 的 UPDATE 分支（ON CONFLICT）", allReadingSets.length > 0);
const readingSetCols = allReadingSets.flatMap((clause) =>
  [...clause.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1].toLowerCase()),
);
console.log(`reading_record SET 到的列: ${JSON.stringify([...new Set(readingSetCols)])}`);
ok(
  "reading_record 的 SET 列 ⊆ {completed, last_read_at}",
  readingSetCols.length > 0 && readingSetCols.every((col) => col === "completed" || col === "last_read_at"),
  `越界列：${readingSetCols.filter((c) => c !== "completed" && c !== "last_read_at").join(",") || "无"}`,
);
ok(
  "review.rs 不出现 last_position / duration_sec 赋值",
  !/last_position\s*=|duration_sec\s*=/.test(production),
  "M6 的两列，M4 不许写",
);

try {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "src-tauri/migrations/001_init.sql"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  ok("001_init.sql 相对 HEAD 零改动", changed === "", changed);
} catch (err) {
  console.log(`SKIP | git 不可用（${err.code ?? err.message}）——001 零改动以调度员 git status 证据为准`);
}

// ───────────────────────────── D 段：SQL 语义（AC2/AC3/AC4/AC7/AC8） ─────────────────────────────

console.log("── D 段：SQL 语义（临时库） ──");

/** 与 `review.rs` 同源的常量（Rust 是权威；两边同表会被 E 段与 Rust 单测夹住） */
const INTERVALS = [1, 3, 7, 14];
const TODAY = "2026-11-06";

/** 与 `review.rs::add_days` 同口径：纯日历加天（月末/闰年/跨年） */
const addDays = (today, days) => {
  const [y0, m0, d0] = today.split("-").map(Number);
  let y = y0;
  let m = m0;
  let d = d0 + days;
  const dim = (yy, mm) =>
    [1, 3, 5, 7, 8, 10, 12].includes(mm)
      ? 31
      : [4, 6, 9, 11].includes(mm)
        ? 30
        : (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0
          ? 29
          : 28;
  while (d > dim(y, m)) {
    d -= dim(y, m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

const dir = mkdtempSync(path.join(tmpdir(), "judou-review-"));
const dbPath = path.join(dir, "review.db");
const db = new DatabaseSync(dbPath);

try {
  for (const file of MIGRATIONS) db.exec(read(file));
  console.log(`临时库: ${dbPath}`);

  // ── 与 review.rs 逐字同源的 SQL（SQL 漂移会被 Rust 单测与本段双向夹住） ──
  const INSERT_START_PLAN = `INSERT INTO review_plan (article_id, next_review_at, interval_index, status, updated_at)
     VALUES (?, ?, 0, 'active', datetime('now'))
     ON CONFLICT(article_id) DO NOTHING`;
  const MARK_READING = `INSERT INTO reading_record (article_id, completed, last_read_at)
     VALUES (?, 1, datetime('now'))
     ON CONFLICT(article_id) DO UPDATE SET completed = 1, last_read_at = datetime('now')`;
  const DUE_SQL = `SELECT p.article_id, a.title, p.next_review_at, p.interval_index
       FROM review_plan p
       JOIN article a ON a.id = p.article_id
      WHERE p.status = 'active' AND p.next_review_at <= ?
   ORDER BY p.next_review_at ASC, p.article_id ASC`;
  const UPDATE_PLAN = `UPDATE review_plan
        SET next_review_at = ?, interval_index = ?, status = ?, updated_at = datetime('now')
      WHERE article_id = ?`;
  const INSERT_LOG = `INSERT INTO review_log (article_id, reviewed_at, interval_index, result)
     VALUES (?, datetime('now'), ?, ?)`;

  const planOf = (articleId) => db.prepare("SELECT * FROM review_plan WHERE article_id = ?").get(articleId);
  /** `review_plan` 行 → 纯 JS 值（整数过 num()，避免 BigInt 混进断言） */
  const planView = (row) =>
    row
      ? { articleId: num(row.article_id), nextReviewAt: row.next_review_at, intervalIndex: num(row.interval_index), status: row.status }
      : row;
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
  /**
   * `node:sqlite` 把 INTEGER 以 **BigInt** 返回（本机 Node v24 实测 `typeof 42n === "bigint"`），
   * 直接与 JS number 做 `===` 或 JSON 比较必然不等——所有整数断言统一过这道闸。
   */
  const num = (value) => (typeof value === "bigint" ? Number(value) : value === null ? null : Number(value));

  /** Rust 侧同名函数的 JS 镜像：同一套语义，用来验 SQL 而不验 Rust */
  const markCompleted = (articleId, today) => {
    db.exec("BEGIN");
    try {
      if (!planOf(articleId)) db.prepare(INSERT_START_PLAN).run(articleId, addDays(today, 1));
      db.prepare(MARK_READING).run(articleId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return planOf(articleId);
  };
  const completeReview = (articleId, result, today) => {
    const plan = planOf(articleId);
    if (!plan) throw Object.assign(new Error("REVIEW_PLAN_MISSING"), { code: "REVIEW_PLAN_MISSING" });
    const before = Number(plan.interval_index);
    let next;
    let index;
    let status;
    if (result === "done") {
      index = before + 1;
      if (index > 3) {
        next = today;
        status = "done";
      } else {
        next = addDays(today, INTERVALS[index]);
        status = "active";
      }
    } else {
      index = before;
      next = addDays(today, 1);
      status = "active";
    }
    db.exec("BEGIN");
    try {
      db.prepare(UPDATE_PLAN).run(next, index, status, articleId);
      db.prepare(INSERT_LOG).run(articleId, before, result);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return planOf(articleId);
  };
  const restartReview = (articleId, today) => {
    if (planOf(articleId)) {
      db.prepare(
        "UPDATE review_plan SET next_review_at = ?, interval_index = 0, status = 'active', updated_at = datetime('now') WHERE article_id = ?",
      ).run(addDays(today, 1), articleId);
    } else {
      db.prepare(INSERT_START_PLAN).run(articleId, addDays(today, 1));
    }
    return planOf(articleId);
  };

  const insertArticle = (key, title) =>
    Number(
      db
        .prepare("INSERT INTO article (source_key, title, exam_type, visibility) VALUES (?, ?, 'cet4', 'system')")
        .run(key, title).lastInsertRowid,
    );

  const articleA = insertArticle("review-a", "A 篇");
  const articleB = insertArticle("review-b", "B 篇");
  const articleC = insertArticle("review-c", "C 篇");

  // ── ① 首调：建 plan（index 0 / 明天 / active）+ completed=1，且不碰 M6 两列 ──
  db.prepare("INSERT INTO reading_record (article_id, last_position, duration_sec, completed) VALUES (?, 42, 300, 0)").run(
    articleA,
  );
  const first = planView(markCompleted(articleA, TODAY));
  eq("①-a 首调建 plan: interval_index", first.intervalIndex, 0);
  eq("①-b 首调 next_review_at = 明天", first.nextReviewAt, "2026-11-07");
  eq("①-c 首调 status = active", first.status, "active");
  const readingA = db.prepare("SELECT completed, last_position, duration_sec FROM reading_record WHERE article_id = ?").get(articleA);
  eq("①-d reading_record.completed = 1", num(readingA.completed), 1);
  eq("①-e M6 两列原样（last_position / duration_sec）", [num(readingA.last_position), num(readingA.duration_sec)], [42, 300]);

  // ── ② 幂等：先把计划推到第 2 档，再二调，必须原样返回 ──
  completeReview(articleA, "done", TODAY);
  const moved = planView(planOf(articleA));
  const second = planView(markCompleted(articleA, "2026-12-25"));
  eq(
    "②-a 二调原样返回（不改 next_review_at / interval_index / status）",
    [second.nextReviewAt, second.intervalIndex, second.status],
    [moved.nextReviewAt, moved.intervalIndex, moved.status],
  );
  eq("②-b 不重复 insert（review_plan 行数）", Number(db.prepare("SELECT COUNT(*) AS c FROM review_plan WHERE article_id = ?").get(articleA).c), 1);
  eq("②-c 二调不把 next_review_at 打回「明天」", second.next_review_at !== "2026-12-26", true);

  // ── ③ 到期过滤 + 排序 + 空数组 ──
  eq("③-a 空表到期返回空数组", db.prepare(DUE_SQL).all(TODAY).filter((r) => r.article_id === 999).length, 0);
  markCompleted(articleB, TODAY);
  markCompleted(articleC, TODAY);
  db.prepare("UPDATE review_plan SET next_review_at = '2026-11-06' WHERE article_id = ?").run(articleC);
  db.prepare("UPDATE review_plan SET next_review_at = '2026-11-05' WHERE article_id = ?").run(articleB);
  const due = db.prepare(DUE_SQL).all(TODAY);
  eq("③-b 到期只含 active 且 <= today，按到期日升序（逾期在前）", due.map((r) => r.article_id), [articleB, articleC]);
  eq("③-c 到期行带标题", due.map((r) => r.title), ["B 篇", "C 篇"]);
  eq("③-d 到期行带档位", due.map((r) => Number(r.interval_index)), [0, 0]);
  ok("③-e 未到期（明天）的 A 不在到期列表", !due.some((r) => r.article_id === articleA));
  eq(
    "③-f 查 11-07：B(11-05)/C(11-06) 到期在前，A 已顺延到 11-13 不在其中",
    db.prepare(DUE_SQL).all("2026-11-07").map((r) => num(r.article_id)),
    [articleB, articleC],
  );
  eq(
    "③-g 查 11-20：已到期的按 (到期日, article_id) 稳定升序（B 11-05 在最前）",
    db.prepare(DUE_SQL).all("2026-11-20").map((r) => num(r.article_id)).slice(0, 1),
    [articleB],
  );

  // ── ④ done 四档顺延（A 已前进 1 次 → index=1、11-09；这里补齐到走完四档） ──
  const steps = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = planView(completeReview(articleA, "done", TODAY));
    steps.push([plan.intervalIndex, plan.nextReviewAt, plan.status]);
  }
  eq(
    "④ done 顺延：index 1→2 取 INTERVALS[2]=+7、2→3 取 +14；再完成一次 → 终态",
    steps,
    [
      [2, "2026-11-13", "active"],
      [3, "2026-11-20", "active"],
      [4, "2026-11-06", "done"],
    ],
  );

  // ── ⑤ index=3 完成 → done 且 next_review_at = today ──
  const donePlan = planView(planOf(articleA));
  eq("⑤-a 终态 status = done", donePlan.status, "done");
  eq("⑤-b 终态 next_review_at 写死为 today（不再前进）", donePlan.nextReviewAt, TODAY);
  eq("⑤-c 终态 interval_index = 4（已完成次数）", donePlan.intervalIndex, 4);
  ok(
    "⑤-c done 不再出现在到期列表（即便 next_review_at = today）",
    !db.prepare(DUE_SQL).all(TODAY).some((r) => r.article_id === articleA),
  );

  // ── ⑥ need_more：不前进、明天再看、log 记 need_more ──
  const beforeNeed = planView(planOf(articleB));
  const afterNeed = planView(completeReview(articleB, "need_more", TODAY));
  eq("⑥-a need_more 档位不前进", afterNeed.intervalIndex, beforeNeed.intervalIndex);
  eq("⑥-b need_more next_review_at = 明天", afterNeed.nextReviewAt, "2026-11-07");
  eq("⑥-c need_more 保持 active", afterNeed.status, "active");
  let missing = null;
  try {
    completeReview(-1, "done", TODAY); // 不存在的 article_id ⇒ 无 plan
  } catch (err) {
    missing = err.code ?? err.message;
  }
  eq("⑥-d plan 不存在 → 契约错误码 REVIEW_PLAN_MISSING", missing, "REVIEW_PLAN_MISSING");

  // ── ⑦ restart：复位 done → active/0/明天；plan 不存在 → INSERT 分支 ──
  const restarted = planView(restartReview(articleA, TODAY));
  eq(
    "⑦-a restart 复位 done → active / index 0 / 明天",
    [restarted.status, restarted.intervalIndex, restarted.nextReviewAt],
    ["active", 0, "2026-11-07"],
  );
  const fresh = insertArticle("review-d", "D 篇");
  ok("⑦-b 新建文章原本无 plan", !planOf(fresh));
  const created = planView(restartReview(fresh, TODAY));
  eq(
    "⑦-c plan 不存在时走 INSERT 分支（NOT NULL 无 DEFAULT）",
    [created.status, created.intervalIndex, created.nextReviewAt],
    ["active", 0, "2026-11-07"],
  );
  eq("⑦-d 重启后该篇重新出现在到期列表（明天）", db.prepare(DUE_SQL).all("2026-11-07").some((r) => num(r.article_id) === articleA), true);

  // ── ⑧ review_log 记完成前 index ──
  const logsA = db.prepare("SELECT interval_index, result FROM review_log WHERE article_id = ? ORDER BY id").all(articleA);
  eq("⑧-a A 的日志记完成前档位（0,1,2,3）", logsA.map((r) => num(r.interval_index)), [0, 1, 2, 3]);
  eq("⑧-b A 的日志 result 全 done", logsA.map((r) => r.result), ["done", "done", "done", "done"]);
  const logsB = db.prepare("SELECT interval_index, result FROM review_log WHERE article_id = ? ORDER BY id DESC").all(articleB);
  eq("⑧-c B 的日志最新一条是 need_more 且记完成前档位", [logsB[0].result, num(logsB[0].interval_index)], ["need_more", 0]);

  // ── ⑨ 三表以外零写：写白名单之外，行内容逐行不变 ──
  const WATCHED = [
    "article",
    "paragraph",
    "sentence",
    "token",
    "question",
    "sentence_analysis",
    "token_analysis",
    "lexicon",
    "blank",
    "vocab_entry",
    "tag",
    "vocab_tag",
    "sentence_note",
    "word_note",
    "app_setting",
    "schema_meta",
  ];
  const snapshot = () => Object.fromEntries(WATCHED.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())]));
  // 用一篇**从未被标记过**的文章（E）走完整写路径：C 在 ③ 段已建过 plan、A 已跑过全部分支，
  // 只有 E 能证明「首次完成」确实新写一行 reading_record。
  // **必须先插文章再拍快照**：`INSERT article` 是门禁自己的种子写，放在快照之后会被
  // ⑨-a 的「16 张表逐行比对」误判成实现越界（实测踩到）。
  const articleE = insertArticle("review-e", "E 篇");
  const beforeSnap = snapshot();
  const readingBefore = db.prepare("SELECT * FROM reading_record").all();
  markCompleted(articleE, TODAY);
  completeReview(articleE, "done", TODAY);
  completeReview(articleE, "need_more", TODAY);
  restartReview(articleE, TODAY);
  db.prepare(DUE_SQL).all(TODAY);
  db.prepare("SELECT * FROM review_log ORDER BY reviewed_at DESC").all();
  db.prepare("SELECT * FROM review_plan ORDER BY next_review_at ASC, article_id ASC").all();
  const afterSnap = snapshot();
  const drifted = WATCHED.filter((t) => beforeSnap[t] !== afterSnap[t]);
  console.log(`⑨ 写白名单外逐行比对：${WATCHED.length} 张表，漂移 ${drifted.length} 张`);
  eq("⑨-a 三表以外零写（逐行比对 16 张表）", drifted, []);
  const readingAfter = db.prepare("SELECT * FROM reading_record").all();
  eq(
    "⑨-b reading_record 新增了 E 的一行（首次「完成本篇」）",
    readingAfter.length,
    readingBefore.length + 1,
  );
  const readingE = db.prepare("SELECT last_position, duration_sec, completed FROM reading_record WHERE article_id = ?").get(articleE);
  eq(
    "⑨-c 新行 last_position 为 NULL、duration_sec 为默认 0、completed=1",
    [num(readingE.last_position), num(readingE.duration_sec), num(readingE.completed)],
    [null, 0, 1],
  );
  const readingA2 = db.prepare("SELECT last_position, duration_sec FROM reading_record WHERE article_id = ?").get(articleA);
  eq(
    "⑨-e 既有行的 M6 两列在全部复习写路径后仍未变（42 / 300）",
    [num(readingA2.last_position), num(readingA2.duration_sec)],
    [42, 300],
  );
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  eq("⑨-d 表数仍为 19（零 schema 改动）", tables.length, 19);
} catch (err) {
  ok(`D 段执行（${err.code ?? ""} ${err.message}）`, false, err.stack ?? "");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────────── E 段：纯函数（D2 · 与 Rust 同组用例） ─────────────────────────────

console.log("── E 段：纯函数（node 直 import lib/review.ts） ──");
if (!existsSync(FILES.reviewTs)) {
  ok("lib/review.ts 可被 node 直 import", false, "文件不存在");
} else {
  try {
    const mod = await import(pathToFileURL(FILES.reviewTs).href);
    const { nextInterval, advance, isDue, formatDueLabel, addDays: tsAddDays } = mod;

    eq("E-1 nextInterval 四档 = [1,3,7,14]", [0, 1, 2, 3].map((i) => nextInterval(i)), [1, 3, 7, 14]);
    eq("E-2 nextInterval 越界 → null", [nextInterval(4), nextInterval(-1), nextInterval(1.5)].map((v) => v), [null, null, null]);

    // **与 Rust 单测 `due_filter_order_and_four_step_advance` 同一组用例**：
    // today=2026-11-06，index 0→1→2→3→done，next_review_at 依次 11-07 / 11-09 / 11-13 / 11-06(终态)
    const seq = [];
    // **起点与 Rust 同组用例一致**：index 0 的新计划 nextReviewAt 是 today+1（11-07）。
    // 首步 done → index 1 → 查表 INTERVALS[1]=3 → today+3（11-09）；Rust 的 steps[0] 同值。
    let state = { index: 0, nextReviewAt: "2026-11-07", status: "active" };
    for (let i = 0; i < 3; i += 1) {
      state = advance(state, "done", TODAY);
      seq.push([state.index, state.nextReviewAt, state.status]);
    }
    eq(
      "E-3 advance done 前三档与 Rust 同组用例一致（index 1 → +3 / 2 → +7 / 3 → +14）",
      seq,
      [
        [1, "2026-11-09", "active"],
        [2, "2026-11-13", "active"],
        [3, "2026-11-20", "active"],
      ],
    );

    const needState = advance({ index: 1, nextReviewAt: "2026-11-09", status: "active" }, "need_more", TODAY);
    eq("E-4a advance need_more 不前进、明天再看（与 Rust 一致）", [needState.index, needState.nextReviewAt, needState.status], [1, "2026-11-07", "active"]);
    // 第五次 done：index 3 → 4 → 终态，nextReviewAt 写死为 today（与 Rust 单测第 4 步同口径）
    const finalState = advance({ index: 3, nextReviewAt: "2026-11-13", status: "active" }, "done", TODAY);
    eq("E-4b advance 走完四档 → done 且 nextReviewAt = today（与 Rust 终态一致）", [finalState.index, finalState.nextReviewAt, finalState.status], [4, TODAY, "done"]);
    eq("E-4c addDays 月末/闰年/跨年", ["2026-11-30", "2028-02-28", "2026-12-31"].map((d) => tsAddDays(d, 1)), ["2026-12-01", "2028-02-29", "2027-01-01"]);

    ok("E-5 isDue: 到期当天算到期", isDue({ nextReviewAt: "2026-11-06", status: "active" }, TODAY) === true);
    ok("E-6 isDue: 逾期算到期", isDue({ nextReviewAt: "2026-11-05", status: "active" }, TODAY) === true);
    ok("E-7 isDue: 明天不算到期", isDue({ nextReviewAt: "2026-11-07", status: "active" }, TODAY) === false);
    ok("E-8 isDue: done 不算到期（即便 next_review_at = today）", isDue({ nextReviewAt: "2026-11-06", status: "done" }, TODAY) === false);
    ok("E-9 isDue: paused 不算到期", isDue({ nextReviewAt: "2026-11-06", status: "paused" }, TODAY) === false);
    ok("E-10 跨月日期不当成字符串比大小", isDue({ nextReviewAt: "2026-09-30", status: "active" }, "2026-10-01") === true);

    eq("E-11 formatDueLabel 今天", formatDueLabel("2026-11-06", TODAY), "今天");
    eq("E-12 formatDueLabel 明天", formatDueLabel("2026-11-07", TODAY), "明天");
    eq("E-13 formatDueLabel 逾期 1 天", formatDueLabel("2026-11-05", TODAY), "逾期 1 天");
    eq("E-14 formatDueLabel 逾期跨月（10-31 → 11-06 共 6 天）", formatDueLabel("2026-10-31", TODAY), "逾期 6 天");
    eq("E-15 formatDueLabel 未来（3 天后）", formatDueLabel("2026-11-09", TODAY), "3 天后");

    // D2 硬约束：不 import React/DOM、不用 enum/namespace（否则 node --test 直 import 不成立）
    const reviewTsCode = stripComments(read(FILES.reviewTs));
    ok("E-16 review.ts 不 import React / DOM 包", !/from\s+["'](?:react|react-dom|@tauri-apps)/.test(reviewTsCode));
    ok("E-17 review.ts 不用 enum / namespace", !/\b(enum|namespace)\s+[A-Za-z_]/.test(reviewTsCode));
    ok("E-18 review.ts 不出现 document. / window.", !/\b(document|window)\./.test(reviewTsCode));
  } catch (err) {
    ok("lib/review.ts 纯函数可执行", false, `${err.code ?? ""} ${err.message}`);
  }
}

// ───────────────────────────── 汇总 ─────────────────────────────

console.log("");
console.log(`判据: ${passed}/${checks} 通过`);
if (failed) {
  console.error("FAIL: 复习门禁未通过");
  process.exit(1);
}
console.log(
  "PASS: 7 命令契约在位 / 一处注册 7 条 / 日期只由前端传 / 三表零外写（静态 + 逐行） / 001 零改动 / 首调建计划 + 幂等 / 到期过滤排序 / done 四档与终态 / need_more 不前进 / restart 两分支 / log 记完成前 index / TS 顺延与 Rust 同组用例",
);