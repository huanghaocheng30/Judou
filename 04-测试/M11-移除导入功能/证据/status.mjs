import { readFileSync, writeFileSync } from "node:fs";
const p = "E:/Judou/03-开发协同/M11-移除导入功能/状态.md";
let s = readFileSync(p, "utf8");
const bom = s.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
console.log("BOM=" + (bom ? 1 : 0));
const body = s.replace(/^\uFEFF/, "");
const edits = [
  ["当前阶段：执行中", "当前阶段：待审查"],
  ["候选commit：—", "候选commit：9a56ae2"],
  ["最近更新：2026-11-13 15:56（机器时钟实测）", "最近更新：2026-11-13 17:40（机器时钟实测）"],
  [
    "下一步：彻底移除用户导入（6 文件 / 13 命令 / 3 门禁 / 39 fixture / visibility 分支）；**保留** import.rs + pack.rs + import_content_pack + 001~003 迁移",
    "下一步：待审核员审查（FT-M11-1 已豁免计划审核与代码审查 → 直接进审查/验收；复审重点见 决策记录.md §二）",
  ],
];
let out = body;
for (const [a, b] of edits) {
  if (!out.includes(a)) throw new Error("缺锚点：" + a);
  out = out.split(a).join(b);
}
const record =
  "- 2026-11-13 17:40 ｜ 开发员 执行完成：61 files / +28 −12704；候选 commit `9a56ae2`；`npm run build` EXIT=0 + `cargo test` **70 passed**（新基线）+ 15 个 manifest 门禁全 EXIT=0；AC7 老库真机取证（12 篇 / 6 导航 / 0 控制台错误）；正当扩围 6 文件已登记 `决策记录.md` §一。阶段置 `待审查`。";
if (!out.trimEnd().endsWith("阶段置 `待审查`。")) {
  out = out.replace(/\s*$/, "") + "\n" + record + "\n";
}
writeFileSync(p, bom + out, "utf8");
console.log("W 状态.md");
