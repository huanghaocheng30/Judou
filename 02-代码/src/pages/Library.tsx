/**
 * 文章库（M1 / 04 §八 第 2 行）：两分组 + 四类筛选 + 标题搜索 + 等卡片网格。
 *
 * 硬要求（AC5）：
 * - 两分组：内置（`visibility='system'`）/ 我导入的（`user`）；**两种空态分开**——
 *   ① 分组里一篇都没有 → 引导「去导入」；② 有材料但筛选没命中 → 「试试放宽条件 + 清除筛选」。
 * - 四类筛选（考试类型/年份/题型/来源）：组间 AND、同组多选 OR —— 筛选下推到 SQL（不是前端过滤）。
 * - 卡片五项字段：篇名 / 年份 / 题型 / 词数 / 句数。
 * - 筛选与搜索**写进 URL query**：刷新/返回保持（`#/library?vis=system&exam=cet4&…`）。
 * - 键盘可达：卡片 `role="link"` + `tabIndex=0` + Enter 进入。
 *
 * ponytail: 筛选用原生 button/chip（不是自定义下拉，避免焦点陷阱）；URL 用 `replaceState` 写，
 * 不产生历史条目（否则每点一次筛选就多一条 back 目标，返回键会退很多次）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listArticleFilterOptions, listArticles } from "../lib/api";
import { ArticleEditor } from "../components/ArticleEditor";
import type { ArticleFilter, ArticleSummary, FilterOptions } from "../lib/types";
import { parseHash, rememberLibraryQuery } from "../shell/routes";

/** 考试类型显示名（`exam_type` 是 cet4/cet6/other 枚举） */
const EXAM_LABELS: Record<string, string> = { cet4: "CET-4", cet6: "CET-6", other: "其他" };
/**
 * 题型显示名：**只用于筛选按钮**——卡片上的题型取后端 `sectionLabel`（内容包 manifest 的权威展示名）。
 * ponytail: 这张 3 行表先放前端；等它出现第二处消费者（导出/复习列表）再收进后端。
 */
const SECTION_LABELS: Record<string, string> = { careful: "仔细阅读", long: "长篇阅读", cloze: "选词填空" };

/** 页面状态：与 URL query 一一对应（`vis` / `exam` / `year` / `sec` / `src` / `q`） */
interface LibraryState {
  vis: string;
  exams: string[];
  years: string[];
  sections: string[];
  sources: string[];
  q: string;
}

function fromQuery(query: URLSearchParams): LibraryState {
  return {
    vis: query.get("vis") === "user" ? "user" : "system",
    exams: query.getAll("exam"),
    // 手改 URL 时 `?year=abc` 不能静默变成「选中的筛选不生效」：非数字年份直接丢弃
    years: query.getAll("year").filter((value) => /^\d+$/.test(value)),
    sections: query.getAll("sec"),
    sources: query.getAll("src"),
    q: query.get("q") ?? "",
  };
}

/** 状态 → 查询串（顺序固定，便于断言与阅读：vis, exam, year, sec, src, q） */
function toQueryString(state: LibraryState): string {
  const query = new URLSearchParams();
  query.set("vis", state.vis);
  state.exams.forEach((value) => query.append("exam", value));
  state.years.forEach((value) => query.append("year", value));
  state.sections.forEach((value) => query.append("sec", value));
  state.sources.forEach((value) => query.append("src", value));
  if (state.q.trim()) query.set("q", state.q.trim());
  return query.toString();
}

function buildFilter(state: LibraryState): ArticleFilter {
  const years = state.years.map(Number).filter((value) => Number.isFinite(value));
  return {
    visibility: state.vis,
    examTypes: state.exams,
    years,
    sectionTypes: state.sections,
    sources: state.sources,
    keyword: state.q.trim() || undefined,
  };
}

