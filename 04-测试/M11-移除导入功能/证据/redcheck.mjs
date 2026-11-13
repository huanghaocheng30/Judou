// M11 红→绿判据（AC1/AC2/AC3/AC4/AC5 的机器可判定部分）
// 用法：node E:/Judou/.tmp/m11/redcheck.mjs    退出码 0=绿（改后）/ 1=红（改前）
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:/Judou/code";
let failed = 0;
const out = [];
function check(name, fn) {
  const r = fn();
  const ok = r === true;
  if (!ok) failed += 1;
  out.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  → ${r}`}`);
}
const read = (p) => readFileSync(join(ROOT, p), "utf8");
function walk(rel, exts) {
  const acc = [];
  const stack = [join(ROOT, rel)];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.some((x) => e.name.endsWith(x))) acc.push(p);
    }
  }
  return acc;
}

// AC5：visibility='user' 分支命中数必须为 0
check("AC5 visibility='user' 命中数 = 0", () => {
  const hits = [];
  for (const f of [...walk("src-tauri/src", [".rs"]), ...walk("src", [".ts", ".tsx"])]) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/visibility\s*(=|!=|==|<>)\s*'user'|visibility\s*(=|!=|==)\s*"user"|userArticleCount|user_article_count|=== "user"/.test(line)) {
          hits.push(`${f.replace(ROOT + "/", "")}:${i + 1}`);
        }
      });
  }
  return hits.length === 0 ? true : `${hits.length} 处：${hits.slice(0, 6).join(", ")}`;
});

// AC1：导航 6 项；#/import 路由不存在
check("AC1 NAV_ITEMS = 6", () => {
  const src = read("src/shell/Sidebar.tsx");
  const block = src.slice(src.indexOf("NAV_ITEMS"));
  const n = (block.slice(0, block.indexOf("];")).match(/path: "#\//g) ?? []).length;
  return n === 6 ? true : `实测 ${n} 项`;
});
check("AC1 routes 无 #/import", () => {
  const src = read("src/shell/routes.tsx");
  return !src.includes('"#/import"') && !src.includes("pages/Import") ? true : "仍存在 #/import 路由或 Import 引用";
});

// AC2：6 个文件不存在
check("AC2 6 个文件已删除", () => {
  const gone = [
    "src-tauri/src/ai_import.rs",
    "src-tauri/src/import_user.rs",
    "src-tauri/src/bin/ai_import_cli.rs",
    "src-tauri/src/bin/import_user_cli.rs",
    "src/pages/Import.tsx",
    "src/components/ArticleEditor.tsx",
  ];
  const rest = gone.filter((f) => existsSync(join(ROOT, f)));
  return rest.length === 0 ? true : `仍存在：${rest.join(", ")}`;
});

// AC3：14 个导入命令（AC3 12 项 + import_user 的 2 项）在 lib.rs / commands.rs 均无
check("AC3 导入命令全部摘除（保留 import_content_pack）", () => {
  const names = [
    "build_ai_prompt",
    "parse_ai_payload",
    "match_ai_payload",
    "suggest_section",
    "commit_ai_import",
    "patch_ai_analysis",
    "get_ai_import_stats",
    "split_user_input",
    "split_passages",
    "update_article_meta",
    "get_article_questions",
    "replace_article_questions",
    "parse_import_preview",
    "commit_import",
  ];
  const lib = read("src-tauri/src/lib.rs");
  const cmd = read("src-tauri/src/commands.rs");
  const left = names.filter((n) => lib.includes(n) || cmd.includes(n));
  const keep = lib.includes("import_content_pack") && cmd.includes("import_content_pack");
  return left.length === 0 && keep ? true : `残留命令：${left.join(", ") || "无"}；import_content_pack 保留=${keep}`;
});

// AC4：3 脚本 + 39 fixture 不存在，package.json 无 3 script
check("AC4 门禁脚本与 fixture 已删除", () => {
  const gone = ["scripts/verify-ai-import.mjs", "scripts/verify-import-user.mjs", "scripts/verify-import.mjs", "scripts/fixtures/ai-import", "scripts/fixtures/ai-import-full"];
  const rest = gone.filter((f) => existsSync(join(ROOT, f)));
  const pkg = JSON.parse(read("package.json"));
  const scripts = Object.keys(pkg.scripts).filter((k) => ["verify:import", "verify:import-user", "verify:ai-import"].includes(k));
  return rest.length === 0 && scripts.length === 0 ? true : `残留：${[...rest, ...scripts].join(", ")}`;
});

// 「绝对不要动」6 条：必须都还在
check("保留项齐备（import.rs/pack.rs/import_content_pack/verify-pack/verify-sql/content-pack/迁移）", () => {
  const keep = [
    "src-tauri/src/import.rs",
    "src-tauri/src/pack.rs",
    "scripts/verify-pack.mjs",
    "scripts/verify-sql.mjs",
    "content-pack",
    "src-tauri/migrations/001_init.sql",
  ];
  const miss = keep.filter((f) => !existsSync(join(ROOT, f)));
  const migrations = readdirSync(join(ROOT, "src-tauri/migrations")).filter((f) => /^00[123]/.test(f));
  return miss.length === 0 && migrations.length === 3 ? true : `缺：${miss.join(", ")}；迁移 ${migrations.length} 个`;
});

console.log(out.join("\n"));
console.log(`\nRESULT: ${failed === 0 ? "GREEN（全部通过）" : `RED（${failed} 项未过）`}`);
process.exit(failed === 0 ? 0 : 1);
