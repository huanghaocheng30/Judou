-- 002_add_import_columns.sql · 句读 schema v2（M1 导入所需三列）
--
-- 纪律（docs D1 §11.6）：001_init.sql 已发布，一字节不改；本文件只做「加法」——
-- 只有 ALTER TABLE ... ADD COLUMN，不删列、不改列、不动索引、不建表。
--
-- 三列的三条理由（02 D1）：
--   1. token.is_word        —— 空格判定必须用内容包权威 isWord 落库。
--      用 normalized 推导会把选词填空的空格 token（surface="26"）判成词，30 个空格全丢。
--   2. article.pack_version —— 内容包版本要可按篇追溯（manifest.packVersion 是唯一权威，
--      篇内残留 packVersion 不入库）。
--   3. article.sentence_count —— 文章库卡片第五项字段，取冗余列避免列表页 N+1。
--
-- 版本游标不在这里写：db.rs 在迁移提交时统一 UPDATE schema_meta.version（与 001 同口径）。
-- DEFAULT 1/0 让既有行有确定值（001 已发布的库升级时不需要额外回填）。

ALTER TABLE token   ADD COLUMN is_word        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE article ADD COLUMN pack_version   TEXT;
ALTER TABLE article ADD COLUMN sentence_count INTEGER NOT NULL DEFAULT 0;
