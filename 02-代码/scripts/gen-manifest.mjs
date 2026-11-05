#!/usr/bin/env node
// 内容包 manifest 生成（02 §三 D2）：幂等，可复跑。
// 口径：file 相对 content-pack/；contentHash = 整篇 JSON 文件字节的 sha256（仅诊断，不参与版本判定）；
//       packVersion 是唯一版本权威（篇内 packVersion 不读、不入库）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packDir = path.join(root, 'content-pack');
const PACK_VERSION = '2023-12-v1';

const SECTION_ORDER = { 仔细阅读: 0, 长篇阅读: 1, 选词填空: 2 };

const files = fs
  .readdirSync(packDir)
  .filter((f) => /^cet4-2023-12-.*\.json$/.test(f))
  .sort();

const articles = files.map((file) => {
  const bytes = fs.readFileSync(path.join(packDir, file));
  const pack = JSON.parse(bytes.toString('utf8'));
  const sentenceCount = pack.paragraphs.reduce((n, p) => n + p.sentences.length, 0);
  return {
    sourceKey: pack.sourceKey,
    file,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sentenceCount,
    setNo: pack.meta.setNo,
    section: pack.meta.section,
  };
});

articles.sort(
  (a, b) =>
    a.setNo - b.setNo ||
    (SECTION_ORDER[a.section] ?? 9) - (SECTION_ORDER[b.section] ?? 9) ||
    a.sourceKey.localeCompare(b.sourceKey),
);

const manifest = {
  packVersion: PACK_VERSION,
  articles: articles.map(({ sourceKey, file, contentHash, sentenceCount }) => ({
    sourceKey,
    file,
    contentHash,
    sentenceCount,
  })),
};

const outPath = path.join(packDir, 'manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`manifest.json 已生成：${manifest.articles.length} 篇，packVersion=${PACK_VERSION}`);
for (const a of manifest.articles) {
  console.log(`  ${a.sourceKey} | ${a.file} | ${a.sentenceCount} 句 | ${a.contentHash.slice(0, 12)}…`);
}
