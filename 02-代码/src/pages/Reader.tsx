import { PagePlaceholder } from "../shell/PagePlaceholder";

/**
 * 精读页占位。路由当前是扁平 `#/article`（02 D1 已登记），
 * M1 接入真实详情时切 `#/article/:id`（改 routes 表 1 处）。
 */
export function Reader() {
  return (
    <PagePlaceholder
      title="精读页"
      summary="正文可点句、点词、点空；右栏解析卡/词卡/空格卡原地更换；题目折叠 + 显示答案。"
      milestone="M1"
      bullets={["偏移口径：UTF-16 code unit（ADR-008），sentence 相对段落、token 相对句子", "M1 只做正文与点句选中；解析卡在 M2"]}
    />
  );
}
