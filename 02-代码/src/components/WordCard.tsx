/**
 * 三态词卡（M2 D6 / AC4；M3 D5 加「加入生词本」）。
 *
 * 硬要求：
 * - **三态只看 `pickWordCard` 的 `mode`**（组件不二次判定——02 风险表「组件里再判一次三态」）：
 *   `context` 显语境义 / `generic` 标题改「词义（通用）」/ `none` 显「暂无预置解析」，不留空白卡；
 * - `more`（词根 / 近义 / 易混）**默认折叠**、点「更多」展开（原生 `<details>`，不自造折叠组件）；
 * - 音标 / 词性 / 搭配 / 例句**按字段有无渲染**——字段空就不渲染那一行（不留空标签）；
 * - **收藏按钮的数据由 `AnalysisPanel` 经 `vocab` prop 下发**（M3 D5 / 评审 B-2）：
 *   `WordCard` **不自取数、不查库**——它拿不到 `normalized`（`WordCardModel` 没有该字段，
 *   `none` 态 `headword` 还是 null），收藏态的唯一持有者是 `AnalysisPanel`；
 * - 收藏态**一律 `data-vocab-state="none|added"`**，**不得复用 `data-has-note`**
 *   （那个已被 TP-修复1 用于「句/词有笔记」，混用会让两套语义互相污染）；
 * - **不放灰色禁用按钮**（M2 立下的规矩）：未收藏就是可点的「加入生词本」，
 *   已收藏就是「已在生词本 + 移出」（用户误收藏必须能就地撤销）；
 * - 产出 `data-word-mode`（`context`/`generic`/`none`，供断言）与 `data-word-more`。
 *
 * 归一纪律：列表字段（collocations/examples/more.*）的「数组 or 字符串」归一**只在
 * `pickWordCard` 里做一次**（`normalizeList` 唯一来源），组件只渲染 `string[]`。
 */
import type { WordCardMore, WordCardModel } from "../lib/analysis";

/** 收藏态两值（02 D5；**不是**三态，没有 loading 之外的中间态） */
export type VocabState = "none" | "added";

/**
 * 收藏区契约（由 `AnalysisPanel` 填充）：`normalized` 为 null 时不渲染收藏区
 * （防御：拿不到聚合键就无从收藏，宁可不显示也不显示一个点了没用的按钮）。
 */
export interface WordCardVocab {
  normalized: string | null;
  vocabState: VocabState;
  /** 一次操作在途：**不置灰**，点击直接忽略（重复点击不会发两次 IPC） */
  busy?: boolean;
  /** 上一次操作失败的原因（显示在收藏区内，按钮仍可再点） */
  error?: string | null;
  onAdd?: () => void;
  onRemove?: () => void;
}

/** 词典例：「搭配」一条一行 */
function ListBlock({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="word-row">
      <span className="word-row-label">{label}</span>
      <ul className="word-list">
        {items.map((item, index) => (
          <li key={`${label}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function MoreSection({ more }: { more: WordCardMore }) {
  const groups: Array<{ key: string; label: string; items: string[] }> = [
    { key: "roots", label: "词根", items: more.roots },
    { key: "synonyms", label: "近义", items: more.synonyms },
    { key: "confusables", label: "易混", items: more.confusables },
  ];
  const hasAny = groups.some((group) => group.items.length > 0);
  if (!hasAny) return null;
  return (
    <details className="word-more" data-word-more>
      <summary className="word-more-summary">更多</summary>
      <div className="word-more-body">
        {groups.map((group) =>
          group.items.length ? <ListBlock key={group.key} label={group.label} items={group.items} /> : null,
        )}
      </div>
    </details>
  );
}

/**
 * 收藏区：`stopPropagation` 是防御性的——词卡本身不在句子节点里，但词卡将来若被嵌进可点容器，
 * 这一行能保证「点收藏不触发句子卡」（AC7 不误触），成本只有一行。
 */
function VocabBlock({ vocab }: { vocab: WordCardVocab }) {
  const added = vocab.vocabState === "added";
  return (
    <div className="word-vocab" data-vocab-state={vocab.vocabState}>
      {added ? (
        <>
          <span className="word-vocab-flag">已在生词本</span>
          <button
            type="button"
            className="link-btn"
            data-vocab-remove
            onClick={(event) => {
              event.stopPropagation();
              if (vocab.busy) return;
              vocab.onRemove?.();
            }}
          >
            移出
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn word-vocab-add"
          data-vocab-add
          onClick={(event) => {
            event.stopPropagation();
            if (vocab.busy) return;
            vocab.onAdd?.();
          }}
        >
          加入生词本
        </button>
      )}
      {vocab.error ? (
        <span className="word-vocab-error" role="alert">
          收藏失败：{vocab.error}（可再试一次）
        </span>
      ) : null}
    </div>
  );
}

export interface WordCardProps {
  card: WordCardModel;
  /** 收藏区（M3 D5）：不传则不渲染收藏按钮（M2 的既有调用点与断言不受影响） */
  vocab?: WordCardVocab;
}

export function WordCard({ card, vocab }: WordCardProps) {
  const modeLabel = card.mode === "context" ? "语境义" : card.mode === "generic" ? "词义（通用）" : null;

  return (
    <article className="analysis-card word-card" data-word-card data-word-mode={card.mode}>
      <header className="word-head">
        <span className="word-headword">{card.headword ?? "（本词）"}</span>
        {card.phonetic ? <span className="word-phonetic">{card.phonetic}</span> : null}
        {card.pos ? <span className="word-pos">{card.pos}</span> : null}
        {card.isCetHighFreq ? <span className="word-freq">四级高频</span> : null}
      </header>

      {card.mode === "none" || !card.sense ? (
        <p className="segment-empty">暂无预置解析</p>
      ) : (
        <>
          {modeLabel ? <p className="word-mode-label">{modeLabel}</p> : null}
          <p className="word-sense">{card.sense}</p>
          <ListBlock label="搭配" items={card.collocations} />
          <ListBlock label="例句" items={card.examples} />
          {card.more ? <MoreSection more={card.more} /> : null}
        </>
      )}

      {/* 收藏区放在卡片末尾：不打断「先看释义」的阅读顺序，也与 `none` 态并存（AC2 无解析也能收藏） */}
      {vocab && vocab.normalized ? <VocabBlock vocab={vocab} /> : null}
    </article>
  );
}
