// 正文渲染纯函数：把一句的 text + token 列表切成 text/word/blank 节点。
// 约束（02 §三 D5 / AC5）：不得触碰 DOM / window / history —— 必须可被 node 直接 import 断言。

import type { TokenDto, TokenNode } from '../types.ts';

/**
 * 空格判定口径（定死，防误判正文数字）：
 *   isWord === false 且 surface 匹配 /^\d+$/ 且 Number(surface) ∈ blankNos
 * 三条件同时成立才是空格节点；正文固有数字（75/150/1997…）不得判为空格。
 */
export function isBlankToken(token: TokenDto, blankNos: number[]): boolean {
  return token.isWord === false && /^\d+$/.test(token.surface) && blankNos.includes(Number(token.surface));
}

/**
 * 把一句渲染成节点数组。节点 text 拼接必须逐字复原传入的 text。
 * - 单词：{ type:'word', text: surface, n: normalized, start }
 * - 空格：{ type:'blank', text: surface, start, blankNo }
 * - 单词/空格 token 之外的 token（正文数字、标点等）与 token 间隙：{ type:'text', text }
 */
export function renderTokens(text: string, tokens: TokenDto[], blankNos: number[]): TokenNode[] {
  const nodes: TokenNode[] = [];
  const ordered = [...tokens].sort((a, b) => a.start - b.start);
  let cursor = 0;

  for (const token of ordered) {
    const start = Math.max(token.start, cursor);
    if (start > cursor) {
      nodes.push({ type: 'text', text: text.slice(cursor, start) });
    }
    if (isBlankToken(token, blankNos)) {
      nodes.push({ type: 'blank', text: token.surface, start: token.start, blankNo: Number(token.surface) });
    } else if (token.isWord) {
      nodes.push({ type: 'word', text: token.surface, n: token.normalized ?? token.surface, start: token.start });
    } else {
      nodes.push({ type: 'text', text: token.surface });
    }
    cursor = Math.max(cursor, token.end);
  }

  if (cursor < text.length) {
    nodes.push({ type: 'text', text: text.slice(cursor) });
  }
  return nodes;
}
