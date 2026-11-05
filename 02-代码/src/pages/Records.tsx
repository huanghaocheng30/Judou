import { PagePlaceholder } from "../shell/PagePlaceholder";

export function Records() {
  return (
    <PagePlaceholder
      title="记录与统计"
      summary="时间线 + 六项汇总卡（篇数/时长/笔记/生词/复习次数/连续天数）。"
      milestone="M6"
      bullets={["数据源：reading_record（duration_sec / completed）+ review_log + sentence_note / word_note 计数"]}
    />
  );
}
