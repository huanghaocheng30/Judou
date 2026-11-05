import { PagePlaceholder } from "../shell/PagePlaceholder";

export function Library() {
  return (
    <PagePlaceholder
      title="文章库"
      summary="一级 Tab「内置 / 我导入的」＋ 考试类型/年份/题型三筛选器 ＋ 搜索 ＋ 等高卡片网格。"
      milestone="M1"
      bullets={["数据源：article（visibility 分组，两条 article 索引已就位）", "空态引导与「筛选无结果」两套文案"]}
    />
  );
}
