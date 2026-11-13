// M11 移除导入：原子化摘钩子脚本（一次性；可再生，不入库）
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:/Judou/code";
const log = [];

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
function write(rel, text) {
  writeFileSync(join(ROOT, rel), text.replace(/\r\n/g, "\n"), "utf8");
  log.push(`W ${rel}`);
}
function must(src, anchor, label) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`[${label}] 锚点未命中：${anchor.slice(0, 60)}`);
  return i;
}
/** 删除 src[startAnchor .. endAnchor+len]，返回新串 */
function cut(src, startAnchor, endAnchor, label) {
  const a = must(src, startAnchor, label + "-start");
  const b = src.indexOf(endAnchor, a);
  if (b < 0) throw new Error(`[${label}] 结束锚点未命中：${endAnchor.slice(0, 60)}`);
  return src.slice(0, a) + src.slice(b + endAnchor.length);
}
function rep(src, from, to, label) {
  must(src, from, label);
  return src.split(from).join(to);
}
function tidy(src) {
  return src.replace(/\n{3,}/g, "\n\n");
}

// ── 0. 物理删除（6 文件 + 3 脚本 + 39 fixture）──
const files = [
  "src-tauri/src/ai_import.rs",
  "src-tauri/src/import_user.rs",
  "src-tauri/src/bin/ai_import_cli.rs",
  "src-tauri/src/bin/import_user_cli.rs",
  "src/pages/Import.tsx",
  "src/components/ArticleEditor.tsx",
  "scripts/verify-ai-import.mjs",
  "scripts/verify-import-user.mjs",
  "scripts/verify-import.mjs",
];
for (const f of files) {
  const p = join(ROOT, f);
  if (!existsSync(p)) throw new Error(`应存在却缺失：${f}`);
  rmSync(p);
  log.push(`D ${f}`);
}
for (const d of ["scripts/fixtures/ai-import", "scripts/fixtures/ai-import-full"]) {
  const p = join(ROOT, d);
  if (!existsSync(p)) throw new Error(`应存在却缺失：${d}`);
  rmSync(p, { recursive: true, force: true });
  log.push(`D ${d}/`);
}

// ── 1. package.json：移除 3 个 script ──
{
  let s = read("package.json");
  s = rep(s, '    "verify:import": "node scripts/verify-import.mjs",\n', "", "pkg-import");
  s = rep(s, '    "verify:import-user": "node scripts/verify-import-user.mjs",\n', "", "pkg-import-user");
  s = rep(s, '    "verify:ai-import": "node scripts/verify-ai-import.mjs",\n', "", "pkg-ai");
  write("package.json", s);
}

// ── 2. Cargo.toml：删两个 [[bin]] 段（文件尾部）──
{
  let s = read("src-tauri/Cargo.toml");
  const i = must(s, "\n# M5 D8 门禁契约", "cargo-bin");
  s = s.slice(0, i).replace(/\s+$/, "\n");
  write("src-tauri/Cargo.toml", s);
}

// ── 3. lib.rs ──
{
  let s = read("src-tauri/src/lib.rs");
  s = rep(
    s,
    "// M5b（02 D1/R6）：`pub` 是给门禁 bin（`src/bin/ai_import_cli.rs`）用的——它要直调库层的\n// `commit_ai_import` / `patch_ai_analysis`（SQL 只在 `ai_import.rs` 里，bin 不复制）。\npub mod ai_import;\n",
    "",
    "lib-mod-ai",
  );
  s = rep(
    s,
    "// `pub` 是给门禁 bin（`src/bin/import_user_cli.rs`，D8 契约）用的：它要开临时库跑真事务。\n// 默认可见性不变（crate 外只有同仓的这个 bin 引用）。\npub mod import_user;\n",
    "",
    "lib-mod-user",
  );
  s = cut(
    s,
    "            // M5 · 用户导入（2 个；实现见 import_user.rs，薄包装在 commands.rs）",
    "            commands::suggest_section,\n",
    "lib-handler",
  );
  write("src-tauri/src/lib.rs", tidy(s));
}

