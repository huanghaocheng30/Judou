/**
 * 设置页（M6 D5 / AC8·AC9·AC10·AC11）：
 * ① 主题三档（写 app_setting.theme，立即生效）② 复习间隔**只读**展示 `1/3/7/14`
 * ③ 备份 / 恢复（恢复前自动备份，坏文件不破坏现库）④ 重新查看引导 ⑤ 关于四项。
 *
 * 全部经 src/lib/api.ts；主题状态经 ThemeProvider（不在页面里另存一份）。
 */
import { useEffect, useState } from "react";
import {
  backupDb,
  exportVocabHtml,
  ping,
  restoreDb,
  setSetting,
} from "../lib/api";
import { THEME_LABELS, THEME_SETTINGS, type ThemeSetting } from "../lib/theme";
import { useTheme } from "../shell/ThemeProvider";

/** 复习间隔默认档（docs C2 §4.15 review_intervals 默认 [1,3,7,14]）——本页**只读** */
const DEFAULT_INTERVALS = [1, 3, 7, 14];

/** 与 Guide.tsx 共用的事件名（设置页只是「重新打开引导」的触发器） */
const SHOW_GUIDE_EVENT = "judou:show-guide";

export function Settings() {
  const { setting, resolved, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState<string>("—");
  const [busy, setBusy] = useState<"none" | "backup" | "restore" | "export">("none");
  const [note, setNote] = useState<string | null>(null);
  const [restorePath, setRestorePath] = useState("");

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

  const runBackup = () => {
    setBusy("backup");
    setNote(null);
    backupDb()
      .then((result) => setNote(`已备份到 ${result.dbPath}（schema v${result.schemaVersion}）`))
      .catch((err: unknown) => setNote(`备份失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy("none"));
  };

  const runRestore = () => {
    if (!restorePath.trim()) {
      setNote("请先填写备份文件（.db）的完整路径");
      return;
    }
    setBusy("restore");
    setNote(null);
    restoreDb(restorePath.trim())
      .then((result) => {
        const diff = result.diff.length === 0 ? "各表计数与恢复前一致" : `差异：${result.diff.join("；")}`;
        setNote(`已从备份恢复；恢复前已自动备份到 ${result.preBackupPath}；${diff}`);
      })
      .catch((err: unknown) => setNote(`恢复失败（当前库未被改动）：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy("none"));
  };

  const runExport = () => {
    setBusy("export");
    setNote(null);
    exportVocabHtml()
      .then((result) => setNote(`已导出 ${result.count} 个生词到 ${result.path}`))
      .catch((err: unknown) => setNote(`导出失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy("none"));
  };

  const reopenGuide = () => {
    setSetting("guide_shown", "0")
      .then(() => {
        window.dispatchEvent(new CustomEvent(SHOW_GUIDE_EVENT));
        setNote("引导已重新打开");
      })
      .catch((err: unknown) => setNote(`打开引导失败：${err instanceof Error ? err.message : String(err)}`));
  };

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
              data-theme-option={option}
              onClick={() => setTheme(option)}
            >
              {THEME_LABELS[option]}
            </button>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="interval-title">
        <h2 id="interval-title">复习间隔</h2>
        <p className="card-hint">只读展示；间隔档位固定，应用不提供修改入口。</p>
        <ul className="interval-list" data-review-intervals>
          {DEFAULT_INTERVALS.map((days, index) => (
            <li key={days} data-interval-days={days}>
              <span className="interval-index">第 {index + 1} 档</span>
              <span>{days} 天</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="backup-title">
        <h2 id="backup-title">导出、备份与恢复</h2>
        <p className="card-hint">
          生词可导出为单文件 HTML（离线可看）；备份是本地库副本；恢复前会**自动先备份当前库**。
        </p>
        <div className="btn-row">
          <button type="button" className="btn" data-export-vocab disabled={busy !== "none"} onClick={runExport}>
            导出生词 HTML
          </button>
          <button type="button" className="btn" data-backup disabled={busy !== "none"} onClick={runBackup}>
            备份本地库
          </button>
        </div>
        <label className="field-label" htmlFor="restore-path">
          恢复：粘贴备份文件完整路径
        </label>
        <div className="btn-row">
          <input
            id="restore-path"
            className="text-input"
            data-restore-path
            value={restorePath}
            placeholder="C:\\Users\\你\\…\\judou-backup-20261107-1730.db"
            onChange={(event) => setRestorePath(event.target.value)}
          />
          <button type="button" className="btn" data-restore disabled={busy !== "none"} onClick={runRestore}>
            从备份恢复
          </button>
        </div>
        {note && (
          <p className="card-hint" data-settings-note role="status">
            {note}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="guide-title">
        <h2 id="guide-title">引导</h2>
        <p className="card-hint">忘了怎么用？可以再走一遍三屏说明。</p>
        <button type="button" className="btn" data-reopen-guide onClick={reopenGuide}>
          重新查看引导
        </button>
      </section>

      <section className="card about" aria-labelledby="about-title" data-about>
        <h2 id="about-title">关于</h2>
        <dl className="about-list">
          <div>
            <dt>版本</dt>
            <dd data-about-version>v{appVersion}</dd>
          </div>
          <div>
            <dt>License</dt>
            <dd data-about-license>MIT（应用代码）</dd>
          </div>
          <div>
            <dt>免责声明</dt>
            <dd data-about-disclaimer>
              本应用仅供个人学习使用，不对考试结果作任何承诺；解析为辅助理解材料，遇争议以原文与官方答案为准。
            </dd>
          </div>
          <div>
            <dt>内容来源</dt>
            <dd data-about-source>
              内置篇目取自 CET4/CET6 公开真题（版权归原出处），解析与译文为学习用途的二次整理；用户导入内容的权利与责任归导入者。
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
