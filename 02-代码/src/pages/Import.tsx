import { PagePlaceholder } from "../shell/PagePlaceholder";

export function Import() {
  return (
    <PagePlaceholder
      title="导入"
      summary="粘贴或选文件 → 预览（可改标题、剔段）→ 提交；错误码提示并保留用户输入。"
      milestone="M5"
      bullets={["两阶段：parse_import_preview（不落库）→ commit_import（L1~L4 校验 + 单事务）", "路径限域与错误信息 basename 化在 M5 一并处理"]}
    />
  );
}
