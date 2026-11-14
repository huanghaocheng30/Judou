#!/usr/bin/env node
/**
 * 临时库构造器（M16 D4）：在**进程内**建一个 `:memory:` 库，跑真迁移 SQL，可选把内置 content-pack 灌进去。
 *
 * 为什么不再读 `%APPDATA%\com.judou.app\judou.db`：
 *   那三个门禁（verify-render / verify-analysis / check-tables）验的是「schema 与内容包形状」，
 *   不是「用户机器上那份库的当前状态」。读运行期库导致它们**必须先启动过一次应用**才绿——
 *   于是要么在干净机器上红（假失败），要么为了绿去造库（假证据）。改成自建库后：
 *   迁移 SQL 有没有坏、内容包能不能被同一套列映射吃下，都是脚本自己的事，与运行时数据无关。
 *
 * 权威口径来源（逐条对齐，不新发明）：
 *   - 迁移游标：`src-tauri/src/db.rs` `migrate()` —— 按 `schema_meta.version` 逐条 exec + upsert
 *   - 列映射：`src-tauri/src/import.rs` `write_article()` / `write_lexicon()`
 *     （含 `normalized` 回落 `surface`、`word` 取首次出现 surface、cloze 的 `question.explanation`
 *     投影自 `blank.reason`、`distractors` 的 string/list 两形态）
 *
 * 用法：
 *   const { openTempPackDb } = await import("./lib/temp-pack-db.mjs");
 *   const db = openTempPackDb({ withContent: true });   // 自动删库：进程退出即随内存释放
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packDir = path.join(root, "content-pack");
const migrationsDir = path.join(root, "src-tauri", "migrations");

/** 与 db.rs MIGRATIONS 同序同源（版本号必须与文件名前缀一致） */
const MIGRATIONS = [
  [1, "001_init.sql"],
  [2, "002_add_import_columns.sql"],
  [3, "003_answer_source.sql"],
];

/** 跑迁移：逐条 exec + 写回 schema_meta.version（db.rs migrate() 的 JS 版） */
function migrate(db) {
  const hasMeta = db
    .prepare("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta') AS e")
    .get().e;
  const current = hasMeta
    ? Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value ?? 0)
    : 0;
  for (const [version, file] of MIGRATIONS) {
    if (version <= current) continue;
    db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(version));
  }
}

const sha256Short = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const jsonOrNull = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const moreJson = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
/** pack.rs `Distractors::to_stored`：字符串原样，数组存 JSON */
const distractorsStored = (value) =>
  value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value);

/** `article.source`（import.rs `article_source`） */
function articleSource(article, examMonth) {
  const level = [...article.examType].filter((ch) => ch >= "0" && ch <= "9").join("");
  const prefix = level ? `CET-${level}` : article.examType.toUpperCase();
  if (article.examYear === undefined || article.examYear === null) return `${prefix} 真题`;
  if (examMonth === undefined || examMonth === null) return `${prefix} ${article.examYear}年真题`;
  return `${prefix} ${article.examYear}年${examMonth}月真题`;
}

/** 词库 `word` 列 = 该 normalized **首次出现**的 surface（先到优先，不覆盖） */
function firstSurfaces(pack) {
  const map = new Map();
  for (const paragraph of pack.paragraphs ?? []) {
    for (const sentence of paragraph.sentences ?? []) {
      for (const token of sentence.tokens ?? []) {
        if (token.normalized && !map.has(token.normalized)) map.set(token.normalized, token.surface);
      }
    }
  }
  return map;
}