// ── 4. commands.rs ──
{
  let s = read("src-tauri/src/commands.rs");
  s = rep(s, "use crate::ai_import;\n", "", "cmd-use-ai");
  s = rep(s, "use crate::import_user;\n", "", "cmd-use-user");
  s = cut(
    s,
    "// ───────────────────────── M5 · 用户导入（D1：2 个薄包装）",
    "// ─────────────────────────── M6 · 记录 / 统计 / 导出 / 备份 ───────────────────────────",
    "cmd-block",
  );
  s = rep(
    s,
    "// ─────────────────────────── M6 · 记录 / 统计 / 导出 / 备份 ───────────────────────────",
    "// ─────────────────────────── M6 · 记录 / 统计 / 导出 / 备份 ───────────────────────────",
    "cmd-m6-banner",
  );
  write("src-tauri/src/commands.rs", tidy(s));
}

// ── 5. records.rs：删 user_article_count 字段/SQL/单测 ──
{
  let s = read("src-tauri/src/records.rs");
  s = rep(
    s,
    "    /// **用户自己导入**的篇数（`article.visibility = 'user'`）——入门任务第 ③ 项据此判定\n    pub user_article_count: i64,\n",
    "",
    "rec-field",
  );
  s = rep(
    s,
    "        // 第五轮：入门任务第 ③ 项要「导入过自己的文章」——按 visibility 直数，不改表不加命令\n        let user_article_count: i64 = conn\n            .query_row(\"SELECT COUNT(*) FROM article WHERE visibility = 'user'\", [], |row| row.get(0))\n            .map_err(|err| CommandError::db(\"统计用户导入篇数\", err))?;\n\n",
    "",
    "rec-sql",
  );
  s = rep(s, "            user_article_count,\n", "", "rec-ok");
  s = cut(s, "    /// 入门任务清单第 ③ 项：", "    }\n", "rec-test");
  write("src-tauri/src/records.rs", tidy(s));
}

// ── 6. routes.tsx ──
{
  let s = read("src/shell/routes.tsx");
  s = rep(s, 'import { Import } from "../pages/Import";\n', "", "routes-import");
  s = cut(s, '    path: "#/import",', "    element: <Import />,\n  },\n", "routes-entry");
  s = rep(s, "  {\n  },\n", "", "routes-leak");
  s = rep(
    s,
    '"内置篇目与我导入的篇目，按考试类型、年份、题型筛选。"',
    '"12 篇内置真题，按考试类型、年份、题型筛选。"',
    "routes-subtitle",
  );
  s = rep(s, "8 条路由 + 一条 `:id` 参数用 3 个函数解决", "7 条路由 + 一条 `:id` 参数用 3 个函数解决", "routes-doc");
  write("src/shell/routes.tsx", tidy(s));
}

// ── 7. Sidebar.tsx：7 → 6 ──
{
  let s = read("src/shell/Sidebar.tsx");
  s = rep(s, " + 7 项导航。", " + 6 项导航。", "side-doc");
  const start = must(s, '    path: "#/import",', "side-item");
  const back = s.lastIndexOf("  {\n", start);
  const end = s.indexOf("  },\n", start);
  if (back < 0 || end < 0) throw new Error("side-item 边界未命中");
  s = s.slice(0, back) + s.slice(end + "  },\n".length);
  write("src/shell/Sidebar.tsx", tidy(s));
}

