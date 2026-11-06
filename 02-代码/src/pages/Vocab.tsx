/**
 * 生词本（M3 第 1 批 D3 · **骨架版**）：三轴切换 / 筛选 / 搜索 / 分组列表 / 两种空态。
 *
 * 本批**已做**（D3）：
 * - 三轴切换（按文章 / 按标签 / 按掌握状态），分组与排序全在纯函数层 `lib/vocab.ts`（AC3）；
 * - 筛选：掌握状态单选、标签多选（AND）、关键词（不区分大小写，匹配 `normalized` 与 `surface`）；
 * - 条目渲染：原词 + 音标 + 词性 + 语境义 + **文字优先**的掌握状态 + 标签 chips + 来源文章标题 +「回原句」；
 * - 两种空态：一篇生词都没有（`data-vocab-empty="all"`）/ 有但筛选没命中（`"filtered"`）+ 一键清除筛选。
 *
 * 本批**不做**（第 2 批 D4/D5，接线点已留好）：
 * - 编辑面板（改语境义/音标/词性/掌握状态、增删标签）→ `updateVocab` / `setVocabTags`；
 * - 行内「移出」按钮 → `deleteVocab`；
 * - 标签管理（`deleteTag`）与 Reader 侧的「加入生词本 / 已在生词本」按钮。
 *
 * 属性契约（02 §三 D3，**已冻结**）：`data-vocab-count` / `data-vocab-group` / `data-vocab-row` /
 * `data-vocab-empty`；掌握状态另有 `data-vocab-mastery`（值即 `new`/`fuzzy`/`known`）。
 * **不得**用 `data-has-note` 表达收藏态（那是 M2 笔记态，TP-修复1 §S-R1-1）。
 *
 * ponytail: 不引路由/状态库、不做虚拟滚动——生词量级「百~千」，直接全量渲染分组列表；
 * 上千后再按 `groupVocab` 的组边界做 `content-visibility` 或分页（命令已包一层 `entries`，加分页字段不改契约）。
 */
import { useEffect, useMemo, useState } from "react";
import { listTags, listVocab } from "../lib/api";
import type { Tag, VocabEntry } from "../lib/types";
import {
  MASTERY_LABELS,
  MASTERY_ORDER,
  emptyFilter,
  filterVocab,
  groupVocab,
  isFiltered,
  toCardModel,
  type Mastery,
  type VocabFilter,
  type VocabGroupBy,
} from "../lib/vocab";

/** 三条轴的显示名（顺序即按钮顺序：文章 → 标签 → 掌握状态） */
const AXES: { key: VocabGroupBy; label: string }[] = [
  { key: "article", label: "按文章" },
  { key: "tag", label: "按标签" },
  { key: "mastery", label: "按掌握状态" },
];

