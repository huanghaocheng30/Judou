import { PagePlaceholder } from "../shell/PagePlaceholder";

export function Today() {
  return (
    <PagePlaceholder
      title="今日"
      summary="新用户空态 → 继续精读 / 今日待复习(N) 两栏；卡片可键盘聚焦。"
      milestone="M1"
      bullets={["继续精读：跳上次阅读位置（reading_record.last_position）", "今日待复习：按 review_plan.next_review_at 取到期篇目"]}
    />
  );
}
