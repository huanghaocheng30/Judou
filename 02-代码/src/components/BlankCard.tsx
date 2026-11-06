/**
 * 空格三段式卡（M2 D7 / AC5）。
 *
 * 三段固定序：**正确答案**（`answerWord` + 词库字母 `answerKey`）/ **为什么是它**（`reason`）/
 * **易错与排除**（`distractors` 拆条后**逐条一行**）。
 *
 * 硬要求：
 * - `blank` 无行 → 只显示「第 N 空」+「暂无预置解析」，**不报错、不留空白卡**；
 * - 容器属性用 **`data-blank-card={blankNo}`**——`data-blank-no` 已被正文空格节点占用，
 *   同名会让 `[data-blank-no="26"]` 匹配到 2 个元素（02 D7 / 评审 N-11）；
 * - `distractors` 的「数组 or 字符串」拆分**只在 `toBlankCard` 里做一次**，组件只渲染 `string[]`。
 */
import type { ReactNode } from "react";
import type { BlankCardModel } from "../lib/analysis";

export interface BlankCardProps {
  card: BlankCardModel;
}

/** 一段：标题 + 内容；内容为空时给「本段暂无解析」而不是留白 */
function Section({ title, children, empty }: { title: string; children?: ReactNode; empty: boolean }) {
  return (
    <section className="blank-section" data-blank-section={title}>
      <h4 className="blank-section-title">{title}</h4>
      {empty ? <p className="segment-empty">本段暂无解析</p> : children}
    </section>
  );
}

export function BlankCard({ card }: BlankCardProps) {
  return (
    <article
      className="analysis-card blank-card"
      data-blank-card={card.blankNo}
      data-blank-empty={card.empty ? "true" : "false"}
    >
      <header className="blank-head">
        <span className="blank-title">第 {card.blankNo} 空</span>
      </header>

      {card.empty ? (
        <p className="segment-empty">暂无预置解析</p>
      ) : (
        <>
          <Section title="正确答案" empty={!card.answerWord && !card.answerKey}>
            <p className="blank-answer">
              {card.answerKey ? <span className="blank-key">{card.answerKey}</span> : null}
              <span className="blank-word">{card.answerWord ?? ""}</span>
            </p>
          </Section>

          <Section title="为什么是它" empty={!card.reason}>
            <p className="blank-reason">{card.reason}</p>
          </Section>

          <Section title="易错与排除" empty={card.distractors.length === 0}>
            <ul className="blank-distractors">
              {card.distractors.map((item, index) => (
                <li key={`distractor-${index}`}>{item}</li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </article>
  );
}
