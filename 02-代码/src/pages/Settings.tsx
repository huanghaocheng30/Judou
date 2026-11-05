/**
 * 设置页：M0 唯一有真实内容的页面。
 * ① 主题三档（写 app_setting.theme，立即生效）② 复习间隔只读展示 ③ 备份恢复占位 ④ 关于区。
 * 全部经 src/lib/api.ts；主题状态经 ThemeProvider（不在页面里另存一份）。
 */
import { useEffect, useState } from "react";
import { ping } from "../lib/api";
import { THEME_LABELS, THEME_SETTINGS, type ThemeSetting } from "../lib/theme";
import { useTheme } from "../shell/ThemeProvider";

/** 复习间隔默认档（docs C2 §4.15 review_intervals 默认 [1,3,7,14]；M3 接入可编辑） */
const DEFAULT_INTERVALS = [1, 3, 7, 14];

export function Settings() {
  const { setting, resolved, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState<string>("—");

  useEffect(() => {
    let cancelled = false;
    ping()
      .then((result) => {
        if (!cancelled) setAppVersion(result.appVersion);
      })
      .catch(() => {
        if (!cancelled) setAppVersion("未知（ping 失败）");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings">
      <section className="card" aria-labelledby="theme-title">
        <h2 id="theme-title">主题</h2>
        <p className="card-hint">
          选择会写入本地设置并立即生效；当前实际渲染：{resolved === "dark" ? "深色" : "浅色"}。
        </p>
        <div className="segmented" role="group" aria-label="主题三档">
          {THEME_SETTINGS.map((option: ThemeSetting) => (
            <button
              key={option}
              type="button"
              className={setting === option ? "seg on" : "seg"}
              aria-pressed={setting === option}
              onClick={() => setTheme(option)}
            >
              {THEME_LABELS[option]}
            </button>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="interval-title">
        <h2 id="interval-title">复习间隔</h2>
        <p className="card-hint">只读展示；编辑与「按遗忘曲线微调」在 M3 接入。</p>
        <ul className="interval-list">
          {DEFAULT_INTERVALS.map((days, index) => (
            <li key={days}>
              <span className="interval-index">第 {index + 1} 档</span>
              <span>{days} 天</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="backup-title">
        <h2 id="backup-title">备份与恢复</h2>
        <p className="card-hint">M6 接入：导出/导入本地库文件，导入前校验 schema 版本。</p>
        <button type="button" className="btn" disabled>
          导出备份（M6）
        </button>
      </section>

      <section className="card about" aria-labelledby="about-title">
        <h2 id="about-title">关于</h2>
        <dl className="about-list">
          <div>
            <dt>版本</dt>
            <dd>v{appVersion}</dd>
          </div>
          <div>
            <dt>License</dt>
            <dd>待定（M7 发布前确定）</dd>
          </div>
          <div>
            <dt>内容说明</dt>
            <dd>内置文章仅用于 CET4/CET6 阅读精读练习，版权归原出处；解析为学习用途的二次整理。</dd>
          </div>
          <div>
            <dt>数据</dt>
            <dd>全部数据保存在本机，无网络请求、无上传。</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