// ── 8. Library.tsx ──
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
  s = rep(s, "  query.set(\"vis\", state.vis);\n", "", "lib-toquery");
  s = rep(s, "（顺序固定，便于断言与阅读：vis, exam, year, sec, src, q）", "（顺序固定，便于断言与阅读：exam, year, sec, src, q）", "lib-qdoc");
  s = rep(s, "    visibility: state.vis,\n", "", "lib-filter");
  s = rep(s, "  const [groupTotal, setGroupTotal] = useState(0);\n", "", "lib-grouptotal");
  s = rep(
    s,
    '  /** M5c D4/D5：正在编辑的文章（null = 面板关闭） */\n  const [editing, setEditing] = useState<ArticleSummary | null>(null);\n',
    "",
    "lib-editing",
  );
  s = rep(
    s,
    "    Promise.all([listArticles(buildFilter(state)), listArticles({ visibility: state.vis })])\n      .then(([list, group]) => {\n        if (cancelled) return;\n        setItems(list);\n        setGroupTotal(group.length);\n        setError(null);\n      })",
    "    listArticles(buildFilter(state))\n      .then((list) => {\n        if (cancelled) return;\n        setItems(list);\n        setError(null);\n      })",
    "lib-effect",
  );
  s = rep(
    s,
    '    setState({ vis: state.vis, exams: [], years: [], sections: [], sources: [], q: "" });\n  }, [state.vis]);',
    '    setState({ exams: [], years: [], sections: [], sources: [], q: "" });\n  }, []);',
    "lib-clear",
  );
  s = cut(s, '        <div className="tabs" role="tablist" aria-label="文章分组">', "        </div>\n\n", "lib-tabs");
  s = cut(s, "      {!loading && !error && groupTotal === 0 && (", "      <p>没有符合当前筛选的文章，试试放宽条件。</p>", "lib-empty-group");
  s = rep(
    s,
    "      <p>没有符合当前筛选的文章，试试放宽条件。</p>",
    '      {!loading && !error && items.length === 0 && (\n        <div className="empty" data-testid="library-empty-group" data-empty-articles>\n          <p>内置内容包没有可显示的文章。</p>\n        </div>\n      )}\n\n      {!loading && !error && items.length > 0 && isFiltered === false && items.length === 0 && (\n      <p>没有符合当前筛选的文章，试试放宽条件。</p>',
    "lib-empty-restore",
  );
  write("src/pages/Library.tsx", tidy(s));
}

// ── 9. Reader.tsx ──
{
  let s = read("src/pages/Reader.tsx");
  s = rep(s, 'import { ArticleEditor } from "../components/ArticleEditor";\n', "", "rd-import");
  s = rep(s, "  const [editorOpen, setEditorOpen] = useState(false);\n", "", "rd-open");
  s = rep(s, "  const [titleOverride, setTitleOverride] = useState<string | null>(null);\n", "", "rd-title");
  s = cut(
    s,
    "          {/* M5b D4：精读页页头的「补全解析」入口（AC9）",
    "          </button>\n",
    "rd-actions",
  );
  s = cut(
    s,
    "        {/* M5c D5：编辑面板（元信息 + 题目），保存后只覆盖标题与题目，不重拉整篇 */}",
    "        )}\n\n",
    "rd-panel",
  );
  s = rep(s, "{titleOverride ?? detail.title}", "{detail.title}", "rd-title-use");
  write("src/pages/Reader.tsx", tidy(s));
}

// ── 10. Onboarding.tsx：删 ③（导入一篇自己的文章）──
{
  let s = read("src/components/Onboarding.tsx");
  s = rep(
    s,
    " * ③ 导入一篇自己的文章       → `userArticleCount`（`article.visibility='user'` 行数）≥ 1\n",
    "",
    "onb-doc3",
  );
  s = rep(s, "`data-onboarding-item=\"read|vocab|import\"`", "`data-onboarding-item=\"read|vocab\"`", "onb-hookdoc");
  s = rep(s, "落盘：三项全完成", "落盘：两项全完成", "onb-doc2");
  s = rep(s, 'type TaskKey = "read" | "vocab" | "import";', 'type TaskKey = "read" | "vocab";', "onb-key");
  s = cut(s, '    key: "import",', "    href: \"#/import\",\n  },\n", "onb-task3");
  s = rep(s, "  {\n  },\n", "", "onb-leak");
  s = rep(s, "/** 三项完成态：**只从真实数据算**，不读任何「用户上报」字段。 */", "/** 两项完成态：**只从真实数据算**，不读任何「用户上报」字段。 */", "onb-done-doc");
  s = rep(s, "  vocab: boolean;\n  import: boolean;\n}", "  vocab: boolean;\n}", "onb-donemap");
  s = rep(s, "          import: stats.userArticleCount >= 1,\n", "", "onb-load");
  s = rep(s, "done.read && done.vocab && done.import", "done.read && done.vocab", "onb-alldone");
  write("src/components/Onboarding.tsx", tidy(s));
}

