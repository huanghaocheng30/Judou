-- 003_answer_source.sql · 句读 schema v3（M5c：题目只对齐不生成，记答案来源）
--
-- 纪律（docs D1 §11.6）：001 / 002 已发布，一字节不改；本文件只做「加法」——
-- 只有 ALTER TABLE ... ADD COLUMN，不删列、不改列、不动索引、不建表（表数仍 19）。
--
-- 这一列的理由（04 §6.2 第 3 步 / 05 §十一之三 约束 9）：
--   档 C 的题目只能对齐用户给的，不许 AI 生成。用户给了答案 → 'user'；
--   AI 补的 → 'ai'（界面标「AI 补的答案」，供用户核对）；都没有 → 'none'。
--   缺这一列，补全解析写过来的题会被当成「有答案」而看不出是谁给的。
--
-- 幂等不在 SQL 里做：SQLite 没有 `ADD COLUMN IF NOT EXISTS`，纯 SQL 写不出条件 DDL。
-- 幂等由 db.rs 的版本游标保证（`if *version <= current { continue }`，这是本次迁移编号
-- 必须为 3 而不是复用 2 的原因——复用 2 会被游标整条跳过，列永远加不上）。
-- DEFAULT 'none' 让既有行有确定值，不需要额外回填。

ALTER TABLE question ADD COLUMN answer_source TEXT NOT NULL DEFAULT 'none';
