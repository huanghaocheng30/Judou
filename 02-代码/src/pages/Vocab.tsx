import { PagePlaceholder } from "../shell/PagePlaceholder";

export function Vocab() {
  return (
    <PagePlaceholder
      title="生词本"
      summary="按文章/标签/状态三轴分组；编辑释义与标签；点回原句；导出。"
      milestone="M4"
      bullets={["聚合键 normalized（vocab_entry.normalized UNIQUE），重复添加只更新来源与释义", "掌握状态三档 new / fuzzy / known，颜色不作唯一信息通道"]}
    />
  );
}
