/**
 * 三态词卡（M2 D6 / AC4）。
 *
 * 硬要求：
 * - **三态只看 `pickWordCard` 的 `mode`**（组件不二次判定——02 风险表「组件里再判一次三态」）：
 *   `context` 显语境义 / `generic` 标题改「词义（通用）」/ `none` 显「暂无预置解析」，不留空白卡；
 * - `more`（词根 / 近义 / 易混）**默认折叠**、点「更多」展开（原生 `<details>`，不自造折叠组件）；
 * - 音标 / 词性 / 搭配 / 例句**按字段有无渲染**——字段空就不渲染那一行（不留空标签）；
 * - **不放收藏按钮**（连禁用态也不放，收藏归 M3——05 §六 规则 4 与 02 决策 #15）；
 * - 产出 `data-word-mode`（`context`/`generic`/`none`，供断言）与 `data-word-more`。
 *
 * 归一纪律：列表字段（collocations/examples/more.*）的「数组 or 字符串」归一**只在
 * `pickWordCard` 里做一次**（`normalizeList` 唯一来源），组件只渲染 `string[]`。
 */
import type { WordCardMore, WordCardModel } from "../lib/analysis";

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

export interface WordCardProps {
  card: WordCardModel;
}

export function WordCard({ card }: WordCardProps) {
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
    </article>
  );
}
