/**
 * 设置页（M6 D5 / AC8·AC9·AC10 · 第五轮 ONB）：
 * ① 主题三档（写 app_setting.theme，立即生效）② 复习间隔**只读**展示 `1/3/7/14`
 * ③ 备份 / 恢复（恢复前自动备份，坏文件不破坏现库）④ 入门任务清单（可重置）⑤ 关于四项。
 *
 * 全部经 src/lib/api.ts；主题状态经 ThemeProvider（不在页面里另存一份）。
 * 第五轮变更：原「重新查看引导」三屏卡（说明式，无引导作用）删除，改为可勾选的入门任务清单。
 */
import { useEffect, useRef, useState } from "react";
import {
  backupDb,
  checkUpdate,
  exportVocabHtml,
  exportVocabSheet,
  ping,
  restoreDb,
} from "../lib/api";
import { THEME_LABELS, THEME_SETTINGS, type ThemeSetting } from "../lib/theme";
import { Onboarding } from "../components/Onboarding";
import { useTheme } from "../shell/ThemeProvider";

/** 复习间隔默认档（docs C2 §4.15 review_intervals 默认 [1,3,7,14]）——本页**只读** */
const DEFAULT_INTERVALS = [1, 3, 7, 14];

/** PDF 词表三模式（互斥单选，对齐后端 `SheetMode`） */
type SheetMode = "a4" | "zh" | "en";

const SHEET_MODES: { mode: SheetMode; title: string; hint: string }[] = [
  { mode: "a4", title: "A4 默写", hint: "左栏单词、右栏释义，各自独立编号；遮一半即可双向默写" },
  { mode: "zh", title: "中文词表", hint: "Word 列留空、Meaning 填释义；看中文默写单词" },
  { mode: "en", title: "英文词表", hint: "Word 填单词、Meaning 留空；看单词默写释义" },
];

