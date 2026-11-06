/**
 * 生词条目编辑面板（M3 D4 / AC4 / AC7）。
 *
 * 只做表结构里有的字段（01 §四 冲突 1 的裁定）：**语境义 / 音标 / 词性 / 掌握状态 + 标签**。
 * 不为「搭配 · 例句」加列，也不把它们塞进 `context_meaning`——那两样在词维度由 `word_note` 承载。
 *
 * 硬要求：
 * - 掌握状态三档 `新词 / 模糊 / 已掌握`：**文字就是按钮本身**，颜色只是强化（AC7 / 决策 #5）；
 * - 标签编辑：输入框 **Enter 添加**、chip 上 **× 删除**、**Esc 取消当前输入**（不动已加的 chip）；
 * - **保存失败保留输入 + 提示重试**（沿用 M2 笔记失败的教训，绝不静默丢用户刚敲的字）；
 * - 保存分两步（都是幂等写）：`update_vocab` 四字段 → `set_vocab_tags` **全量替换**；
 *   两个都成功才算保存成功——半成功会让「界面上有标签、库里没有」。
 *
 * 刷新路径（评审 N-6，写死）：本组件只调 `onSaved(updated)`，由 `Vocab.tsx` 负责
 * 「就地替换该行 + 重拉 `list_vocab`」（标签变化会改变分组归属，只替换行会让分组失真）。
 *
 * 属性契约：容器 `data-vocab-editor="<id>"`、三档按钮 `data-mastery="new|fuzzy|known"`。
 *
 * ponytail: 不引表单库、不做字段级校验（DB 侧 mastery 有 CHECK，文本列接受任意字符串）；
 * 标签输入不做「联想下拉」（全库标签已作为筛选 chips 展示，编辑时手打更直接）。
 */
import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { setVocabTags, updateVocab } from "../lib/api";
import type { VocabEntry } from "../lib/types";
import {
  MASTERY_LABELS,
  MASTERY_ORDER,
  describeCommandError,
  normalizeTagNames,
  type Mastery,
} from "../lib/vocab";

export interface VocabEditorProps {
  /** 正在编辑的条目（初始值来源） */
  entry: VocabEntry;
  /** 取消：丢弃本次输入，回到列表 */
  onCancel: () => void;
  /** 保存成功：`updated` 是后端回读的最新行（已带新标签名） */
  onSaved: (updated: VocabEntry) => void;
}

export function VocabEditor({ entry, onCancel, onSaved }: VocabEditorProps) {
  // 4 个可编辑字段：用 raw 输入（不 trim），清空语义交给后端（空白 → NULL，与笔记同口径）
  const [contextMeaning, setContextMeaning] = useState(entry.contextMeaning ?? "");
  const [phonetic, setPhonetic] = useState(entry.phonetic ?? "");
  const [pos, setPos] = useState(entry.pos ?? "");
  const [mastery, setMastery] = useState<Mastery>(
    MASTERY_ORDER.includes(entry.mastery as Mastery) ? (entry.mastery as Mastery) : "new",
  );
  const [tagNames, setTagNames] = useState<string[]>(entry.tagNames);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTag = (): void => {
    // 复用 `lib/vocab.ts` 的归一（与 Rust 侧 `normalize_tag_names` 同口径）：trim → 去空 → 去重
    const [name] = normalizeTagNames([tagInput]);
    if (name === undefined) return;
    setTagNames((current) => (current.includes(name) ? current : [...current, name]));
    setTagInput("");
  };

  const removeTag = (name: string): void => {
    setTagNames((current) => current.filter((item) => item !== name));
  };

  /**
   * 标签输入框的键盘出口：Enter 提交、**Esc 只清当前输入**。
   * Esc 不再向上传（`preventDefault`）：编辑面板不归 `AnalysisPanel` 的 Esc 关闭逻辑管，
   * 但生词本页将来若加页面级 Esc 处理，这里先吃掉更安全（用户意图是「取消这行字」）。
   */
  const onTagKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setTagInput("");
    }
  };

  const handleSave = (): void => {
    if (saving) return;
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const updated = await updateVocab(entry.id, { contextMeaning, phonetic, pos, mastery });
        const tags = await setVocabTags(entry.id, normalizeTagNames(tagNames));
        onSaved({ ...updated, tagNames: tags.map((tag) => tag.name) });
      } catch (err) {
        // 输入**原样保留**（用户不用重打）：只加错误提示，重试即再点一次保存
        setError(describeCommandError(err));
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <div className="vocab-editor" data-vocab-editor={entry.id}>
      <p className="vocab-editor-head">
        编辑「{entry.surface}」
        <span className="vocab-editor-hint">只改释义与标注，原词与来源不动</span>
      </p>

      <label className="vocab-field">
        <span className="vocab-field-label">语境义</span>
        <textarea
          className="note-input vocab-field-input"
          rows={2}
          value={contextMeaning}
          placeholder="这个词在这句里的意思…"
          data-vocab-field="contextMeaning"
          onChange={(event) => setContextMeaning(event.target.value)}
        />
      </label>

      <div className="vocab-field-row">
        <label className="vocab-field vocab-field-half">
          <span className="vocab-field-label">音标</span>
          <input
            className="note-input vocab-field-input"
            value={phonetic}
            placeholder="/prəˈvoʊk/"
            data-vocab-field="phonetic"
            onChange={(event) => setPhonetic(event.target.value)}
          />
        </label>
        <label className="vocab-field vocab-field-half">
          <span className="vocab-field-label">词性</span>
          <input
            className="note-input vocab-field-input"
            value={pos}
            placeholder="v. / n. / adj."
            data-vocab-field="pos"
            onChange={(event) => setPos(event.target.value)}
          />
        </label>
      </div>

      <div className="vocab-field">
        <span className="vocab-field-label">掌握状态</span>
        {/* 文字就是按钮本身：三档名字始终可见，颜色（.on）只是辅助（AC7 颜色非唯一通道） */}
        <div className="mastery-pick" role="group" aria-label="掌握状态">
          {MASTERY_ORDER.map((value) => (
            <button
              key={value}
              type="button"
              className={mastery === value ? "mastery-option on" : "mastery-option"}
              data-mastery={value}
              aria-pressed={mastery === value}
              onClick={() => setMastery(value)}
            >
              {MASTERY_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="vocab-field">
        <span className="vocab-field-label">标签</span>
        <ul className="tag-chips">
          {tagNames.map((name) => (
            <li className="tag-chip" key={name} data-editor-tag={name}>
              {name}
              <button
                type="button"
                className="tag-remove"
                aria-label={`删除标签 ${name}`}
                data-editor-tag-remove={name}
                onClick={() => removeTag(name)}
              >
                ×
              </button>
            </li>
          ))}
          {tagNames.length === 0 && <li className="tag-empty">还没有标签</li>}
        </ul>
        <input
          className="note-input tag-input"
          value={tagInput}
          placeholder="输入标签，回车添加，Esc 取消"
          aria-label="添加标签"
          data-editor-tag-input
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={onTagKeyDown}
        />
      </div>

      {error !== null && (
        <p className="vocab-editor-error" role="alert" data-vocab-editor-error>
          保存失败：{error}（输入已保留，请重试）
        </p>
      )}

      <div className="vocab-editor-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave} data-vocab-save>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" className="btn" onClick={onCancel} data-vocab-cancel>
          取消
        </button>
      </div>
    </div>
  );
}
