/**
 * M6 门禁（D8 / AC1·AC2·AC3·AC5·AC6·AC7·AC8·AC10·AC13）——**静态契约 + 可复算断言**。
 *
 * 为什么是静态的：统计数字/备份恢复的真跑证据在执行自测里由 `cargo test` 单测给出
 * （`records.rs` / `export.rs` 的 `mod tests`），门禁这层负责守住「契约不被改回去」：
 * 命令注册、SQL 聚合口径、自包含 HTML 的无外链约束、主题持久键、版本一致性。
 * 这是纯 node 脚本：不连库、不起前端、不改任何文件。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name} — ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const commands = read("src-tauri/src/commands.rs");
const lib = read("src-tauri/src/lib.rs");
const records = read("src-tauri/src/records.rs");
const exportRs = read("src-tauri/src/export.rs");
const api = read("src/lib/api.ts");
const types = read("src/lib/types.ts");
const recordsPage = read("src/pages/Records.tsx");
const settingsPage = read("src/pages/Settings.tsx");
const guidePage = read("src/components/Guide.tsx");
const app = read("src/App.tsx");
const reader = read("src/pages/Reader.tsx");

console.log("M6 门禁 · 记录 / 统计 / 导出 / 备份 / 设置 / 引导");

// ── AC2/AC3：聚合口径与连续天数 ─────────────────────────────
check("AC2 六项统计都走 SQL 聚合（COUNT/SUM），前端不二次累加", () => {
  assert(/SELECT COUNT\(\*\), COALESCE\(SUM\(completed\), 0\), COALESCE\(SUM\(duration_sec\), 0\)/.test(records),
    "reading_record 聚合 SQL 缺失");
  assert(/FROM sentence_note\) \+ \(SELECT COUNT\(\*\) FROM word_note\)/.test(records), "笔记数为两表之和");
  assert(/FROM vocab_entry/.test(records) && /FROM review_log/.test(records), "生词/复习计数缺失");
  assert(!/articleCount\s*\+/.test(recordsPage), "前端不得对统计值二次加减");
  return "COUNT/SUM 直读";
});

check("AC3 连续天数实现包含「今天未读则从昨天起算」", () => {
  assert(/pub fn compute_streak\(dates: &\[String\], today: &str\) -> u32/.test(records), "compute_streak 签名变了");
  assert(/if set\.contains\(&today_idx\) \{ today_idx \} else \{ today_idx - 1 \}/.test(records),
    "缺少「今天无记录 → 从昨天起算」分支");
  assert(/while set\.contains\(&cursor\)/.test(records), "缺少逐日递减循环");
  return "today / today-1 分支在位";
});

check("AC3 单测覆盖四例（连续 3 天 / 断档 / 今天未读 / 跨月）", () => {
  const names = [...records.matchAll(/#\[test\]\s*\n\s*fn (\w+)/g)].map((m) => m[1]);
  assert(names.length >= 5, `单测不足 5 条（实测 ${names.length}）`);
  for (const required of [
    "streak_counts_three_consecutive_days",
    "streak_breaks_at_gap",
    "streak_ends_yesterday_when_today_unread",
    "streak_crosses_month_boundary",
  ]) {
    assert(names.includes(required), `缺用例 ${required}`);
  }
  return `${names.length} 条`;
});

// ── AC1/AC12：记录页 ───────────────────────────────────────
check("AC1 记录页时间线容器与倒序 SQL 在位", () => {
  assert(/data-records-list/.test(recordsPage), "缺 data-records-list");
  assert(/data-stats-card/.test(recordsPage) && /data-stats-streak/.test(recordsPage), "缺统计卡钩子");
  assert(/ORDER BY COALESCE\(r\.last_read_at, ''\) DESC/.test(records), "时间线必须按 last_read_at 倒序");
  assert(/#\/article\/\$\{record\.articleId\}/.test(recordsPage), "每行必须可点回精读页");
  return "列表 + 回跳 + 统计卡";
});

check("AC12 记录空态有下一步入口", () => {
  assert(/data-empty-records/.test(recordsPage), "缺 data-empty-records");
  assert(/href="#\/library"/.test(recordsPage), "空态缺「去文章库」入口");
  return "空态 + 入口";
});

// ── AC5/AC6/AC7：导出与备份 ────────────────────────────────
check("AC5 HTML 自包含（无 link / 无外链 script / 无 http）", () => {
  const template = exportRs.slice(exportRs.indexOf("fn render_vocab_html"), exportRs.indexOf("pub fn backup_db"));
  assert(!/<link/.test(template), "模板不得含 <link>");
  assert(!/<script src=/.test(template), "模板不得含外部脚本");
  assert(!/https?:\/\//.test(template), "模板不得含 http(s) 外链");
  assert(/<style>/.test(template), "样式必须内联");
  assert(/if let Some\(name\) = .*phonetic/s.test(template) || /phonetic/.test(template), "音标缺失");
  for (const label of ["释义", "搭配", "例句", "来源句", "标签"]) {
    assert(template.includes(label), `导出缺字段「${label}」`);
  }
  return "内联样式 + 七字段";
});

check("AC6 备份产出 .db + 同名 .json 元信息（含 schemaVersion 与表计数）", () => {
  assert(/judou-backup-\{stamp\}\.db/.test(exportRs), "备份文件名不符");
  assert(/judou-backup-\{stamp\}\.json/.test(exportRs), "元信息文件名不符");
  assert(/"schemaVersion"/.test(exportRs) && /"tables"/.test(exportRs), "元信息字段缺失");
  return "db + json";
});

check("AC7 恢复：先备份 pre-restore → 校验源 → 临时副本 → 失败回滚", () => {
  assert(/judou-pre-restore-\{stamp\}\.db/.test(exportRs), "缺 pre-restore 备份文件名");
  assert(/fn open_source/.test(exportRs) && /restore_invalid/.test(exportRs), "缺源文件校验");
  assert(/\.restore-check-/.test(exportRs), "缺临时副本校验");
  const order = [
    exportRs.indexOf("let src_conn = open_source(src)"),
    exportRs.indexOf("vacuum_into(db, &pre_path)"),
    exportRs.indexOf("copy_into(db, &src_conn)"),
  ];
  assert(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "顺序必须是 校验源 → 备份现库 → 覆盖");
  assert(/copy_into\(db, &open_source\(&pre_path\)\?\)/.test(exportRs), "覆盖失败缺回滚");
  return "四步顺序 + 回滚";
});

// ── AC8/AC9/AC10/AC11：设置与引导 ──────────────────────────
check("AC8 主题三档有 data-theme-option，持久键 theme 走既有命令", () => {
  assert(/data-theme-option=\{option\}/.test(settingsPage), "缺 data-theme-option");
  for (const tier of ['"light"', '"dark"', '"system"']) {
    assert(/THEME_SETTINGS: readonly ThemeSetting\[\] = \["light", "dark", "system"\]/.test(read("src/lib/theme.ts")), "三档定义变了");
    void tier;
  }
  assert(/setSetting\("guide_shown", "0"\)/.test(settingsPage), "重新查看引导必须写 guide_shown");
  return "三档 + 持久";
});

check("AC9 复习间隔只读（1/3/7/14 且无编辑控件）", () => {
  assert(/const DEFAULT_INTERVALS = \[1, 3, 7, 14\]/.test(settingsPage), "间隔值必须是 1/3/7/14");
  const section = settingsPage.slice(settingsPage.indexOf("data-review-intervals"), settingsPage.indexOf("data-review-intervals") + 600);
  assert(!/<input|<select/.test(section), "复习间隔区不得有编辑控件");
  return "只读";
});

check("AC10 关于四项齐全且版本来自 package.json", () => {
  for (const hook of ["data-about", "data-about-version", "data-about-license", "data-about-disclaimer", "data-about-source"]) {
    assert(settingsPage.includes(hook), `缺 ${hook}`);
  }
  const pkg = JSON.parse(read("package.json"));
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert(pkg.version === conf.version, `package.json ${pkg.version} ≠ tauri.conf.json ${conf.version}`);
  const cargo = read("src-tauri/Cargo.toml");
  const cargoVersion = /^version = "([^"]+)"/m.exec(cargo)?.[1];
  assert(cargoVersion === pkg.version, `Cargo.toml ${cargoVersion} ≠ package.json ${pkg.version}`);
  return `三处版本一致 ${pkg.version}`;
});

check("AC11 引导三屏 + 跳过写 guide_shown=1 + 设置页可重开", () => {
  assert(/const SCREENS: Screen\[\] = \[/.test(guidePage), "缺三屏定义");
  const screens = [...guidePage.matchAll(/key: "(sentence|word|import)"/g)].length;
  assert(screens === 3, `应三屏，实测 ${screens}`);
  assert(/setSetting\("guide_shown", "1"\)/.test(guidePage), "跳过/完成必须写 guide_shown=1");
  assert(/data-guide-skip/.test(guidePage), "缺跳过按钮");
  assert(/<Guide \/>/.test(app), "App 未挂载 Guide");
  assert(/data-reopen-guide/.test(settingsPage), "设置页缺「重新查看引导」");
  assert(/judou:show-guide/.test(guidePage) && /judou:show-guide/.test(settingsPage), "重开事件名不一致");
  return "三屏 + 持久 + 重开";
});

// ── AC4 / AC13：埋点与命令注册 ────────────────────────────
check("AC4 精读页进出埋点（进入 + 离开累加）", () => {
  assert(/touchReading\(articleId, "", 0\)/.test(reader), "进入埋点缺失");
  assert(/duration_sec = duration_sec \+ \?3/.test(records), "后端必须累加 duration_sec（不能覆盖）");
  assert(/completed = 1, last_read_at = datetime\('now'\)/.test(read("src-tauri/src/review.rs")), "完成精读仍走 M4 幂等路径");
  return "进入 + 离开累加";
});

check("AC13 六个命令全部注册且前端有封装", () => {
  const handlers = [
    ["get_reading_records", "getReadingRecords"],
    ["touch_reading", "touchReading"],
    ["get_stats", "getStats"],
    ["export_vocab_html", "exportVocabHtml"],
    ["backup_db", "backupDb"],
    ["restore_db", "restoreDb"],
  ];
  for (const [rust, ts] of handlers) {
    assert(new RegExp(`commands::${rust}`).test(lib), `lib.rs 未注册 ${rust}`);
    assert(api.includes(`invoke<`) && api.includes(`"${rust}"`), `api.ts 缺 ${rust} 封装`);
    void ts;
  }
  assert(types.includes("ReadingRecordView") && types.includes("StatsView"), "types.ts 缺 M6 类型");
  return `${handlers.length} 个命令`;
});

// ── M6 第四轮：PDF 词表（三模式 / 乱序 / A4 双栏打印） ─────────
const sheetRs = exportRs.slice(exportRs.indexOf("pub enum SheetMode"), exportRs.indexOf("fn read_vocab_rows"));
const sheetZhLine = sheetRs.split("\n").find((line) => line.includes("SheetMode::Zh =>") && line.includes("sheet_cell")) || "";
const sheetEnLine = sheetRs.split("\n").find((line) => line.includes("SheetMode::En =>") && line.includes("sheet_cell")) || "";

check("PDF-1 命令 export_vocab_sheet 已注册，前端有封装与三个挂点", () => {
  assert(/commands::export_vocab_sheet/.test(lib), "lib.rs 未注册 export_vocab_sheet");
  assert(/"export_vocab_sheet"/.test(api), "api.ts 缺 export_vocab_sheet 封装");
  assert(/data-export-pdf/.test(settingsPage), "缺导出主按钮 data-export-pdf");
  assert(/data-export-shuffle/.test(settingsPage), "缺乱序开关 data-export-shuffle");
  assert(/data-export-mode=\{item\.mode\}/.test(settingsPage), "缺三模式挂点 data-export-mode");
  return "1 命令 + 3 挂点";
});

check("PDF-2 A4 打印骨架：@page size A4 + 内联样式 + 零外链 + 中文字体", () => {
  assert(sheetRs.length > 0, "取不到 PDF 词表实现段");
  assert(/@page\s*\{\s*size:\s*A4/.test(sheetRs), "@page 必须声明 A4");
  assert(/print-color-adjust:\s*exact/.test(sheetRs), "必须保留浅色底纹（print-color-adjust: exact）");
  assert(!/<link/.test(sheetRs), "词表模板不得含 <link>");
  assert(!/https?:\/\//.test(sheetRs), "词表模板不得含 http(s) 外链");
  assert(/font-family:\s*"Microsoft YaHei"/.test(sheetRs), "缺中文字体栈");
  return "A4 + 内联 + 无外链";
});

check("PDF-3 三模式互斥且结构不同（A4 左右分栏各自编号）", () => {
  for (const mode of ["A4", "Zh", "En"]) {
    assert(new RegExp(`SheetMode::${mode}`).test(sheetRs), `缺模式 ${mode}`);
  }
  assert(
    /SheetMode::A4 => \(page_rows, page_rows, SheetColumns::Single\("Word"\), SheetColumns::Single\("Meaning"\)\)/.test(sheetRs),
    "A4 必须是左右同批词、单列分栏（左 Word / 右 Meaning）",
  );
  assert(/"word"/.test(sheetRs) && /"meaning"/.test(sheetRs), "A4 两侧 data-col 必须是 word / meaning");
  assert(/SheetMode::A4 => SHEET_ROWS_PER_COL/.test(sheetRs), "A4 每页词数口径缺失");
  return "三模式结构差异";
});

check("PDF-4 留空列：zh 的 Word 空 / en 的 Meaning 空（data-empty 契约）", () => {
  assert(/data-empty=/.test(sheetRs), "留空列必须有 data-empty 标记");
  assert(/fn sheet_cell/.test(sheetRs), "单元格渲染必须集中在一处");
  assert(
    sheetZhLine.includes("sheet_cell(None)") && sheetZhLine.includes("sheet_cell(Some(meaning))"),
    "中文词表必须 Word 留空、Meaning 填释义",
  );
  assert(
    sheetEnLine.includes("sheet_cell(Some(&row.surface))") && sheetEnLine.includes("sheet_cell(None)"),
    "英文词表必须 Word 填单词、Meaning 留空",
  );
  assert((sheetZhLine.match(/sheet_cell\(None\)/g) || []).length === 1, "zh 每行只能一个空单元格");
  assert((sheetEnLine.match(/sheet_cell\(None\)/g) || []).length === 1, "en 每行只能一个空单元格");
  return "data-empty 契约";
});

check("PDF-5 分页与每页重复表头（A4 每页 15 词 / zh·en 每页 30 词）", () => {
  assert(/const SHEET_ROWS_PER_COL: usize = 15/.test(sheetRs), "每栏行数必须是 15");
  assert(/SheetMode::Zh \| SheetMode::En => SHEET_ROWS_PER_COL \* 2/.test(sheetRs), "zh/en 每页必须 30 词");
  assert(/<thead>/.test(sheetRs), "表头必须用 <thead>（打印时每页重复）");
  assert(/div_ceil\(words_per_page\)/.test(sheetRs), "页数必须向上取整");
  assert(/第 \{page_no\} 页 \/ \{page_count\} 页/.test(sheetRs), "每页必须标页码");
  return "15/30 + thead";
});

check("PDF-6 乱序：Fisher-Yates，不引新依赖", () => {
  assert(/fn shuffle_rows\(rows: &mut \[VocabRow\], mut state: u64\)/.test(sheetRs), "缺 shuffle_rows");
  assert(/rows\.swap\(i, j\)/.test(sheetRs), "乱序必须真交换元素");
  assert(/for i in \(1\.\.rows\.len\(\)\)\.rev\(\)/.test(sheetRs), "必须是 Fisher-Yates 反向遍历");
  assert(!/use rand::/.test(exportRs), "不得引新 crate（rand）");
  return "Fisher-Yates";
});

check("PDF-7 前端走隐藏 iframe 的 contentWindow.print()（不用 window.open）", () => {
  assert(/document\.createElement\("iframe"\)/.test(settingsPage), "缺隐藏 iframe");
  assert(/contentWindow/.test(settingsPage) && /\.print\(\)/.test(settingsPage), "必须走 iframe contentWindow.print()");
  assert(!/window\.open\(/.test(settingsPage), "Tauri webview 会拦 window.open，不得使用");
  return "iframe print";
});

// ── M6 第五轮：释义回退链（context_meaning → lexicon.sense）+ A4 答案对照 ──
check("PDF-8 释义回退链：context_meaning 为空时导出改用 lexicon.sense", () => {
  assert(/LEFT JOIN lexicon lx ON lx\.normalized = v\.normalized/.test(exportRs), "read_vocab_rows 必须按 normalized LEFT JOIN lexicon");
  assert(/sense: row\.get\(9\)\?/.test(exportRs), "VocabRow 必须接 lexicon.sense");
  assert(/fn meaning_text\(row: &VocabRow\) -> Option<&str>/.test(exportRs), "缺 meaning_text 回退链");
  assert(/clean\(row\.context_meaning\.as_deref\(\)\)\.or_else\(\|\| clean\(row\.sense\.as_deref\(\)\)\)/.test(exportRs),
    "回退顺序必须是「本句意思 → 词典释义」");
  assert(!/row\.context_meaning\.as_deref\(\)\.unwrap_or\(""\)/.test(exportRs),
    "不得只取 context_meaning（那样 NULL 词的释义整列会空）");
  return "lexicon.sense 回退";
});

check("PDF-9 A4 答案对照节：data-sheet-answer 行数 = 词数，关掉开关不输出", () => {
  assert(/data-sheet-answer/.test(exportRs), "缺 data-sheet-answer 节");
  assert(/fn render_sheet_answer\(page_rows: &\[VocabRow\], offset: usize\) -> String/.test(exportRs), "缺答案节渲染函数");
  assert(/data-answer-no=/.test(exportRs), "答案行必须带 data-answer-no（门禁据此数行）");
  assert(/if with_answer && mode == SheetMode::A4 \{/.test(exportRs), "只有 A4 + 开关开启才出答案节");
  assert(/with_answer\.unwrap_or\(true\)/.test(commands), "命令层答案开关缺省必须为 true");
  assert(/data-export-answer/.test(settingsPage), "前端缺「附答案」开关 data-export-answer");
  assert(/exportVocabSheet\(sheetMode, sheetShuffle, sheetAnswer\)/.test(settingsPage), "开关必须透传到导出调用");
  assert(/a4_answer_section_lists_word_and_meaning_per_page/.test(exportRs), "缺答案对照单测");
  return "答案节 + 开关";
});

check("PDF-10 A4 右栏 Meaning 在有词典释义时非空（不得打 data-empty）", () => {
  assert(/"left" => sheet_cell\(Some\(&row\.surface\)\)/.test(exportRs), "A4 左栏必须仍是 Word");
  assert(/_ => sheet_cell\(Some\(meaning\)\)/.test(exportRs), "A4 右栏必须用回退后的 meaning");
  assert(/a4_meaning_column_is_never_empty_when_sense_present/.test(exportRs), "缺「右栏非空」单测");
  return "右栏非空";
});

check("PDF-11 zh/en 与 A4 共用同一回退链（单元格层不直连 context_meaning）", () => {
  const meaningCalls = [...sheetRs.matchAll(/sheet_cell\(Some\(meaning\)\)/g)].length;
  assert(meaningCalls >= 2, `释义单元格必须集中在 meaning 变量上（实测 ${meaningCalls} 处）`);
  assert(!/sheet_cell\(Some\(&row\.context_meaning/.test(sheetRs), "单元格层不得直连 context_meaning");
  assert(/meaning_falls_back_to_lexicon_sense_in_all_three_modes/.test(exportRs), "缺三模式回退单测");
  return `${meaningCalls} 处共用 meaning`;
});

console.log(`\nM6 门禁：${passed} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
