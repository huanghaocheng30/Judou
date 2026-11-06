/**
 * 生词本纯函数层（M3 D2）：三轴分组 / 筛选判定 / 标签名归一 / 卡片模型 / 回原句链接。
 *
 * 三条纪律（与 `lib/analysis.ts` 同款；`scripts/verify-vocab.mjs` 用 `node` 直接 import 本文件跑断言）：
 * 1. **不依赖 DOM**——不碰 `document`/`window`，只吃数据吐数据；
 * 2. **只用 erasable 语法**——禁 `enum` / `namespace` / 构造器参数属性（node 直接删类型就要能跑）；
 * 3. **不 import `.css` / `.tsx`**——只从 `./types` 拿 `import type`（纯类型，运行时被抹掉）。
 *
 * 模型类型 `VocabGroup` / `VocabFilter` / `VocabCardModel` **只落在这里**，不进 `types.ts`
 * （`types.ts` 只放「与 Rust 命令一一对应」的 IPC 契约；D2 / 评审 N-4）。
 *
 * ponytail: 分组是三轴各自 20 行的直白实现，不抽「GroupBuilder 策略表」——三轴规则差异太大
 * （article 有哨兵组、tag 一词多组、mastery 固定序），抽象出来的配置比代码还长。
 */
import type { VocabEntry } from "./types";

/** 分组轴（02 §三.0 的 `groupBy` 枚举值） */
export type VocabGroupBy = "article" | "tag" | "mastery";

/** 掌握状态三档（DB CHECK 同值） */
export type Mastery = "new" | "fuzzy" | "known";

/** 掌握状态固定展示序（02 D2：恒为 new → fuzzy → known） */
export const MASTERY_ORDER: Mastery[] = ["new", "fuzzy", "known"];

/** 掌握状态文字标签：**文字优先**，颜色只是辅助（AC7 / 决策 #5——色觉障碍用户不靠色块） */
export const MASTERY_LABELS: Record<Mastery, string> = {
  new: "新词",
  fuzzy: "模糊",
  known: "已掌握",
};

/** 来源文章被删（`source_article_id` 为 NULL）的哨兵组键：定长常量，不会和文章 id 撞 */
export const DELETED_SOURCE_KEY = "__deleted__";
export const DELETED_SOURCE_LABEL = "来源已删除";

/** 一个标签都没有的词的哨兵组键（按标签浏览时它们不该消失） */
export const UNTAGGED_KEY = "__untagged__";
export const UNTAGGED_LABEL = "未打标签";

/** 筛选条件：掌握状态单选 + 标签多选（AND）+ 关键词（不区分大小写） */
export interface VocabFilter {
  /** null = 全部 */
  mastery: Mastery | null;
  /** 空数组 = 不限；多个之间是 AND（都要有） */
  tagNames: string[];
  /** 空串 = 不过滤；匹配 `normalized` 与 `surface` */
  keyword: string;
}

/** 一个分组：`key` 是稳定标识（文章 id / 标签名 / 哨兵常量），`label` 是人读标题 */
export interface VocabGroup {
  key: string;
  label: string;
  kind: VocabGroupBy;
  rows: VocabEntry[];
}

/** 卡片渲染模型：D3 的行组件只吃它（不在 JSX 里散落取字段/拼标签的逻辑） */
export interface VocabCardModel {
  id: number;
  surface: string;
  phonetic: string | null;
  pos: string | null;
  contextMeaning: string | null;
  mastery: Mastery;
  /** 文字标签（新词/模糊/已掌握）——颜色不是唯一信息通道 */
  masteryLabel: string;
  tags: string[];
  /** 来源文章标题；来源已删时为「来源已删除」 */
  sourceTitle: string;
  /** 回原句链接；来源已删（无从跳起）时为 null |
   * 句子已删但文章还在时退化成文章链接（不伪造 `sentence` 参数） */
  sourceHref: string | null;
}

/** 空筛选（「全部」初始态；“清除筛选”也回到它） */
export function emptyFilter(): VocabFilter {
  return { mastery: null, tagNames: [], keyword: "" };
}

/** 是否处在「筛过」状态（决定空结果该显示「还没有生词」还是「没有符合条件的」） */
export function isFiltered(filter: VocabFilter): boolean {
  return filter.mastery !== null || filter.tagNames.length > 0 || filter.keyword.trim() !== "";
}

/** 掌握状态守卫 */
export function isMastery(value: unknown): value is Mastery {
  return value === "new" || value === "fuzzy" || value === "known";
}

/**
 * 掌握状态归一：未知值（旧数据 / 将来第四档）**按 `new` 处理**而不是丢掉——
 * 丢掉会让这条生词从三轴里凭空消失（数据静默丢失比标签不准更糟）。
 */
export function coerceMastery(value: string): Mastery {
  return isMastery(value) ? value : "new";
}

/**
 * 标签名归一：trim → 去空 → 去重（保序）。
 * **与 Rust 侧 `vocab::normalize_tag_names` 同口径**——写库前两边都要归一次，规则一致才不会出现
 * 「界面上两个标签、库里一个」。
 */
export function normalizeTagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const item of raw) {
    const name = String(item ?? "").trim();
    if (name === "" || names.includes(name)) {
      continue;
    }
    names.push(name);
  }
  return names;
}

