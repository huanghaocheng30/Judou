// M11 摘钩子 · 第三轮（Reader.tsx 保留 CRLF；其余剩余文件）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:/Judou/code";
const log = [];
const raw = (rel) => readFileSync(join(ROOT, rel), "utf8");
function write(rel, text, eol) {
  const body = eol === "crlf" ? text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
  writeFileSync(join(ROOT, rel), body, "utf8");
  log.push(`W ${rel}${eol === "crlf" ? "（CRLF 保持）" : ""}`);
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

// Reader.tsx（CRLF → 内存 LF → 写回 CRLF）
{
  let s = raw("src/pages/Reader.tsx").replace(/\r\n/g, "\n");
  s = rep(s, 'import { ArticleEditor } from "../components/ArticleEditor";\n', "", "rd-import");
  s = rep(s, "  const [editorOpen, setEditorOpen] = useState(false);\n", "", "rd-open");
  s = rep(s, "  const [titleOverride, setTitleOverride] = useState<string | null>(null);\n", "", "rd-title");
  s = cut(s, "          {/* M5b D4：精读页页头的「补全解析」入口（AC9）", "          </button>\n", "rd-actions");
  s = cut(s, "        {/* M5c D5：编辑面板（元信息 + 题目），保存后只覆盖标题与题目，不重拉整篇 */}", "        )}\n\n", "rd-panel");
  s = rep(s, "{titleOverride ?? detail.title}", "{detail.title}", "rd-title-use");
  write("src/pages/Reader.tsx", tidy(s), "crlf");
}

// Onboarding.tsx
{
  let s = raw("src/components/Onboarding.tsx");
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
  const s = raw("src/lib/types.ts");
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
  let lines = raw("src/lib/api.ts").split("\n");
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

// verify-records.mjs
{
  let s = raw("scripts/verify-records.mjs");
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
