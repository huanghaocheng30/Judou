/**
 * 占位页共用壳：M0 不写内容逻辑，8 页统一显示「本页将在 Mx 接入」。
 * M1~M6 逐个替换成真实页面时，删掉对应页对本组件的引用即可。
 */
import type { ReactNode } from "react";

export interface PagePlaceholderProps {
  /** 页面标题（与 Topbar 标题一致） */
  title: string;
  /** 一句话说明这页将来做什么 */
  summary: string;
  /** 接入里程碑（M1~M6） */
  milestone: string;
  /** 可选的补充条目（如空态规划、关键交互） */
  bullets?: ReactNode[];
}

export function PagePlaceholder({ title, summary, milestone, bullets = [] }: PagePlaceholderProps) {
  return (
    <section className="placeholder" aria-labelledby="placeholder-title">
      <p className="placeholder-kicker">骨架占位</p>
      <h2 id="placeholder-title">{title}</h2>
      <p className="placeholder-summary">{summary}</p>
      <p className="placeholder-milestone">
        <span className="tag">{milestone}</span> 接入
      </p>
      {bullets.length > 0 && (
        <ul className="placeholder-list">
          {bullets.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
      <p className="placeholder-note">内容导入与解析将在 M1 起逐个接入；本包（M0）只交付可启动的壳。</p>
    </section>
  );
}
