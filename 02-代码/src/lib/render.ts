/**
 * 精读渲染纯函数：把一句原文 + 该句 token 切成 text / word / blank 三类节点。
 *
 * 三条纪律（05 §四 / 02 D6）：
 * 1. **不依赖 DOM**：node 断言（`scripts/verify-render.mjs`）与 React 组件共用同一份实现。
 * 2. **空格判定三条件**：`isWord === false` ∧ `surface` 匹配 `/^\d+$/` ∧ `Number(surface) ∈ blankNos`。
 *    禁止用 `normalized` 推导——推导会把选词填空的空格 token（`surface="26"`, `normalized="26"`）判成词。
 * 3. **只用 erasable 语法**（禁止 `enum` / `namespace` / 参数属性）、**不 import `.css` / `.tsx`**：
 *    node 直接 `import` 本文件（Node 24 的类型剥离只支持 erasable 语法）。类型导入必须写 `import type`。
 *
 * ponytail: 一次线性扫描 + 字符串切片，不建区间树/不记忆化——6699 token 全量渲染实测远低于 50ms
 * （长文 1208 token 100 次中位数见 verify-render）。等出现「同一句高频重渲染」再考虑缓存。
 */
import type { ApiToken } from "./types";

/** 渲染节点（前端内部类型，与 IPC 的 `ApiToken` 无关） */
export interface TokenNode {
  kind: "text" | "word" | "blank";
  text: string;
  /** 仅 word / blank：对应 `token.id`（M2 起挂词卡/笔记） */
  tokenId?: number;
  /** 仅 word：聚合生词用的规范形 */
  normalized?: string;
  /** 仅 word / blank：相对句子文本的起始偏移 */
  start?: number;
  /** 仅 blank：空格编号（`data-blank-no` 的值） */
  blankNo?: number;
}

/** 纯数字（空格候选）：用字符类而非 `\d` 语义猜测 */
const PURE_DIGITS = /^\d+$/;

/**
 * 切开一句：间隙空白 → text 节点；词 → word 节点；空格 → blank 节点。
 *
 * 顺序与偏移严格对齐内容包（`start`/`end` 相对句子文本），不做任何重排。
 */
export function renderTokens(text: string, tokens: ApiToken[], blankNos: number[]): TokenNode[] {
  const nodes: TokenNode[] = [];
  let prev = 0;

  for (const token of tokens) {
    if (token.start > prev) {
      nodes.push({ kind: "text", text: text.slice(prev, token.start) });
    }

    if (token.isWord === false && PURE_DIGITS.test(token.surface) && blankNos.includes(Number(token.surface))) {
      nodes.push({
        kind: "blank",
        text: token.surface,
        tokenId: token.id,
        start: token.start,
        blankNo: Number(token.surface),
      });
    } else if (token.isWord === false) {
      // 标点、固有数字（150 / 1997 / 88,000）、其他非词符号：纯文本，不带任何 data-* 词属性
      nodes.push({ kind: "text", text: text.slice(token.start, token.end) });
    } else {
      nodes.push({
        kind: "word",
        text: token.surface,
        tokenId: token.id,
        normalized: token.normalized,
        start: token.start,
      });
    }

    prev = token.end;
  }

  if (prev < text.length) {
    nodes.push({ kind: "text", text: text.slice(prev) });
  }

  return nodes;
}