export function Settings() {
  const { setting, resolved, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState<string>("—");
  const [busy, setBusy] = useState<"none" | "backup" | "restore" | "export" | "sheet">("none");
  const [note, setNote] = useState<string | null>(null);
  const [restorePath, setRestorePath] = useState("");
  const [sheetMode, setSheetMode] = useState<SheetMode>("a4");
  const [sheetShuffle, setSheetShuffle] = useState(false);
  // 第五轮：A4 默写默认附「答案对照」节（自查用，打印后可折起）；关掉则不出该节
  const [sheetAnswer, setSheetAnswer] = useState(true);
  // M7 · 检查更新三态（AC7）：有新版 / 已是最新 / 检查失败。失败**不带技术详情**。
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateNote, setUpdateNote] = useState<{
    kind: "available" | "latest" | "failed";
    text: string;
    url?: string;
  } | null>(null);
  /** DB-M6-6：从生词本「导出词表」跳来的落点高亮（只亮 2.4s，随后恢复常态） */
  const [exportFocus, setExportFocus] = useState(false);
  const exportCardRef = useRef<HTMLElement | null>(null);

  // DB-M6-6：`#/settings?focus=export` → 滚到「导出 PDF 词表」卡片并描边高亮。
  // 只读查询串、不改路由；没有该参数（常规进设置页）时什么都不做。
  useEffect(() => {
    const raw = window.location.hash;
    const queryAt = raw.indexOf("?");
    if (queryAt < 0) return;
    if (new URLSearchParams(raw.slice(queryAt + 1)).get("focus") !== "export") return;
    setExportFocus(true);
    exportCardRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const timer = window.setTimeout(() => setExportFocus(false), 2400);
    return () => window.clearTimeout(timer);
  }, []);

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

  /**
   * PDF 词表：后端返回完整 HTML → 隐藏 iframe 写入 → `contentWindow.print()` 调起系统打印。
   * Tauri webview 会拦 `window.open`，所以走 iframe 这条路；保存 PDF 交给打印对话框。
   */
  const runExportSheet = () => {
    setBusy("sheet");
    setNote(null);
    exportVocabSheet(sheetMode, sheetShuffle, sheetAnswer)
      .then((html) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.title = "生词词表打印";
        frame.style.position = "fixed";
        frame.style.right = "0";
        frame.style.bottom = "0";
        frame.style.width = "0";
        frame.style.height = "0";
        frame.style.border = "0";
        document.body.appendChild(frame);
        const doc = frame.contentDocument;
        if (!doc) {
          frame.remove();
          setNote("打开打印文档失败：取不到 iframe 文档。");
          return;
        }
        doc.open();
        doc.write(html);
        doc.close();
        // 等一帧让排版与字体落定，否则打印预览可能是空白页
        window.setTimeout(() => {
          const view = frame.contentWindow;
          view?.focus();
          view?.print();
          // 打印对话框是模态的；关闭后由浏览器异步回收，留足时间再摘掉节点
          window.setTimeout(() => frame.remove(), 60000);
        }, 80);
        setNote("已调起打印对话框：在「打印机」里选「Microsoft Print to PDF」或「另存为 PDF」即可保存。");
      })
      .catch((err: unknown) => setNote(`导出失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy("none"));
  };

  /**
   * 检查更新（M7 · AC7）：`check_update` 本身**永不 reject**（后端降级成 `available:false`），
   * 所以这里的 catch 只兜 IPC 层异常（命令未注册 / 窗口未就绪）。
   * 三态文案与 `data-check-update-result` 取值一一对应，CDP 按属性值断言。
   */
  const runCheckUpdate = () => {
    setUpdateBusy(true);
    setUpdateNote(null);
    checkUpdate()
      .then((result) => {
        if (result.available && result.version) {
          setUpdateNote({
            kind: "available",
            text: `有新版本 v${result.version}`,
            url: result.url ?? undefined,
          });
        } else if (result.reason === "offline") {
          // 读不到/读坏了 manifest：如实报失败，**不能**折叠成「已是最新」误导用户（AC7 第三态）
          setUpdateNote({ kind: "failed", text: "检查失败，稍后再试" });
        } else {
          // up-to-date / no-manifest：没有更新清单即视为无新版可提示
          setUpdateNote({ kind: "latest", text: "已是最新版本" });
        }
      })
      .catch(() => setUpdateNote({ kind: "failed", text: "检查失败，稍后再试" }))
      .finally(() => setUpdateBusy(false));
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

      <section
        className={exportFocus ? "card card-focus" : "card"}
        aria-labelledby="sheet-title"
        data-export-focus={exportFocus ? "on" : "off"}
        ref={exportCardRef}
      >
        <h2 id="sheet-title">导出 PDF 词表</h2>
        <p className="card-hint">
          打印用。选一种模式 → 点「导出 PDF 词表」→ 在打印对话框里选「另存为 PDF」。
        </p>
        <div className="export-modes" role="radiogroup" aria-label="词表模式（三选一）">
          {SHEET_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="radio"
              aria-checked={sheetMode === item.mode}
              className={sheetMode === item.mode ? "export-mode on" : "export-mode"}
              data-export-mode={item.mode}
              onClick={() => setSheetMode(item.mode)}
            >
              <span className="export-mode-title">{item.title}</span>
              <span className="export-mode-hint">{item.hint}</span>
            </button>
          ))}
        </div>
        <label className="shuffle-line">
          <input
            type="checkbox"
            data-export-shuffle
            checked={sheetShuffle}
            onChange={(event) => setSheetShuffle(event.target.checked)}
          />
          乱序导出（打乱词序，避免按顺序背）
        </label>
        <label className="shuffle-line">
          <input
            type="checkbox"
            data-export-answer
            checked={sheetAnswer}
            onChange={(event) => setSheetAnswer(event.target.checked)}
          />
          附答案对照（A4 默写专用：词表末尾给「Word —— 释义」小字对照，自查后折起或裁掉）
        </label>
        <div className="btn-row">
          <button type="button" className="btn" data-export-pdf disabled={busy !== "none"} onClick={runExportSheet}>
            导出 PDF 词表
          </button>
        </div>
        <p className="card-hint">
          A4 竖版、每页重复表头、行首带勾选框供打印后手打勾；中文/英文词表每页 30 词，A4 默写每页 15 词。
        </p>
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

      <section className="card" aria-labelledby="onboarding-title" data-onboarding-section>
        <h2 id="onboarding-title">入门任务</h2>
        <p className="card-hint">
          三项任务做完全自动打勾（按你的真实使用判定）。想再走一遍就点「重新开始入门任务」。
        </p>
        <Onboarding variant="settings" />
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
        <div className="btn-row">
          <button type="button" className="btn" data-check-update disabled={updateBusy} onClick={runCheckUpdate}>
            {updateBusy ? "检查中…" : "检查更新"}
          </button>
          {updateNote && (
            <span className="card-hint" data-check-update-result={updateNote.kind} role="status">
              {updateNote.text}
              {updateNote.url && (
                <>
                  {"（"}
                  <a
                    href={updateNote.url}
                    data-check-update-link
                    title={updateNote.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    下载页
                  </a>
                  {"）"}
                </>
              )}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