/** 灌内置内容包：按 manifest 顺序（article id 顺序 = 应用首启导入顺序） */
function importPack(db) {
  const manifest = JSON.parse(readFileSync(path.join(packDir, "manifest.json"), "utf8"));
  const stArticle = db.prepare(
    `INSERT INTO article (source_key, title, source, exam_type, exam_year, exam_set, section_type,
       word_count, visibility, sentence_count, pack_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?)`,
  );
  const stParagraph = db.prepare("INSERT INTO paragraph (article_id, idx, text) VALUES (?, ?, ?)");
  const stSentence = db.prepare(
    "INSERT INTO sentence (article_id, paragraph_id, idx, text, text_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const stToken = db.prepare(
    "INSERT INTO token (sentence_id, idx, surface, normalized, is_word, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const stSentenceAnalysis = db.prepare(
    `INSERT INTO sentence_analysis (sentence_id, translation_literal, translation_natural, struct_markup,
       structure_summary, paragraph_role, components_json, clauses_json, phrases_json, pitfalls_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stTokenAnalysis = db.prepare(
    `INSERT INTO token_analysis (token_id, phonetic, pos, sense_in_context, collocations_json, examples_json,
       is_cet4_high_freq, more_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stQuestion = db.prepare(
    "INSERT INTO question (article_id, idx, stem, options_json, answer, explanation) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const stBlank = db.prepare(
    "INSERT INTO blank (article_id, blank_no, answer_key, answer_word, reason, distractors) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // 词库跨篇共享 normalized：后到的篇只更新释义列，**不覆盖 word**（首次出现优先，同 import.rs）
  const stLexicon = db.prepare(
    `INSERT INTO lexicon (normalized, word, phonetic, pos, sense, lemma, collocations_json, examples_json,
       is_cet_high_freq, more_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(normalized) DO UPDATE SET
       phonetic = excluded.phonetic, pos = excluded.pos, sense = excluded.sense, lemma = excluded.lemma,
       collocations_json = excluded.collocations_json, examples_json = excluded.examples_json,
       is_cet_high_freq = excluded.is_cet_high_freq, more_json = excluded.more_json`,
  );

  for (const article of manifest.articles) {
    const pack = JSON.parse(readFileSync(path.join(packDir, article.file), "utf8"));
    const meta = pack.meta ?? {};
    const articleId = stArticle.run(
      pack.sourceKey,
      article.title,
      articleSource(article, meta.examMonth),
      article.examType,
      article.examYear,
      article.examSet === undefined || article.examSet === null ? null : String(article.examSet),
      article.sectionType,
      article.wordCount ?? null,
      article.sentenceCount,
      manifest.packVersion,
    ).lastInsertRowid;

    for (const paragraph of pack.paragraphs ?? []) {
      const paragraphId = stParagraph.run(articleId, paragraph.idx, paragraph.text).lastInsertRowid;
      for (const sentence of paragraph.sentences ?? []) {
        const sentenceId = stSentence.run(
          articleId,
          paragraphId,
          sentence.idx,
          sentence.text,
          sha256Short(sentence.text),
          sentence.start,
          sentence.end,
        ).lastInsertRowid;
        if (sentence.analysis) {
          const a = sentence.analysis;
          stSentenceAnalysis.run(
            sentenceId,
            a.translationLiteral ?? null,
            a.translationNatural ?? null,
            a.structMarkup ?? null,
            a.structureSummary ?? null,
            a.paragraphRole ?? null,
            jsonOrNull(a.components),
            jsonOrNull(a.clauses),
            jsonOrNull(a.phrases),
            jsonOrNull(a.pitfalls),
          );
        }
        for (const [index, token] of (sentence.tokens ?? []).entries()) {
          // 非词 token 的 normalized 在包里是 null，列是 NOT NULL → 回落 surface（同 import.rs）
          const tokenId = stToken.run(
            sentenceId,
            index,
            token.surface,
            token.normalized ?? token.surface,
            token.isWord ? 1 : 0,
            token.start,
            token.end,
          ).lastInsertRowid;
          if (token.analysis) {
            const t = token.analysis;
            stTokenAnalysis.run(
              tokenId,
              t.phonetic ?? null,
              t.pos ?? null,
              t.senseInContext ?? null,
              jsonOrNull(t.collocations),
              jsonOrNull(t.examples),
              t.isCet4HighFreq ? 1 : 0,
              moreJson(t.more),
            );
          }
        }
      }
    }

    for (const question of pack.questions ?? []) {
      const blank = pack.blanks?.[String(question.no)];
      stQuestion.run(
        articleId,
        question.no,
        question.stem,
        JSON.stringify(question.options ?? []),
        question.answer ?? null,
        // explanation 是 cloze 篇 blank.reason 的投影；无对应空格的篇写空串（05 §二 L76）
        blank?.reason ?? "",
      );
    }

    for (const blankNo of pack.blankNos ?? []) {
      const blank = pack.blanks?.[String(blankNo)];
      stBlank.run(
        articleId,
        blankNo,
        blank?.answerKey ?? null,
        blank?.answerWord ?? null,
        blank?.reason ?? null,
        distractorsStored(blank?.distractors),
      );
    }

    const surfaces = firstSurfaces(pack);
    for (const [normalized, entry] of Object.entries(pack.lexicon ?? {})) {
      stLexicon.run(
        normalized,
        surfaces.get(normalized) ?? normalized,
        entry.phonetic ?? null,
        entry.pos ?? null,
        entry.sense ?? null,
        entry.lemma ?? null,
        jsonOrNull(entry.collocations),
        jsonOrNull(entry.examples),
        entry.isCet4HighFreq ? 1 : 0,
        moreJson(entry.more),
      );
    }
  }

  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('pack_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(manifest.packVersion);
  return manifest.articles.length;
}

/**
 * 建临时库（`：memory:`，进程退出即释放；不需要清理临时文件）。
 * @param {{ withContent?: boolean }} options 是否把 content-pack 灌进去（check-tables 只需 schema）
 */
export function openTempPackDb({ withContent = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  if (withContent) importPack(db);
  return db;
}

export const packRoot = packDir;
