// M11 摘钩子 · 第二轮（修正 lib.rs 锚点；已应用项跳过）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:/Judou/code";
const log = [];
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
function write(rel, text) {
  writeFileSync(join(ROOT, rel), text.replace(/\r\n/g, "\n"), "utf8");
  log.push(`W ${rel}`);
}
function rep(src, from, to, label) {
  if (!src.includes(from)) {
    log.push(`SKIP ${label}`);
    return src;
  }
  log.push(`OK   ${label}`);
  return src.split(from).join(to);
}
function cut(src, a, b, label) {
  const i = src.indexOf(a);
  if (i < 0) {
    log.push(`SKIP ${label}`);
    return src;
  }
  const j = src.indexOf(b, i);
  if (j < 0) throw new Error(`[${label}] 结束锚点未命中`);
  log.push(`OK   ${label}`);
  return src.slice(0, i) + src.slice(j + b.length);
}
const tidy = (s) => s.replace(/\n{3,}/g, "\n\n");

// lib.rs
{
  let s = read("src-tauri/src/lib.rs");
  s = rep(s, "// M5b（02 D1/R6）：`pub` 是给门禁 bin（`src/bin/ai_import_cli.rs`）用的——它要直调库层的\n// `commit_ai_import` / `patch_ai_analysis`（SQL 只在 `ai_import.rs` 里，bin 不复制）。\npub mod ai_import;\n", "", "lib-mod-ai");
  s = rep(s, "// `pub` 是给门禁 bin（`src/bin/import_user_cli.rs`，D8 契约）用的：它要开临时库跑真事务。\n// 默认可见性不变（crate 外只有同仓的这个 bin 引用）。\n", "", "lib-bin-comment");
  s = rep(s, "pub mod import_user;\n", "", "lib-mod-user");
  s = cut(s, "            // M5 · 用户导入（2 个；实现见 import_user.rs，薄包装在 commands.rs）", "            commands::suggest_section,\n", "lib-handler");
  write("src-tauri/src/lib.rs", tidy(s));
}

// commands.rs
{
  let s = read("src-tauri/src/commands.rs");
  s = rep(s, "use crate::ai_import;\n", "", "cmd-use-ai");
  s = rep(s, "use crate::import_user;\n", "", "cmd-use-user");
  s = cut(s, "// ───────────────────────── M5 · 用户导入（D1：2 个薄包装）", "\n// ─────────────────────────── M6 · 记录 / 统计 / 导出 / 备份 ───────────────────────────", "cmd-block");
  write("src-tauri/src/commands.rs", tidy(s));
}

// records.rs
{
  let s = read("src-tauri/src/records.rs");
  s = rep(s, "    /// **用户自己导入**的篇数（`article.visibility = 'user'`）——入门任务第 ③ 项据此判定\n    pub user_article_count: i64,\n", "", "rec-field");
  s = rep(s, "        // 第五轮：入门任务第 ③ 项要「导入过自己的文章」——按 visibility 直数，不改表不加命令\n        let user_article_count: i64 = conn\n            .query_row(\"SELECT COUNT(*) FROM article WHERE visibility = 'user'\", [], |row| row.get(0))\n            .map_err(|err| CommandError::db(\"统计用户导入篇数\", err))?;\n\n", "", "rec-sql");
  s = rep(s, "            user_article_count,\n", "", "rec-ok");
  s = cut(s, "    /// 入门任务清单第 ③ 项：", "    }\n", "rec-test");
  write("src-tauri/src/records.rs", tidy(s));
}

// routes.tsx
{
  let s = read("src/shell/routes.tsx");
  s = rep(s, 'import { Import } from "../pages/Import";\n', "", "routes-import");
  s = cut(s, '    path: "#/import",', "    element: <Import />,\n  },\n", "routes-entry");
  s = rep(s, "  {\n  },\n", "", "routes-leak");
  s = rep(s, '"内置篇目与我导入的篇目，按考试类型、年份、题型筛选。"', '"12 篇内置真题，按考试类型、年份、题型筛选。"', "routes-subtitle");
  s = rep(s, "8 条路由 + 一条 `:id` 参数用 3 个函数解决", "7 条路由 + 一条 `:id` 参数用 3 个函数解决", "routes-doc");
  write("src/shell/routes.tsx", tidy(s));
}

// Sidebar.tsx
{
  let s = read("src/shell/Sidebar.tsx");
  s = rep(s, " + 7 项导航。", " + 6 项导航。", "side-doc");
  if (s.includes('    path: "#/import",')) {
    const start = s.indexOf('    path: "#/import",');
    const back = s.lastIndexOf("  {\n", start);
    const end = s.indexOf("  },\n", start);
    s = s.slice(0, back) + s.slice(end + "  },\n".length);
    log.push("OK   side-item");
  } else log.push("SKIP side-item");
  write("src/shell/Sidebar.tsx", tidy(s));
}

