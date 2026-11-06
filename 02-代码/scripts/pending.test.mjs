/**
 * AC8 断言（node --test）：M2 两条债务的纯函数载体（M3 D7 / 评审 B-3）。
 *
 * 直接 import `src/lib/pending.ts`（Node 24 类型擦除，无需构建），不引测试框架、不引 jsdom。
 * 每条的「红」端是真实跑出来的：`pending.ts` 先以**旧语义快照**落盘（无条件 delete / 无上限），
 * 本文件对着它失败 3 条；替换成正确实现后全绿。红绿两次输出都进了执行自测证据。
 *
 * 判据口径（与 `useDebouncedSave.ts` 的调用点一致）：
 * - D-M2-11：成功回调必须比「手上这份草稿」与「Map 里当前那份」是否同一份（引用相等）；
 * - D-M2-12：Map 保插入序，超出上限淘汰最旧，**活跃 key 不淘汰**（正在编辑的那条不能被挤掉）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PENDING_DRAFT_LIMIT, evictIfOverLimit, shouldDeletePending } from "../src/lib/pending.ts";

// ───────────────── D-M2-11：成功回调的条件删除 ─────────────────

test("D-M2-11：同 key 已有更新草稿时，旧草稿的完成回调不得删掉 pending", () => {
  const map = new Map();
  const oldDraft = ["第一版", "", ""];
  const newDraft = ["第二版", "", ""];
  // 用户在旧草稿保存期间又敲了一版 → pending 被覆盖成新草稿
  map.set("sentence:12", newDraft);
  // 旧草稿的保存此刻才返回成功，回调拿着 oldDraft 来问「要不要删」
  assert.equal(
    shouldDeletePending(map, "sentence:12", oldDraft),
    false,
    "旧草稿的成功回调不得删掉新草稿（否则新草稿静默丢失，D-M2-11 的窄竞态）",
  );
  assert.deepEqual(map.get("sentence:12"), newDraft, "新草稿必须原样留在 Map 里");
});

test("D-M2-11：同一份草稿的完成回调才允许删（引用相等，值相同也不算）", () => {
  const map = new Map();
  const draft = ["唯一一版", "", ""];
  map.set("word:345", draft);
  assert.equal(shouldDeletePending(map, "word:345", draft), true, "就是这份 → 可以删");
  // 值相同但**不是同一份**（结构化拷贝 / 用户改回原样）→ 不删：宁可多重存一次，也不丢一次输入
  assert.equal(shouldDeletePending(map, "word:345", ["唯一一版", "", ""]), false);
});

test("D-M2-11：key 已不在 Map（被淘汰 / 从未写）时回调不删也不报错", () => {
  const map = new Map();
  assert.equal(shouldDeletePending(map, "sentence:999", ["x", "", ""]), false);
  assert.equal(map.size, 0);
});

// ───────────────── D-M2-12：200 条上限与活跃 key 保护 ─────────────────

test("D-M2-12：201 条 + 1 个活跃 key → 淘汰到 200 上限且活跃 key 保留", () => {
  const map = new Map();
  for (let i = 0; i < 201; i += 1) map.set(`k${i}`, [String(i), "", ""]);
  // 把**最旧**的那条设为活跃（正在编辑）：它不能被自己的淘汰逻辑挤掉
  const activeKey = "k0";
  const evicted = evictIfOverLimit(map, PENDING_DRAFT_LIMIT, activeKey);
  assert.equal(map.size, 200, "上限必须生效（旧实现 size=201）");
  assert.equal(map.has(activeKey), true, "活跃 key 不得被淘汰");
  assert.deepEqual(evicted, ["k1"], "只淘汰 1 条，且是最旧的非活跃那条");
});

test("D-M2-12：未超限时一条都不淘汰，返回空数组", () => {
  const map = new Map([["a", ["1", "", ""]]]);
  assert.deepEqual(evictIfOverLimit(map, 200, "a"), []);
  assert.equal(map.size, 1);
});

test("D-M2-12：没有活跃 key 时淘汰最旧的若干条（Map 保插入序）", () => {
  const map = new Map();
  map.set("oldest", ["1", "", ""]);
  map.set("middle", ["2", "", ""]);
  map.set("newest", ["3", "", ""]);
  const evicted = evictIfOverLimit(map, 2);
  assert.deepEqual(evicted, ["oldest"]);
  assert.deepEqual([...map.keys()], ["middle", "newest"]);
});

test("D-M2-12：恰好等于上限时不淘汰（边界不多吃一条）", () => {
  const map = new Map();
  for (let i = 0; i < 200; i += 1) map.set(`k${i}`, [String(i), "", ""]);
  assert.deepEqual(evictIfOverLimit(map, 200, "k0"), []);
  assert.equal(map.size, 200);
});

test("D-M2-12：非正上限视为「不限制」，不清空草稿（防御性，避免配置 0 全丢）", () => {
  const map = new Map([["a", ["1", "", ""]]]);
  assert.deepEqual(evictIfOverLimit(map, 0), []);
  assert.deepEqual(evictIfOverLimit(map, -1), []);
  assert.equal(map.size, 1);
});
