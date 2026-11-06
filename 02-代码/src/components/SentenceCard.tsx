/**
 * 六段式句子卡（M2 D5 / AC2 / AC3）。
 *
 * 硬要求：
 * - **卡顶先重述被点的原句**（06 #6「旁批先重述该句」）：`text` 由 `Reader` 随选中态传入，
 *   截断到合理长度、超长可展开（决策记录 #23 / 评审 N2-4——不新增第二套取数路径）；
 * - **段序固定**：由 `SENTENCE_SEGMENT_ORDER` 唯一决定（组件与门禁共用一份常量）；
 * - **默认展开 ①②、其余折叠**：用原生 `<details>`，不自造折叠组件；
 * - **②段内部顺序：先符号句（`structMarkup`）后成分表（`structure`）**（评审 N2-5）；
 * - 符号句走 `parseMarkup` → `<mark class="mk-*" data-mark-kind="*">`；`【】{}()` 原样保留；
 * - 该段对应字段为空 → 「本段暂无解析」，不空白、不报错。
 */
import { useEffect, useState } from "react";
import { SENTENCE_SEGMENT_ORDER, parseMarkup } from "../lib/analysis";
import type { SentenceCardModel, SentenceSegmentKey } from "../lib/analysis";

/** 六段标题（顺序不在这里决定，只给文案） */
const SEGMENT_TITLES: Record<SentenceSegmentKey, string> = {
  translation: "① 翻译",
  structure: "② 主干与成分划分",
  clauses: "③ 从句与语法点",
  phrases: "④ 重点短语",
  pitfalls: "⑤ 易错点",
  paragraphRole: "⑥ 段落作用",
};

/** 默认展开的段：①②（02 D5 / AC2） */
const DEFAULT_OPEN: ReadonlySet<SentenceSegmentKey> = new Set<SentenceSegmentKey>(["translation", "structure"]);

/** 卡顶原句超过这个长度就折叠（英文正文 66ch 约两行的量） */
const QUOTE_LIMIT = 140;

export interface SentenceCardProps {
  card: SentenceCardModel;
  /** 被点的原句：`Reader` 从 `ApiSentence.text` 填入 */
  text?: string;
}

/** 符号句：逐 part 输出 `<mark>`（`【】{}()` 已在 `parseMarkup` 内保形） */
function StructMarkup({ markup }: { markup: string }) {
  const parts = parseMarkup(markup);
  return (
    <p className="struct-markup" data-struct-markup>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <mark key={index} className={`mk mk-${part.kind}`} data-mark-kind={part.kind}>
            {part.text}
          </mark>
        ),
      )}
    </p>
  );
}

function SegmentBody({ segment, card }: { segment: SentenceSegmentKey; card: SentenceCardModel }) {
  if (card.emptyFlags[segment]) {
    return <p className="segment-empty">本段暂无解析</p>;
  }

  switch (segment) {
    case "translation":
      return <p className="segment-text segment-lines">{card.translation}</p>;
    case "structure":
      return (
        <>
          {card.structMarkup ? <StructMarkup markup={card.structMarkup} /> : null}
          {card.structure.summary ? <p className="segment-text">{card.structure.summary}</p> : null}
          {card.structure.components.length > 0 ? (
            <table className="components">
              <thead>
                <tr>
                  <th scope="col">成分</th>
                  <th scope="col">作用</th>
                  <th scope="col">说明</th>
                </tr>
              </thead>
              <tbody>
                {card.structure.components.map((row, index) => (
                  <tr key={`${row.part}-${index}`}>
                    <td className="components-part">{row.part}</td>
                    <td className="components-role">{row.role}</td>
                    <td className="components-note">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      );
    case "clauses":
      return (
        <ul className="segment-list">
          {card.clauses.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "phrases":
      return (
        <ul className="segment-list">
          {card.phrases.map((phrase, index) => (
            <li key={`${phrase.text}-${index}`}>
              <b className="phrase-text">{phrase.text}</b>
              {phrase.meaning ? <span className="phrase-meaning">：{phrase.meaning}</span> : null}
              {phrase.usage ? <span className="phrase-usage">{phrase.usage}</span> : null}
              {phrase.example ? <span className="phrase-example">例：{phrase.example}</span> : null}
            </li>
          ))}
        </ul>
      );
    case "pitfalls":
      return (
        <ul className="segment-list">
          {card.pitfalls.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "paragraphRole":
      return <p className="segment-text">{card.paragraphRole}</p>;
    default: {
      // 穷尽性检查：新增段时这里会编译失败（而不是静默渲染空段）
      const exhaustive: never = segment;
      return <p className="segment-empty">{String(exhaustive)}</p>;
    }
  }
}

export function SentenceCard({ card, text }: SentenceCardProps) {
  // 整篇无预置解析：卡头给一句明确的降级，而不是露出六个「本段暂无解析」
  const noAnalysis = SENTENCE_SEGMENT_ORDER.every((segment) => card.emptyFlags[segment]);
  // 原句是否展开（TP-修复2 F2）：只存组件内、不持久化（02 §F2「不持久化，换句即复位」）；短句恒 false
  const [expanded, setExpanded] = useState(false);
  const long = (text?.length ?? 0) > QUOTE_LIMIT;

  // 换句必须复位：本组件在 AnalysisPanel 里不随句子重挂载（同一实例换 props），
  // 只靠 key 复位不可靠，所以在原句变化时显式收起。
  // ponytail: 只依赖 text。同一句重复点选（text 不变）保留展开态——那是同一句，保留才不突兀；
  // 若日后要「点同一句也回折叠」，升级路径是把复位键换成 card 身份或句子 idx 依赖。
  useEffect(() => {
    setExpanded(false);
  }, [text]);

  return (
    <article className="analysis-card sentence-card" data-sentence-card data-card-empty={noAnalysis ? "true" : "false"}>
      {text ? (
        <header className="card-quote">
          <span className="card-quote-label">原句</span>
          {/* TP-修复2 F2（M3-U2）：原句**只渲染一份**（`[data-quote-text]`）。
              折叠语义是「同一段文字的高度收放」，不是「截断预览 + 全文并列」——
              旧的 details/summary 拿截断版当标题、展开后追加完整版，同一句出现两份 DOM。 */}
          <div className="card-quote-body" data-quote-clamped={long && !expanded ? "true" : "false"}>
            <p className="card-quote-text" data-quote-text>
              {text}
            </p>
          </div>
          {long ? (
            <button type="button" className="card-quote-toggle" data-quote-toggle onClick={() => setExpanded((v) => !v)}>
              {expanded ? "收起" : "展开全文"}
            </button>
          ) : null}
        </header>
      ) : null}

      {noAnalysis ? <p className="card-no-analysis">该篇无预置解析，可写笔记</p> : null}

      {SENTENCE_SEGMENT_ORDER.map((segment) => (
        <details
          key={segment}
          className={`segment segment-${segment}`}
          open={DEFAULT_OPEN.has(segment)}
          data-segment={segment}
          data-segment-empty={card.emptyFlags[segment] ? "true" : "false"}
        >
          <summary className="segment-title">{SEGMENT_TITLES[segment]}</summary>
          <div className="segment-body">
            <SegmentBody segment={segment} card={card} />
          </div>
        </details>
      ))}
    </article>
  );
}