// Library.tsx
{
  let s = read("src/pages/Library.tsx");
  s = rep(s, 'import { ArticleEditor } from "../components/ArticleEditor";\n', "", "lib-import");
  s = rep(
    s,
    " * - 两分组：内置（`visibility='system'`）/ 我导入的（`user`）；**两种空态分开**——\n *   ① 分组里一篇都没有 → 引导「去导入」；② 有材料但筛选没命中 → 「试试放宽条件 + 清除筛选」。",
    " * - M11 起只剩内置 12 篇（用户导入已移除）：空态一态 —— 有材料但筛选没命中 → 「试试放宽条件 + 清除筛选」。",
    "lib-doc",
  );
  s = rep(s, "  /** 页面状态：与 URL query 一一对应（`vis` / `exam` / `year` / `sec` / `src` / `q`） */\ninterface LibraryState {\n  vis: string;\n", "  /** 页面状态：与 URL query 一一对应（`exam` / `year` / `sec` / `src` / `q`） */\ninterface LibraryState {\n", "lib-state");
  s = rep(s, '    vis: query.get("vis") === "user" ? "user" : "system",\n', "", "lib-fromquery");
  s = rep(s, '  query.set("vis", state.vis);\n', "", "lib-toquery");
  s = rep(s, "（顺序固定，便于断言与阅读：vis, exam, year, sec, src, q）", "（顺序固定，便于断言与阅读：exam, year, sec, src, q）", "lib-qdoc");
  s = rep(s, "    visibility: state.vis,\n", "", "lib-filter");
  s = rep(s, "  const [groupTotal, setGroupTotal] = useState(0);\n", "", "lib-grouptotal");
  s = rep(s, '  /** M5c D4/D5：正在编辑的文章（null = 面板关闭） */\n  const [editing, setEditing] = useState<ArticleSummary | null>(null);\n', "", "lib-editing");
  s = rep(
    s,
    "    Promise.all([listArticles(buildFilter(state)), listArticles({ visibility: state.vis })])\n      .then(([list, group]) => {\n        if (cancelled) return;\n        setItems(list);\n        setGroupTotal(group.length);\n        setError(null);\n      })",
    "    listArticles(buildFilter(state))\n      .then((list) => {\n        if (cancelled) return;\n        setItems(list);\n        setError(null);\n      })",
    "lib-effect",
  );
  s = rep(s, '    setState({ vis: state.vis, exams: [], years: [], sections: [], sources: [], q: "" });\n  }, [state.vis]);', '    setState({ exams: [], years: [], sections: [], sources: [], q: "" });\n  }, []);', "lib-clear");
  s = cut(s, '        <div className="tabs" role="tablist" aria-label="文章分组">', "        </div>\n\n", "lib-tabs");
  s = cut(s, "      {!loading && !error && groupTotal === 0 && (", "        </div>\n      )}\n\n", "lib-empty-group");
  s = rep(
    s,
    "      {!loading && !error && groupTotal > 0 && items.length === 0 && (",
    '      {!loading && !error && items.length === 0 && !isFiltered && (\n        <div className="empty" data-testid="library-empty-group" data-empty-articles>\n          <p>内置内容包没有可显示的文章。</p>\n        </div>\n      )}\n\n      {!loading && !error && items.length === 0 && isFiltered && (',
    "lib-empty-filter",
  );
  s = cut(s, "              {/* M5b D4：「补解析」入口（AC9）。停在卡片内部，**必须 stopPropagation**，", "              </p>\n", "lib-actions");
  s = cut(s, "      {/* M5c D5：编辑面板（元信息 + 题目）；保存后只回填列表里的标题，不重拉全表 */}", "      )}\n\n", "lib-panel");
  write("src/pages/Library.tsx", tidy(s));
}

// Reader.tsx
{
  let s = read("src/pages/Reader.tsx");
  s = rep(s, 'import { ArticleEditor } from "../components/ArticleEditor";\n', "", "rd-import");
  s = rep(s, "  const [editorOpen, setEditorOpen] = useState(false);\n", "", "rd-open");
  s = rep(s, "  const [titleOverride, setTitleOverride] = useState<string | null>(null);\n", "", "rd-title");
  s = cut(s, "          {/* M5b D4：精读页页头的「补全解析」入口（AC9）", "          </button>\n", "rd-actions");
  s = cut(s, "        {/* M5c D5：编辑面板（元信息 + 题目），保存后只覆盖标题与题目，不重拉整篇 */}", "        )}\n\n", "rd-panel");
  s = rep(s, "{titleOverride ?? detail.title}", "{detail.title}", "rd-title-use");
  write("src/pages/Reader.tsx", tidy(s));
}

