# 句读（Judou）阅读内容生成规范

> **给内容生成 Agent 的总入口。** 你要产出的是能被「句读」App 直接导入的 JSON 内容包文章文件。
> 本目录自包含：格式规范 + 质量要求 + 完整示例 + **可运行的自检脚本**。
> 版本：2026-11-06 ｜ 对应项目 schema `schemaVersion=1`、`001_init.sql`（19 表）

---

## 一、你要交付什么

**每篇阅读文章一个 `.json` 文件**（UTF-8 无 BOM），文件名 `<sourceKey>.json`，例如 `cet4-2024-06-set1A.json`。

一篇文件里包含这门课需要的**全部**内容：

```
原文（段落 → 句子 → 词，带精确偏移）
       ↓
每句的六段式解析（直译 / 顺译 / 符号句 / 主干与成分 / 从句 / 短语 / 易错 / 段落作用）
       ↓
每个重点词的词条（音标 / 词性 / 释义 / 搭配 / 例句 / 词根 / 易混）
       ↓
题目与答案（含选词填空的空号解析）
```

**不需要**做的事：不要建数据库、不要写 SQL、不要管 `manifest.json`（那是打包环节的事，见 §六）。

---

## 二、先跑通最小闭环（推荐顺序）

```bash
# 1) 读规范（按顺序，30 分钟够了）
01-数据结构规范.md      # 字段怎么填、偏移怎么算
02-内容质量要求.md      # 解析怎么写、哪些是硬错误
03-完整示例.md          # 三种题型逐字段对照（带注释）

# 2) 看真实范例（已通过自检的完整文件）
examples/范例-仔细阅读-careful.json     # 200 KB，5 段 17 句 386 词 5 题 127 词条
examples/范例-选词填空-cloze.json        # 153 KB，5 段 9 句 271 词 10 题 88 词条
（长篇阅读 long 型结构 = careful 型 + questions.options 为空 + answer 是段落字母，见 03 §四）

# 3) 生成你的 JSON

# 4) 自检（必须通过才交付）
node 04-self-check.mjs 你的文件.json
node 04-self-check.mjs ./你的输出目录/     # 也可以整目录检查
```

**自检不通过就不要交付**。脚本的错误信息会指到 `paragraphs[3].sentences[2].tokens[7]` 这种精确位置，按提示改。

---

## 三、最重要的一条：偏移量（offset）

项目用 **UTF-16 code unit 偏移**（等价 JavaScript `string.slice` / `string.length` 的语义），不是字节偏移、不是字符（code point）偏移。

**三级相对偏移**：

| 层级 | `start`/`end` 相对谁 | 校验方式 |
|---|---|---|
| `paragraphs[i].sentences[j]` | **它所在段落的 `text`** | `paragraph.text.slice(s.start, s.end) === s.text` |
| `sentences[j].tokens[k]` | **它所在句子的 `text`** | `sentence.text.slice(t.start, t.end) === t.surface` |

**为什么要这么严**：这个偏移直接决定「点哪个词高亮哪个词」。差一个字符，用户点 `studies` 会高亮成 `tudies` 或 `studies,`。自检脚本对每条都做了切片比对。

> 英文文本两者相同（纯 ASCII 时 UTF-16 code unit 数 = 字符数 = 字节数），但**不要用字节长度**：文本里有中文标点、引号、花体字、emoji 时就会错。

---

## 四、三条最容易出错的地方（先记住，能省你 80% 返工）

### 1. 空号必须在正文里**字面出现**

选词填空的空号（26、27、28…）要在段落 `text` 里真的写着这个数字，项目靠「token 是纯数字且等于某个空号」来渲染成空格控件：

```
✅ 正确：… However, there has been 26 little research on the influence of leisure activities.
❌ 错误：… However, there has been __ little research …        （用下划线占位）
❌ 错误：… However, there has been [26] little research …      （加了括号）
```

### 2. 符号句的标记符必须成对

`_`（谓语）和 `~`（宾语）**出现次数必须是偶数**。奇数会让项目**整串退化为纯文本**、丢掉全部成分标注（这是 fail-closed 设计，不报错但效果全没）。

```
✅ 正确：_have looked at_ ~{how family life can affect productivity}~
❌ 错误：_have looked at ~{how family life can affect productivity}~    （少一个下划线）
```

`【】`、`{}`、`()` 也必须成对——不成对时多余的符号会**原样显示给用户**。