// ── 11. types.ts：整段删除导入类型（ImportPreview … AiPatchReport）──
{
  const s = read("src/lib/types.ts");
  const lines = s.split("\n");
  const startLine = lines.findIndex((l) => l.startsWith("export interface ImportPreview {"));
  if (startLine < 0) throw new Error("types-ImportPreview 未命中");
  let from = startLine;
  while (from - 1 >= 0 && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[from - 1])) from -= 1;
  const upd = lines.findIndex((l) => l.startsWith("export interface UpdateResult {"));
  if (upd < 0) throw new Error("types-UpdateResult 未命中");
  let cutTo = upd;
  while (cutTo - 1 >= from && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[cutTo - 1])) cutTo -= 1;
  const kept = [...lines.slice(0, from), ...lines.slice(cutTo)];
  write("src/lib/types.ts", tidy(kept.join("\n")));
}

// ── 12. api.ts：删 14 个导入封装（含其文档注释）──
{
  let s = read("src/lib/api.ts");
  const names = [
    "parseImportPreview",
    "commitImport",
    "buildAiPrompt",
    "parseAiPayload",
    "matchAiPayload",
    "suggestSection",
    "commitAiImport",
    "patchAiAnalysis",
    "getAiImportStats",
    "splitUserInput",
    "splitPassages",
    "updateArticleMeta",
    "getArticleQuestions",
    "replaceArticleQuestions",
  ];
  let lines = s.split("\n");
  for (const name of names) {
    let i = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
    if (i < 0) throw new Error(`api-${name} 未命中`);
    let from = i;
    while (from - 1 >= 0 && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[from - 1])) from -= 1;
    let to = i;
    while (to < lines.length && lines[to] !== "}") to += 1;
    lines = [...lines.slice(0, from), ...lines.slice(to + 1)];
  }
  write("src/lib/api.ts", tidy(lines.join("\n")));
}

// ── 13. verify-records.mjs：③ 断言反向（守住 AC5 不回潮）──
{
  let s = read("scripts/verify-records.mjs");
  s = rep(
    s,
    "  // ③ 必须有 visibility='user' 的计数（复用既有统计命令，不新增命令）\n  assert(/SELECT COUNT\\(\\*\\) FROM article WHERE visibility = 'user'/.test(records), \"get_stats 缺 visibility='user' 计数 SQL\");\n  assert(/user_article_count/.test(records), \"StatsView 缺 user_article_count 字段\");\n  assert(/userArticleCount: number/.test(types), \"types.ts 缺 userArticleCount\");",
    "  // M11 AC5：visibility='user' 代码分支已移除（字段保留、取值恒为 system）——此处反向把关，防回潮\n  assert(!/visibility = 'user'/.test(records), \"records.rs 仍残留 visibility='user' 分支（M11 AC5 要求移除）\");\n  assert(!/user_article_count/.test(records), \"records.rs 仍残留 user_article_count（M11 AC5 要求移除）\");\n  assert(!/userArticleCount/.test(types), \"types.ts 仍残留 userArticleCount（M11 AC5 要求移除）\");",
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
console.log(`\n共 ${log.length} 项变更`);