// Onboarding.tsx
{
  let s = read("src/components/Onboarding.tsx");
  s = rep(s, " * ③ 导入一篇自己的文章       → `userArticleCount`（`article.visibility='user'` 行数）≥ 1\n", "", "onb-doc3");
  s = rep(s, '`data-onboarding-item="read|vocab|import"`', '`data-onboarding-item="read|vocab"`', "onb-hookdoc");
  s = rep(s, "落盘：三项全完成", "落盘：两项全完成", "onb-doc2");
  s = rep(s, 'type TaskKey = "read" | "vocab" | "import";', 'type TaskKey = "read" | "vocab";', "onb-key");
  if (s.includes('    key: "import",')) {
    const start = s.indexOf('    key: "import",');
    const back = s.lastIndexOf("  {\n", start);
    const end = s.indexOf("  },\n", start);
    s = s.slice(0, back) + s.slice(end + "  },\n".length);
    log.push("OK   onb-task3");
  } else log.push("SKIP onb-task3");
  s = rep(s, "/** 三项完成态：**只从真实数据算**，不读任何「用户上报」字段。 */", "/** 两项完成态：**只从真实数据算**，不读任何「用户上报」字段。 */", "onb-done-doc");
  s = rep(s, "  vocab: boolean;\n  import: boolean;\n}", "  vocab: boolean;\n}", "onb-donemap");
  s = rep(s, "          import: stats.userArticleCount >= 1,\n", "", "onb-load");
  s = rep(s, "done.read && done.vocab && done.import", "done.read && done.vocab", "onb-alldone");
  write("src/components/Onboarding.tsx", tidy(s));
}

// types.ts
{
  const s = read("src/lib/types.ts");
  const lines = s.split("\n");
  const startLine = lines.findIndex((l) => l.startsWith("export interface ImportPreview {"));
  if (startLine < 0) log.push("SKIP types-block");
  else {
    let from = startLine;
    while (from - 1 >= 0 && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[from - 1])) from -= 1;
    const upd = lines.findIndex((l) => l.startsWith("export interface UpdateResult {"));
    if (upd < 0) throw new Error("types-UpdateResult 未命中");
    let cutTo = upd;
    while (cutTo - 1 >= from && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[cutTo - 1])) cutTo -= 1;
    write("src/lib/types.ts", tidy([...lines.slice(0, from), ...lines.slice(cutTo)].join("\n")));
    log.push("OK   types-block");
  }
}

// api.ts
{
  let lines = read("src/lib/api.ts").split("\n");
  const names = [
    "parseImportPreview", "commitImport", "buildAiPrompt", "parseAiPayload", "matchAiPayload",
    "suggestSection", "commitAiImport", "patchAiAnalysis", "getAiImportStats", "splitUserInput",
    "splitPassages", "updateArticleMeta", "getArticleQuestions", "replaceArticleQuestions",
  ];
  for (const name of names) {
    const i = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
    if (i < 0) {
      log.push(`SKIP api-${name}`);
      continue;
    }
    let from = i;
    while (from - 1 >= 0 && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[from - 1])) from -= 1;
    let to = i;
    while (to < lines.length && lines[to] !== "}") to += 1;
    lines = [...lines.slice(0, from), ...lines.slice(to + 1)];
    log.push(`OK   api-${name}`);
  }
  write("src/lib/api.ts", tidy(lines.join("\n")));
}

// verify-records.mjs：③ 断言反向
{
  let s = read("scripts/verify-records.mjs");
  s = rep(
    s,
    "  // ③ 必须有 visibility='user' 的计数（复用既有统计命令，不新增命令）\n  assert(/SELECT COUNT\\(\\*\\) FROM article WHERE visibility = 'user'/.test(records), \"get_stats 缺 visibility='user' 计数 SQL\");\n  assert(/user_article_count/.test(records), \"StatsView 缺 user_article_count 字段\");\n  assert(/userArticleCount: number/.test(types), \"types.ts 缺 userArticleCount\");",
    "  // M11 AC5：visibility='user' 代码分支已移除（字段保留、取值恒为 system）——反向把关防回潮\n  assert(!/visibility = 'user'/.test(records), \"records.rs 仍残留 visibility='user' 分支（M11 AC5 要求移除）\");\n  assert(!/user_article_count/.test(records), \"records.rs 仍残留 user_article_count（M11 AC5 要求移除）\");\n  assert(!/userArticleCount/.test(types), \"types.ts 仍残留 userArticleCount（M11 AC5 要求移除）\");",
    "vr-sql",
  );
  s = rep(
    s,
    '  assert(/import: stats\\.userArticleCount >= 1/.test(onboarding), "③ 必须按 visibility=\'user\' 篇数判定");',
    '  assert(!/userArticleCount/.test(onboarding), "Onboarding 仍引用 userArticleCount（M11 AC5 要求移除）");',
    "vr-onb",
  );
  s = rep(s, 'check("ONB-1 三项判定口径', 'check("ONB-1 两项判定口径', "vr-title");
  s = rep(s, 'return "三项与 SQL 对齐";', 'return "两项与 SQL 对齐";', "vr-ret");
  write("scripts/verify-records.mjs", s);
}

console.log(log.join("\n"));
