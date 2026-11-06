/**
 * 笔记编辑器（M2 D8 / AC8）：句子 3 栏 / 词 3 栏，与 `sentence_note` / `word_note` 表结构一一对应。
 *
 * 分层显示（05 §八 规则 4）：**解析区只读**（纸色卡）、**笔记区可编辑**（虚线框 + 「我的笔记」标签），
 * 视觉上区分「内容给的」与「我写的」。
 *
 * 三条纪律：
 * - **flush 唯一路径是 `useDebouncedSave` 的 `targetKey`**（换句/换词先 flush 旧值）；
 *   本组件与 `Reader` 都不另调 `flushNow()`（评审 N2-7，避免双实现）。
 * - **三栏 TRIM 后全空 → 后端 DELETE**（D1 口径），UI 显示「已清空」。
 * - **失败不静默丢**：`data-note-status="error"` + 草稿留在输入框 + 「保存失败，点此重试」；
 *   下次输入会自动重试（`change` 重新排计时器）。
 */
import { useCallback, useEffect, useState } from "react";
import { getSentenceNote, getWordNote, upsertSentenceNote, upsertWordNote } from "../lib/api";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import type { NoteUpsertResult } from "../lib/types";

interface NoteSlot {
  key: string;
  label: string;
  placeholder: string;
}

/** 两套 3 栏（与表结构逐字对应：句子 translation/grammar_note/phrase_note） */
const SLOTS: Record<"sentence" | "word", NoteSlot[]> = {
  sentence: [
    { key: "translation", label: "翻译", placeholder: "这句话的意思…" },
    { key: "grammarNote", label: "语法", placeholder: "语法点 / 句型…" },
    { key: "phraseNote", label: "短语", placeholder: "值得记的短语…" },
  ],
  word: [
    { key: "contextMeaning", label: "语境义", placeholder: "在本句里的意思…" },
    { key: "collocation", label: "搭配", placeholder: "固定搭配…" },
    { key: "example", label: "例句", placeholder: "自己造一句…" },
  ],
};

export interface NoteEditorProps {
  targetKind: "sentence" | "word";
  /** `sentence.id` 或 `token.id` */
  targetId: number;
}

export function NoteEditor({ targetKind, targetId }: NoteEditorProps) {
  const targetKey = `${targetKind}:${targetId}`;
  const config = SLOTS[targetKind];
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // save 只依赖 targetKey 形参（不捕获 targetId）：换目标时 hook 用「旧 key + 旧草稿」调它，
  // 捕获 id 会把旧草稿写进新目标（2026-11-06 CDP 实测缺陷）。
  const save = useCallback(
    (values: string[], key: string): Promise<NoteUpsertResult> => {
      const [kind, rawId] = key.split(":");
      const id = Number(rawId);
      if (!Number.isFinite(id)) return Promise.reject(new Error(`无效的笔记目标：${key}`));
      return kind === "sentence"
        ? upsertSentenceNote(id, values[0] ?? "", values[1] ?? "", values[2] ?? "")
        : upsertWordNote(id, values[0] ?? "", values[1] ?? "", values[2] ?? "");
    },
    [],
  );

  const { values, status, cleared, change, reset, retry } = useDebouncedSave({ targetKey, save });

  // **error 归属**（审查 B-1 / R-1）：hook 的 `status` 已按 targetKey 过滤——别的目标写失败不会显示在
  // 这里；本卡片上的「保存失败，点此重试」永远指向**本目标**的草稿，`retry()` 也只重试本目标的 pending。
  // 换目标时旧的未落库草稿由 hook 的 per-key pending 保留，切回本目标时 `reset()` 会优先用它恢复。

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    const load = async (): Promise<void> => {
      if (targetKind === "sentence") {
        const note = await getSentenceNote(targetId);
        if (cancelled) return;
        reset([note?.translation ?? "", note?.grammarNote ?? "", note?.phraseNote ?? ""]);
      } else {
        const note = await getWordNote(targetId);
        if (cancelled) return;
        reset([note?.contextMeaning ?? "", note?.collocation ?? "", note?.example ?? ""]);
      }
      if (!cancelled) setLoaded(true);
    };
    load().catch((err: unknown) => {
      if (cancelled) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [targetKind, targetId, reset]);

  // 成功不打扰：只有「已清空」这种用户需要知道的结论才显示文字（02 D8）
  const statusText = loadError ? "读不到笔记" : status === "saving" ? "保存中…" : status === "saved" && cleared ? "已清空" : null;

  return (
    <section className="note-editor" data-note-editor data-note-status={status} data-note-target={targetKey}>
      <header className="note-head">
        <span className="note-label">我的笔记</span>
        <span className="note-status" aria-live="polite">
          {statusText}
        </span>
      </header>

      {config.map((slot, index) => (
        <label className="note-field" key={slot.key}>
          <span className="note-field-label">{slot.label}</span>
          <textarea
            className="note-input"
            value={values[index] ?? ""}
            onChange={(event) => change(index, event.target.value)}
            placeholder={slot.placeholder}
            rows={2}
            data-note-slot={slot.key}
            disabled={!loaded && !loadError}
          />
        </label>
      ))}

      {status === "error" ? (
        <p className="note-error" role="alert">
          <span>保存失败，草稿已保留。</span>
          <button type="button" className="link-btn" onClick={retry} data-note-retry>
            点此重试
          </button>
        </p>
      ) : null}
    </section>
  );
}