export function Library() {
  const [state, setState] = useState<LibraryState>(() => fromQuery(parseHash(window.location.hash).query));
  const [items, setItems] = useState<ArticleSummary[]>([]);
  const [groupTotal, setGroupTotal] = useState(0);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** M5c D4/D5：正在编辑的文章（null = 面板关闭） */
  const [editing, setEditing] = useState<ArticleSummary | null>(null);
  /** 搜索框即时输入（防抖 250ms 后才落到 state.q 与 URL） */
  const [keywordInput, setKeywordInput] = useState(state.q);
  const debounceRef = useRef<number | null>(null);

  const queryString = useMemo(() => toQueryString(state), [state]);

  // 状态变化 → 写回 URL（replaceState：不产生历史条目，但刷新/返回都能带回）
  useEffect(() => {
    const nextHash = `#/library?${queryString}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }, [queryString]);

  // 反向同步：浏览器前进/后退或用户手改 URL 时，**adopt** 新 query 重新筛。
  // （页面自己改 URL 走 replaceState，不触发 hashchange，所以这里不会自激）
  useEffect(() => {
    const onHashChange = () => {
      const next = fromQuery(parseHash(window.location.hash).query);
      setState((prev) => (toQueryString(prev) === toQueryString(next) ? prev : next));
      setKeywordInput(next.q);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // 筛选选项只取一次（内置包导入后不再变化）
  useEffect(() => {
    let cancelled = false;
    listArticleFilterOptions()
      .then((value) => {
        if (!cancelled) setOptions(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn("读取筛选选项失败", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 列表 + 分组总数（后者用来区分「分组空」与「筛选没命中」两种空态）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([listArticles(buildFilter(state)), listArticles({ visibility: state.vis })])
      .then(([list, group]) => {
        if (cancelled) return;
        setItems(list);
        setGroupTotal(group.length);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  const update = useCallback((patch: Partial<LibraryState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggle = useCallback((key: "exams" | "years" | "sections" | "sources", value: string) => {
    setState((prev) => {
      const list = prev[key];
      return { ...prev, [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] };
    });
  }, []);

  const onKeywordChange = useCallback(
    (value: string) => {
      setKeywordInput(value);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        update({ q: value });
      }, 250);
    },
    [update],
  );

  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [],
  );

  const clearFilters = useCallback(() => {
    // 先撤掉在途的搜索防抖：否则 250ms 后它会把旧关键词写回 state.q，让「清除筛选」看起来失效
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setKeywordInput("");
    setState({ vis: state.vis, exams: [], years: [], sections: [], sources: [], q: "" });
  }, [state.vis]);

  const openArticle = useCallback(
    (articleId: number) => {
      // 离开列表页前记住筛选（返回时带回，AC7）
      rememberLibraryQuery(queryString);
      window.location.hash = `#/article/${articleId}`;
    },
    [queryString],
  );

  const isFiltered =
    state.exams.length > 0 || state.years.length > 0 || state.sections.length > 0 || state.sources.length > 0 || state.q.trim() !== "";

  return (
    <section className="library">
      <div className="library-toolbar">
        <div className="tabs" role="tablist" aria-label="文章分组">
          <button
            type="button"
            role="tab"
            aria-selected={state.vis !== "user"}
            className={state.vis !== "user" ? "tab on" : "tab"}
            data-testid="tab-system"
            onClick={() => update({ vis: "system" })}
          >
            内置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state.vis === "user"}
            className={state.vis === "user" ? "tab on" : "tab"}
            data-testid="tab-user"
            onClick={() => update({ vis: "user" })}
          >
            我导入的
          </button>
        </div>

        <input
          className="search"
          type="search"
          value={keywordInput}
          placeholder="搜索标题…"
          aria-label="按标题搜索"
          data-testid="library-search"
          onChange={(event) => onKeywordChange(event.target.value)}
        />
      </div>

      <div className="filters">
        {options && options.examTypes.length > 0 && (
          <div className="filter-row" data-testid="filter-exam">
            <span className="filter-label">考试类型</span>
            <div className="chips">
              {options.examTypes.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={state.exams.includes(value) ? "chip on" : "chip"}
                  aria-pressed={state.exams.includes(value)}
                  data-value={value}
                  onClick={() => toggle("exams", value)}
                >
                  {EXAM_LABELS[value] ?? value.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        {options && options.years.length > 0 && (
          <div className="filter-row" data-testid="filter-year">
            <span className="filter-label">年份</span>
            <div className="chips">
              {options.years.map((value) => {
                const text = String(value);
                return (
                  <button
                    key={text}
                    type="button"
                    className={state.years.includes(text) ? "chip on" : "chip"}
                    aria-pressed={state.years.includes(text)}
                    data-value={text}
                    onClick={() => toggle("years", text)}
                  >
                    {text} 年
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {options && options.sectionTypes.length > 0 && (
          <div className="filter-row" data-testid="filter-section">
            <span className="filter-label">题型</span>
            <div className="chips">
              {options.sectionTypes.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={state.sections.includes(value) ? "chip on" : "chip"}
                  aria-pressed={state.sections.includes(value)}
                  data-value={value}
                  onClick={() => toggle("sections", value)}
                >
                  {SECTION_LABELS[value] ?? value}
                </button>
              ))}
            </div>
          </div>
        )}

        {options && options.sources.length > 0 && (
          <div className="filter-row" data-testid="filter-source">
            <span className="filter-label">来源</span>
            <div className="chips">
              {options.sources.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={state.sources.includes(value) ? "chip on" : "chip"}
                  aria-pressed={state.sources.includes(value)}
                  data-value={value}
                  onClick={() => toggle("sources", value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="library-count" data-testid="library-count">
        {loading ? "读取中…" : `共 ${items.length} 篇`}
      </p>

      {error && (
        <p className="library-error" role="alert">
          读取文章失败：{error}
        </p>
      )}

      {!loading && !error && groupTotal === 0 && (
        <div className="empty" data-testid="library-empty-group">
          <p>{state.vis === "user" ? "还没有导入材料。" : "内置内容包没有可显示的文章。"}</p>
          {state.vis === "user" && (
            <a className="btn" href="#/import" data-testid="library-empty-group-action">
              去导入
            </a>
          )}
        </div>
      )}

      {!loading && !error && groupTotal > 0 && items.length === 0 && (
        <div className="empty" data-testid="library-empty-filter">
          <p>没有符合当前筛选的文章，试试放宽条件。</p>
          <button type="button" className="btn" onClick={clearFilters} data-testid="library-clear-filters">
            清除筛选
          </button>
        </div>
      )}

      {!error && items.length > 0 && (
        <div className="article-grid">
          {items.map((item) => (
            <article
              key={item.id}
              className="card article-card"
              role="link"
              tabIndex={0}
              data-testid="article-card"
              data-article-id={item.id}
              data-title={item.title}
              data-year={item.examYear ?? ""}
              data-section={item.sectionLabel ?? ""}
              data-words={item.wordCount ?? ""}
              data-sentences={item.sentenceCount}
              onClick={() => openArticle(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openArticle(item.id);
                }
              }}
            >
              <h3 className="article-title">{item.title}</h3>
              <p className="article-meta">
                <span className="tag">{item.sectionLabel ?? "未分类"}</span>
                <span>{item.examYear ?? "—"} 年</span>
                <span>{item.wordCount ?? "—"} 词</span>
                <span>{item.sentenceCount} 句</span>
              </p>
              <p className="article-source">{item.source ?? ""}</p>
              {/* M5b D4：「补解析」入口（AC9）。停在卡片内部，**必须 stopPropagation**，
                  否则点它会连带触发卡片的「进精读」点击。 */}
              <p className="article-actions">
                <a
                  className="link-btn"
                  data-ai-patch
                  data-article-id={item.id}
                  href={`#/import?articleId=${item.id}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  补全解析
                </a>
                {/* M5c D4：编辑入口（AC9）→ 打开 ArticleEditor；同样 stopPropagation 挡住「进精读」 */}
                <button
                  type="button"
                  className="link-btn"
                  data-article-edit
                  data-article-id={item.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditing(item);
                  }}
                >
                  编辑
                </button>
              </p>
            </article>
          ))}
        </div>
      )}

      {/* M5c D5：编辑面板（元信息 + 题目）；保存后只回填列表里的标题，不重拉全表 */}
      {editing !== null && (
        <ArticleEditor
          articleId={editing.id}
          initialTitle={editing.title}
          initialExamYear={editing.examYear ?? null}
          initialSectionLabel={editing.sectionLabel ?? null}
          onClose={() => setEditing(null)}
          onSaved={({ title }) => {
            setItems((rows) => rows.map((row) => (row.id === editing.id ? { ...row, title } : row)));
            setEditing((current) => (current === null ? null : { ...current, title }));
          }}
        />
      )}

      {!loading && !error && items.length > 0 && isFiltered && (
        <p className="library-hint">
          <button type="button" className="link-btn" onClick={clearFilters}>
            清除筛选
          </button>
        </p>
      )}
    </section>
  );
}