/** Tauri 的拒绝值是 `CommandError` 对象（`{code,message,path}`），不是 `Error` 实例 */
function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function Vocab() {
  const [rows, setRows] = useState<VocabEntry[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [axis, setAxis] = useState<VocabGroupBy>("article");
  const [filter, setFilter] = useState<VocabFilter>(emptyFilter);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 列表与标签各一次 IPC（并发）：标签 chips 要的是全库标签，不是本页出现过的标签
  useEffect(() => {
    let cancelled = false;
    Promise.all([listVocab(), listTags()])
      .then(([list, tagList]) => {
        if (cancelled) return;
        setRows(list.entries);
        setTags(tagList);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => filterVocab(rows, filter), [rows, filter]);
  const groups = useMemo(() => groupVocab(visible, axis), [visible, axis]);
  const filtering = isFiltered(filter);

  const toggleTag = (name: string): void => {
    setFilter((prev) => ({
      ...prev,
      tagNames: prev.tagNames.includes(name)
        ? prev.tagNames.filter((item) => item !== name)
        : [...prev.tagNames, name],
    }));
  };

  return (
    <section className="vocab">
      <div className="library-head">
        <div className="tabs" role="group" aria-label="分组方式">
          {AXES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={axis === item.key ? "tab on" : "tab"}
              aria-pressed={axis === item.key}
              data-vocab-axis={item.key}
              onClick={() => setAxis(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <input
          className="search"
          type="search"
          value={filter.keyword}
          placeholder="搜生词（原词/词形，不区分大小写）…"
          aria-label="搜索生词"
          data-vocab-search
          onChange={(event) => setFilter((prev) => ({ ...prev, keyword: event.target.value }))}
        />
      </div>

      <div className="filters">
        <div className="filter-row" data-vocab-filter="mastery">
          <span className="filter-label">掌握状态</span>
          <div className="chips">
            <button
              type="button"
              className={filter.mastery === null ? "chip on" : "chip"}
              aria-pressed={filter.mastery === null}
              data-value="all"
              onClick={() => setFilter((prev) => ({ ...prev, mastery: null }))}
            >
              全部
            </button>
            {MASTERY_ORDER.map((value: Mastery) => (
              <button
                key={value}
                type="button"
                className={filter.mastery === value ? "chip on" : "chip"}
                aria-pressed={filter.mastery === value}
                data-value={value}
                onClick={() => setFilter((prev) => ({ ...prev, mastery: value }))}
              >
                {MASTERY_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        {tags.length > 0 && (
          <div className="filter-row" data-vocab-filter="tag">
            <span className="filter-label">标签</span>
            <div className="chips">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className={filter.tagNames.includes(tag.name) ? "chip on" : "chip"}
                  aria-pressed={filter.tagNames.includes(tag.name)}
                  data-value={tag.name}
                  onClick={() => toggleTag(tag.name)}
                >
                  {tag.name}
                </button>
              ))}
              <span className="filter-hint">多选为「同时具备」</span>
            </div>
          </div>
        )}
      </div>

      <p className="library-count" data-vocab-count={visible.length}>
        {loading
          ? "读取中…"
          : filtering
            ? `命中 ${visible.length} 个（全部 ${rows.length} 个）`
            : `共 ${rows.length} 个生词`}
      </p>

      {error && (
        <p className="library-error" role="alert">
          读取生词本失败：{error}
        </p>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="empty" data-vocab-empty="all">
          <p>生词本还是空的。精读时在词卡上「加入生词本」，攒下第一个词。</p>
          <a className="btn" href="#/library">
            去文章库
          </a>
        </div>
      )}

      {!loading && !error && rows.length > 0 && visible.length === 0 && (
        <div className="empty" data-vocab-empty="filtered">
          <p>没有符合条件的生词，试试放宽条件。</p>
          <button type="button" className="btn" onClick={() => setFilter(emptyFilter())} data-vocab-clear>
            清除筛选
          </button>
        </div>
      )}

      {groups.map((group) => (
        <section className="vocab-group" key={group.key} data-vocab-group={group.key}>
          <h2 className="vocab-group-head">
            {group.label}
            <span className="vocab-group-size">{group.rows.length}</span>
          </h2>
          <ul className="vocab-list">
            {group.rows.map((row) => (
              <VocabRow key={`${group.key}-${row.id}`} row={row} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

/** 单条生词：只吃 `toCardModel` 的结果（取字段/拼标签/算链接都在纯函数层，便于直测） */
function VocabRow({ row }: { row: VocabEntry }) {
  const card = toCardModel(row);
  return (
    <li className="vocab-row" data-vocab-row={card.id} data-vocab-mastery={card.mastery}>
      <div className="vocab-row-head">
        <span className="vocab-word">{card.surface}</span>
        {card.phonetic && <span className="vocab-phonetic">{card.phonetic}</span>}
        {card.pos && <span className="vocab-pos">{card.pos}</span>}
        {/* 文字优先：三档名字必须在，颜色只是辅助（AC7 / 决策 #5） */}
        <span className={`vocab-mastery mastery-${card.mastery}`} data-vocab-mastery-label={card.mastery}>
          {card.masteryLabel}
        </span>
      </div>

      {card.contextMeaning && <p className="vocab-sense">{card.contextMeaning}</p>}

      <p className="vocab-meta">
        {card.tags.length > 0 && (
          <span className="vocab-tags">
            {card.tags.map((name) => (
              <span className="tag" key={name}>
                {name}
              </span>
            ))}
          </span>
        )}
        <span className="vocab-source">{card.sourceTitle}</span>
        {card.sourceHref && (
          <a className="link-btn" href={card.sourceHref} data-vocab-source-link={card.id}>
            回原句
          </a>
        )}
      </p>
    </li>
  );
}