### 3. `isWord` 与 `normalized`

| 情况 | `isWord` | `normalized` |
|---|---|---|
| 普通单词 | `true` | 小写词形，如 `studies` |
| 变形词 | `true` | 原形或规范形，如 `students'` → `students` |
| 标点、符号 | `false` | `null`（**允许**，现有数据 6699 个 token 里 879 个如此） |
| 选词填空的空号数字 | `false` | `null` |

`isWord=true` 时 `normalized` **不能**为空——项目的生词本按 `normalized` 聚合收藏。

---

## 五、自检脚本判定标准（它会拦你什么）

| 级别 | 含义 | 你要做什么 |
|---|---|---|
| **✗ 错误** | 导入会失败、或功能会坏 | **必须修**，改到 0 条 |
| ⚠ 告警 | 不阻塞，但建议改 | 尽量改；不改要能解释理由 |

**会被判错误的典型**：JSON 解析失败、缺必填字段、偏移切片对不上、`answer` 不在选项里、空号与 `blanks` 不对应、标记符不配对、`isWord=true` 但 `normalized` 空、文件含 BOM / NUL / BEL 控制字符。

**只告警的**：符号句标记奇数（现有内容包有 7 句如此，属已知白名单，**新数据请避免**）、`wordCount` 与 token 数比例偏大、词表里有正文没出现的词。

---

## 六、这些事不用你做（交付后由项目侧处理）

| 事项 | 谁做 |
|---|---|
| `manifest.json`（篇目索引与计数汇总） | 打包环节（项目侧脚本生成） |
| 导入数据库、建索引、幂等去重 | 项目侧 Rust 导入器（按 `sourceKey` + 内容哈希） |
| 校验题号连续性、跨篇一致性 | 项目侧门禁 |
| 图片、音频 | 本项目**不用**（纯文本 + 解析） |

---

## 七、参考：现有内容包的实测规模（用来校准你的产出）

| 题型 | 篇数 | 段落 | 句子 | token | 题 | 词表 |
|---|---|---|---|---|---|---|
| 仔细阅读 careful | 6 | 4~8 | 15~21 | 378~398 | 5 | 127~143 |
| 选词填空 cloze | 3 | 3~5 | 9~10 | 271~287 | 10 | 79~103 |
| 长篇阅读 long | 3 | 12~17 | 39~58 | 1148~1208 | 10 | 319~417 |

（共 12 篇 / 274 句 / 6699 token / 90 题 / 1561 词条 / 3.53 MB）

---

## 八、⚠ 现有 12 篇里有 3 篇**不合格**（别照抄它们）

用 `04-self-check.mjs` 跑现有内容包，9 篇通过、3 篇失败。**失败的那 3 篇不要作为参照**：

| 文件 | 问题 |
|---|---|
| `cet4-2023-12-set2Cloze.json` | `paragraphs[2].sentences[3]` 的符号句 `【` 出现 2 次但 `】` 只 1 次（不配对，会露出符号） |
| `cet4-2023-12-set2Long.json` | `questions[2].answer` 为空（这道题没有答案） |
| `cet4-2023-12-set3Cloze.json` | `blanks.26`~`blanks.35` 全部缺 `distractors`（干扰项分析，选词填空的解析缺一半） |

**本规范的例子只取通过的 9 篇**（`examples/` 下两个文件都来自通过组）。

---

## 九、交付前最终检查清单

- [ ] `node 04-self-check.mjs <你的文件>` **错误 0 条**
- [ ] 文件是 UTF-8 **无 BOM**（Windows 记事本另存为时注意）
- [ ] 文件名 = `sourceKey`（如 `cet4-2024-06-set1A.json`）
- [ ] `meta.title` 是文章标题原文（不是「Passage One」）
- [ ] `meta.section` 用中文题型名（`仔细阅读` / `选词填空` / `长篇阅读`）
- [ ] 每句都有 `analysis` 九字段（宁短勿缺；实在没内容写 `[]` 或省略该子项，但不能整段缺）
- [ ] 选词填空的 `blanks` 每题都有 `reason` + `distractors`
- [ ] 题号与原文/空号对应（careful 4 选项、cloze 15 选项、long 无选项）
- [ ] 告警逐条看过，能解释的都写一句理由

---

**有疑问先看 `03-完整示例.md`**——那里三种题型逐字段拆开讲了。仍不清楚再问。