/** 单条是否命中筛选（三条规则：掌握状态等值 / 标签 AND / 关键词不区分大小写） */
export function matchVocab(row: VocabEntry, filter: VocabFilter): boolean {
  if (filter.mastery !== null && coerceMastery(row.mastery) !== filter.mastery) {
    return false;
  }
  if (filter.tagNames.length > 0) {
    const owned = new Set(row.tagNames);
    if (!filter.tagNames.every((name) => owned.has(name))) {
      return false;
    }
  }
  const keyword = filter.keyword.trim().toLowerCase();
  if (keyword !== "") {
    const hit =
      row.normalized.toLowerCase().includes(keyword) || row.surface.toLowerCase().includes(keyword);
    if (!hit) {
      return false;
    }
  }
  return true;
}

/** 批量筛选（保持输入顺序 = 列表的 `updated_at DESC` 序） */
export function filterVocab(rows: VocabEntry[], filter: VocabFilter): VocabEntry[] {
  return rows.filter((row) => matchVocab(row, filter));
}

/** 来源文章标题：来源已删给哨兵文案；标题缺失（异常数据）退化成「文章 <id>」，不显示空白组头 */
export function articleLabel(row: VocabEntry): string {
  if (row.sourceArticleId === null) {
    return DELETED_SOURCE_LABEL;
  }
  const title = row.articleTitle === null ? "" : row.articleTitle.trim();
  return title === "" ? `文章 ${row.sourceArticleId}` : title;
}

/**
 * 三轴分组（空组一律不显示）：
 * - `article`：按 `sourceArticleId` 分组，**「来源已删除」固定排最后**（它不是真文章，混在中间会误导）；
 * - `mastery`：固定序 `new → fuzzy → known`（不按条目数量浮动，切换轴时段落位置稳定）；
 * - `tag`：**一个词可同时属于多个组**（按标签浏览时每个标签下都该看到它，重复计入是设计意图），
 *   组名升序，「未打标签」固定排最后。
 */
export function groupVocab(rows: VocabEntry[], groupBy: VocabGroupBy): VocabGroup[] {
  const groups = new Map<string, VocabGroup>();
  const push = (key: string, label: string, row: VocabEntry): void => {
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
      return;
    }
    groups.set(key, { key, label, kind: groupBy, rows: [row] });
  };

  if (groupBy === "mastery") {
    for (const row of rows) {
      const mastery = coerceMastery(row.mastery);
      push(mastery, MASTERY_LABELS[mastery], row);
    }
    return MASTERY_ORDER.filter((mastery) => groups.has(mastery)).map(
      (mastery) => groups.get(mastery) as VocabGroup,
    );
  }

  if (groupBy === "article") {
    for (const row of rows) {
      if (row.sourceArticleId === null) {
        push(DELETED_SOURCE_KEY, DELETED_SOURCE_LABEL, row);
        continue;
      }
      push(String(row.sourceArticleId), articleLabel(row), row);
    }
    const ordered = [...groups.values()].filter((group) => group.key !== DELETED_SOURCE_KEY);
    const deleted = groups.get(DELETED_SOURCE_KEY);
    return deleted === undefined ? ordered : [...ordered, deleted];
  }

  for (const row of rows) {
    if (row.tagNames.length === 0) {
      push(UNTAGGED_KEY, UNTAGGED_LABEL, row);
      continue;
    }
    for (const name of row.tagNames) {
      push(name, name, row);
    }
  }
  const compare = (a: VocabGroup, b: VocabGroup): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const tagged = [...groups.values()].filter((group) => group.key !== UNTAGGED_KEY).sort(compare);
  const untagged = groups.get(UNTAGGED_KEY);
  return untagged === undefined ? tagged : [...tagged, untagged];
}

/**
 * 回原句链接（D6 的 URL 形态，本批只产出 href、不改 Reader）：
 * `#/article/<articleId>?sentence=<sentenceId>`——路径段给文章、query 给句子（`routes.tsx` 的
 * `parseHash` 就是这么解析的）。来源已删 → `null`（「回原句」按钮不显示）。
 */
export function vocabSourceHref(row: VocabEntry): string | null {
  if (row.sourceArticleId === null) {
    return null;
  }
  const base = `#/article/${row.sourceArticleId}`;
  if (row.sourceSentenceId === null) {
    return base;
  }
  return `${base}?sentence=${row.sourceSentenceId}`;
}

/** 条目 → 卡片模型（把「取字段 + 拼标签 + 算链接」收在一处，JSX 只管排版） */
export function toCardModel(row: VocabEntry): VocabCardModel {
  const mastery = coerceMastery(row.mastery);
  return {
    id: row.id,
    surface: row.surface,
    phonetic: row.phonetic,
    pos: row.pos,
    contextMeaning: row.contextMeaning,
    mastery,
    masteryLabel: MASTERY_LABELS[mastery],
    tags: row.tagNames,
    sourceTitle: articleLabel(row),
    sourceHref: vocabSourceHref(row),
  };
}

/**
 * 错误对象 → 一句话文案。**Tauri 的拒绝值是 `CommandError {code,message,path}` 对象，不是 `Error` 实例**
 * （M2 起全项目都靠 `err instanceof Error` 取 message，那是拿不到 Tauri 错误文案的）。
 * 生词本页与编辑面板共用这一份，避免两处文案/取值口径漂移。
 */
export function describeCommandError(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
