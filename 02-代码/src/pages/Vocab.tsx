/**
 * 生词本（M3 D3 骨架 + D4 编辑/移出接线）：三轴切换 / 筛选 / 搜索 / 分组列表 / 两种空态 / 行内编辑与移出。
 *
 * 已做：
 * - 三轴切换（按文章 / 按标签 / 按掌握状态），分组与排序全在纯函数层 `lib/vocab.ts`（AC3）；
 * - 筛选：掌握状态单选、标签多选（AND）、关键词（不区分大小写，匹配 `normalized` 与 `surface`）；
 * - 条目渲染：原词 + 音标 + 词性 + 语境义 + **文字优先**的掌握状态 + 标签 chips + 来源文章标题 +「回原句」；
 * - 两种空态：一篇生词都没有（`data-vocab-empty="all"`）/ 有但筛选没命中（`"filtered"`）+ 一键清除筛选；
 * - **D4 编辑**：`VocabEditor` 展开编辑 4 字段 + 标签；**D4 移出**：行内轻量二次确认（不弹原生 `confirm`）。
 *
 * 保存/删除后的刷新路径（评审 N-6，写死两条一起走）：
 * `onSaved(updated)` → **就地替换该行**（立刻看到新值，不等重拉）+ **重拉 `list_vocab` 与 `list_tags`**
 * ——标签变化会改变「按标签」轴的归属、也可能新增全库标签，只替换行会让分组与筛选 chips 失真。
 *
 * 属性契约（02 §三 D3/D4，**已冻结**）：`data-vocab-count` / `data-vocab-group` / `data-vocab-row` /
 * `data-vocab-empty`；掌握状态另有 `data-vocab-mastery`（值即 `new`/`fuzzy`/`known`）；
 * 编辑入口 `data-vocab-edit`、移出 `data-vocab-remove`、编辑器容器 `data-vocab-editor`。
 * **不得**用 `data-has-note` 表达收藏态（那是 M2 笔记态，TP-修复1 §S-R1-1）。
 *
 * ponytail: 不引路由/状态库、不做虚拟滚动——生词量级「百~千」，直接全量渲染分组列表；
 * 上千后再按 `groupVocab` 的组边界做 `content-visibility` 或分页（命令已包一层 `entries`，加分页字段不改契约）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { VocabEditor } from "../components/VocabEditor";
import { deleteVocab, listTags, listVocab } from "../lib/api";
import type { Tag, VocabEntry } from "../lib/types";
import {
  MASTERY_LABELS,
  MASTERY_ORDER,
  describeCommandError,
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

export function Vocab() {
  const [rows, setRows] = useState<VocabEntry[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [axis, setAxis] = useState<VocabGroupBy>("article");
  const [filter, setFilter] = useState<VocabFilter>(emptyFilter);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑的条目 id（同一时刻只开一个编辑面板——多个编辑器会让「保存哪个」变歧义） */
  const [editingId, setEditingId] = useState<number | null>(null);

  // 列表与标签各一次 IPC（并发）：标签 chips 要的是全库标签，不是本页出现过的标签
  const reload = useCallback(async (): Promise<void> => {
    const [list, tagList] = await Promise.all([listVocab(), listTags()]);
    setRows(list.entries);
    setTags(tagList);
  }, []);

  useEffect(() => {
    let cancelled = false;
    reload()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeCommandError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

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

  /** 编辑保存成功：先就地替换（立刻看到新值），再重拉（标签变化影响分组与筛选 chips） */
  const handleSaved = (updated: VocabEntry): void => {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
    setEditingId(null);
    reload().catch((err: unknown) => setError(describeCommandError(err)));
  };

  /** 移出成功：本地先摘掉（立刻消失），再重拉（组内计数与空组过滤跟着变） */
  const handleRemoved = (id: number): void => {
    setRows((current) => current.filter((row) => row.id !== id));
    reload().catch((err: unknown) => setError(describeCommandError(err)));
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

        {/*
          DB-M6-6：导出入口（**只做入口，不复制导出逻辑**）。导出仍只有设置页那一份实现，
          这里只是把人送到 #/settings?focus=export，由设置页滚动并高亮「导出 PDF 词表」卡片。
          用查询串而不是 `#/settings#export`：自写 hash 路由只有一个 `#`，第二个 `#` 会污染 path。
        */}
        <button
          type="button"
          className="btn"
          data-vocab-export
          title="去设置页导出词表（PDF 词表 / 生词 HTML）"
          onClick={() => {
            window.location.hash = "#/settings?focus=export";
          }}
        >
          导出词表
        </button>
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
        <div className="empty" data-vocab-empty="all" data-empty-vocab>
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
              <VocabRow
                key={`${group.key}-${row.id}`}
                row={row}
                editing={editingId === row.id}
                onEdit={() => setEditingId(row.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={handleSaved}
                onRemoved={handleRemoved}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

interface VocabRowProps {
  row: VocabEntry;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (updated: VocabEntry) => void;
  onRemoved: (id: number) => void;
}

/**
 * 单条生词：显示态只吃 `toCardModel` 的结果（取字段/拼标签/算链接都在纯函数层，便于直测）；
 * 编辑态整块换成 `VocabEditor`（不做「显示 + 展开」双份，避免同一字段两处渲染不一致）。
 */
function VocabRow({ row, editing, onEdit, onCancelEdit, onSaved, onRemoved }: VocabRowProps) {
  const card = toCardModel(row);
  /** 轻量二次确认（02 D3：不弹原生 `confirm`——它会阻塞整页且样式不可控） */
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleRemove = (): void => {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    void deleteVocab(row.id)
      .then(() => onRemoved(row.id))
      .catch((err: unknown) => setRemoveError(describeCommandError(err)))
      .finally(() => setRemoving(false));
  };

  if (editing) {
    return (
      <li className="vocab-row" data-vocab-row={card.id} data-vocab-mastery={card.mastery}>
        <VocabEditor entry={row} onCancel={onCancelEdit} onSaved={onSaved} />
      </li>
    );
  }

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

      <div className="vocab-actions">
        <button type="button" className="link-btn" onClick={onEdit} data-vocab-edit={card.id}>
          编辑
        </button>
        {confirming ? (
          <>
            <span className="vocab-confirm">移出后不可恢复（标签会保留）</span>
            <button type="button" className="link-btn" onClick={handleRemove} data-vocab-remove-confirm={card.id}>
              {removing ? "移出中…" : "确定移出"}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => setConfirming(false)}
              data-vocab-remove-cancel={card.id}
            >
              取消
            </button>
          </>
        ) : (
          <button type="button" className="link-btn" onClick={() => setConfirming(true)} data-vocab-remove={card.id}>
            移出
          </button>
        )}
        {removeError !== null && (
          <span className="vocab-remove-error" role="alert">
            移出失败：{removeError}
          </span>
        )}
      </div>
    </li>
  );
}
