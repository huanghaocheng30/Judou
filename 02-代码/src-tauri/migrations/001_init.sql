-- 001_init.sql · 句读 schema v1
--
-- 19 张物理表 = 18 张业务表 + 1 张元表（schema_meta）
--   内容 9：article / paragraph / sentence / token / question / blank /
--           sentence_analysis / token_analysis / lexicon
--   用户 8：sentence_note / word_note / vocab_entry / tag / vocab_tag /
--           review_plan / review_log / reading_record
--   配置 1：app_setting      元 1：schema_meta
--
-- 冻结依据：04_产品设计方案-v2.0 §7.1（表清单）/§7.2（三处修订）/§7.3（三处新增列）
--          docs/C2 §4.1~§4.15（15 张宿主表列定义）、05_分模块设计-v2.0 §十七.1（9/8/1 分类）
--
-- 纪律（docs D1 §11.6）：本文件一经发布不得修改，后续结构变更走 002_*.sql。
-- 事务由 db.rs 包裹（不在 SQL 内写 BEGIN/COMMIT，便于迁移框架与 node:sqlite 空跑复用）。

-- ─────────────────────────── 元 ───────────────────────────
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ───────────────────────── 内容 9 张 ─────────────────────────
CREATE TABLE article (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key  TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  source      TEXT,
  -- 04 §7.2 修订 1：区分四级/六级/其他（docs C2 只有 exam_year/exam_set）
  exam_type   TEXT    NOT NULL DEFAULT 'other' CHECK (exam_type IN ('cet4', 'cet6', 'other')),
  exam_year   INTEGER,
  exam_set    TEXT,
  section_type TEXT,
  difficulty  TEXT,
  word_count  INTEGER,
  -- visibility 是历史字段：M11 移除用户导入后恒为 'system'，无业务语义。
  -- 不清理的理由见 M15 任务包 02 §一 B：彻底删需改 Rust 20 处 + 前端 2 处 + 新迁移，收益成本比不成立。
  visibility  TEXT    NOT NULL CHECK (visibility IN ('system', 'user')),
  status      TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE paragraph (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  UNIQUE (article_id, idx)
);

CREATE TABLE sentence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id   INTEGER NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  paragraph_id INTEGER NOT NULL REFERENCES paragraph (id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  text_hash    TEXT    NOT NULL,
  -- 偏移口径：UTF-16 code unit（ADR-008）；相对段落文本
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  UNIQUE (paragraph_id, idx)
);

CREATE TABLE token (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id  INTEGER NOT NULL REFERENCES sentence (id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  surface      TEXT    NOT NULL,
  normalized   TEXT    NOT NULL,
  lemma        TEXT,
  -- 偏移口径：相对句子文本
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  pos          TEXT,
  UNIQUE (sentence_id, idx)
);

CREATE TABLE question (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id   INTEGER NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  stem         TEXT    NOT NULL,
  options_json TEXT,
  answer       TEXT,
  explanation  TEXT,
  UNIQUE (article_id, idx)
);

-- 我方新增（不在 docs C2 的 15 表内）：选词填空逐空解析。
-- 04 §7.4 级联清单未列 article→blank，按「文章子表统一 CASCADE」补齐（02 D2 登记）。
CREATE TABLE blank (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  blank_no    INTEGER NOT NULL,
  answer_key  TEXT,
  answer_word TEXT,
  reason      TEXT,
  distractors TEXT,
  UNIQUE (article_id, blank_no)
);

-- 我方新增：六段式句子解析（1:1 于 sentence）
CREATE TABLE sentence_analysis (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id         INTEGER NOT NULL UNIQUE REFERENCES sentence (id) ON DELETE CASCADE,
  translation_literal TEXT,
  translation_natural TEXT,
  struct_markup       TEXT,
  structure_summary   TEXT,
  paragraph_role      TEXT,
  components_json     TEXT,
  clauses_json        TEXT,
  phrases_json        TEXT,
  pitfalls_json       TEXT
);

-- 我方新增：词级语境解析（1:1 于重点 token）。注意列名是 cet4 不是 cet。
CREATE TABLE token_analysis (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id           INTEGER NOT NULL UNIQUE REFERENCES token (id) ON DELETE CASCADE,
  phonetic           TEXT,
  pos                TEXT,
  sense_in_context   TEXT,
  collocations_json  TEXT,
  examples_json      TEXT,
  is_cet4_high_freq  INTEGER NOT NULL DEFAULT 0,
  more_json          TEXT
);

-- 我方新增：全局词库。按冻结设计（04 §7.3）以 normalized 作主键，无代理 id 列。
CREATE TABLE lexicon (
  normalized         TEXT PRIMARY KEY,
  word               TEXT NOT NULL,
  phonetic           TEXT,
  pos                TEXT,
  sense              TEXT,
  lemma              TEXT,
  collocations_json  TEXT,
  examples_json      TEXT,
  is_cet_high_freq   INTEGER NOT NULL DEFAULT 0,
  more_json          TEXT
);

-- ───────────────────────── 用户 8 张 ─────────────────────────
CREATE TABLE sentence_note (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id  INTEGER NOT NULL UNIQUE REFERENCES sentence (id) ON DELETE CASCADE,
  translation  TEXT,
  grammar_note TEXT,
  phrase_note  TEXT,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE word_note (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id        INTEGER NOT NULL UNIQUE REFERENCES token (id) ON DELETE CASCADE,
  context_meaning TEXT,
  collocation     TEXT,
  example         TEXT,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE vocab_entry (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized         TEXT    NOT NULL UNIQUE,
  surface            TEXT    NOT NULL,
  phonetic           TEXT,
  pos                TEXT,
  context_meaning    TEXT,
  source_sentence_id INTEGER REFERENCES sentence (id) ON DELETE SET NULL,
  source_article_id  INTEGER REFERENCES article (id) ON DELETE SET NULL,
  mastery            TEXT    NOT NULL DEFAULT 'new' CHECK (mastery IN ('new', 'fuzzy', 'known')),
  review_count       INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at   TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tag (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE vocab_tag (
  vocab_id INTEGER NOT NULL REFERENCES vocab_entry (id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
  PRIMARY KEY (vocab_id, tag_id)
);

CREATE TABLE review_plan (
  article_id      INTEGER PRIMARY KEY REFERENCES article (id) ON DELETE CASCADE,
  next_review_at  TEXT    NOT NULL,
  interval_index  INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  updated_at      TEXT    NOT NULL
);

CREATE TABLE review_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id     INTEGER NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  reviewed_at    TEXT    NOT NULL,
  interval_index INTEGER NOT NULL DEFAULT 0,
  result         TEXT    NOT NULL CHECK (result IN ('done', 'need_more'))
);

CREATE TABLE reading_record (
  article_id   INTEGER PRIMARY KEY REFERENCES article (id) ON DELETE CASCADE,
  last_position TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT
);

-- ───────────────────────── 配置 1 张 ─────────────────────────
CREATE TABLE app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ───────────────────────── 索引 ─────────────────────────
-- 02 D2 清单：article 两条（04 §7.2 原口径 + 列表默认分组），其余四条服务精读/生词/复习主查询。
-- ponytail: 只建 M0 已知查询模式的 6 条；docs C2 §5 里 vocab(source_article)/mastery、
-- review_log(article, reviewed_at)、sentence(article_id, paragraph_id, idx) 等
-- 等 M4/M6 的真实查询落地再加（INDEX 可随时补，不涉及数据迁移）。
CREATE INDEX idx_article_exam            ON article (exam_type, exam_year, section_type);
CREATE INDEX idx_article_visibility_list ON article (visibility, exam_type, exam_year, section_type);
CREATE INDEX idx_sentence_paragraph      ON sentence (paragraph_id, idx);
CREATE INDEX idx_token_sentence          ON token (sentence_id, idx);
CREATE INDEX idx_vocab_normalized        ON vocab_entry (normalized);
CREATE INDEX idx_review_plan_due         ON review_plan (status, next_review_at);

-- UNIQUE / PRIMARY KEY 的隐式索引（sentence_analysis.sentence_id、token_analysis.token_id、
-- lexicon.normalized 等）由 SQLite 自动建立，不重复显式建（02 D2 口径）。

-- ───────────────────────── 初始数据 ─────────────────────────
-- 只写默认设置（幂等）；不写任何内容或用户数据。
INSERT OR IGNORE INTO app_setting (key, value) VALUES ('theme', 'system');
INSERT OR IGNORE INTO app_setting (key, value) VALUES ('guide_shown', '0');

-- 迁移版本游标（db.rs 执行完本文件后同样会 upsert；此处给自包含初始值，便于单独空跑校验）
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');
