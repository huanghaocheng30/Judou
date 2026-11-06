/**
 * 未落库草稿的两条判定（M3 D7，收 M2 债务 D-M2-11 / D-M2-12）。
 *
 * 为什么抽成纯函数（评审 B-3）：两条判定原本内联在 `useDebouncedSave.ts` 里，
 * 只有把判定搬进不依赖 React/DOM 的模块，`node --test` 才能**直测**它们做红→绿
 * （沿用 `theme.test.mjs` 的范式，不引测试框架、不引 jsdom）。
 * hook 只管调用，不再内联逻辑——两处规则漂移时会立刻被测试抓到。
 *
 * 纪律：**不 import React/DOM、不用 enum/namespace/参数属性、不 import `.css`/`.tsx`**
 * （Node 24 类型擦除要能直接 import 本文件）。
 *
 * ponytail: 只抽两个判定函数，不建「PendingStore 类」——调用方只有 hook 一个，
 * 而类会把 Map 的生命周期也搬进来（hook 需要模块级 Map 跨组件存活，语义不同）。
 */

/** 参与淘汰的最小 Map 契约（只要求这几个方法，不锁死具体类型） */
export interface PendingDraftMap {
  get(key: string): string[] | undefined;
  set(key: string, value: string[]): unknown;
  delete(key: string): boolean;
  has(key: string): boolean;
  readonly size: number;
  keys(): IterableIterator<string>;
}

/** 草稿条数上限（D-M2-12：模块级 Map 长期只增不减会随使用无限长大） */
export const PENDING_DRAFT_LIMIT = 200;

/**
 * 保存成功回调该不该删掉这条 pending（D-M2-11 的窄竞态）：
 *
 * 场景是——用户在旧草稿的保存**还没返回**时又敲了一版（pending 被覆盖成新数组），
 * 旧保存此刻成功返回；若无条件 `delete(key)`，**新草稿就被静默丢了**（下一次防抖读不到它）。
 *
 * 判据用**引用相等**：`saveNow` 拿到的 draft 与 Map 里当前那份是同一引用时才删。
 * 不用「值相等」——用户把内容改回原样时值会相等，但那是一次新编辑，必须留着再保存。
 * 最坏情况只是多重存一次（幂等 upsert），不会丢输入。
 */
export function shouldDeletePending(
  map: PendingDraftMap,
  key: string,
  draft: string[],
): boolean {
  const current = map.get(key);
  if (current === undefined) {
    return false; // 已被淘汰 / 从未写入：无可删，也不该报错
  }
  return current === draft;
}

/**
 * 超出上限时淘汰最旧的若干条，返回被淘汰的 key 列表（保持淘汰顺序，便于测试与日志）。
 *
 * 三条口径：
 * - `Map` 保插入序 → 迭代顺序即「最旧在前」，逐个删到不超限；
 * - **`activeKey` 永不淘汰**——正在编辑的那条被自己触发的淘汰挤掉，等于当场丢草稿；
 * - `limit` 非正 / 非有限值视为「不限制」（配置写 0 不该把全部草稿清空）。
 */
export function evictIfOverLimit(
  map: PendingDraftMap,
  limit: number,
  activeKey?: string | null,
): string[] {
  const evicted: string[] = [];
  if (!Number.isFinite(limit) || limit <= 0) {
    return evicted;
  }
  if (map.size <= limit) {
    return evicted;
  }
  // 边迭代边删是 Map 迭代器的合法用法（已访问项不受影响）
  for (const key of map.keys()) {
    if (map.size <= limit) break;
    if (key === activeKey) continue;
    map.delete(key);
    evicted.push(key);
  }
  return evicted;
}
