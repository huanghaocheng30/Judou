import { PagePlaceholder } from "../shell/PagePlaceholder";

export function Review() {
  return (
    <PagePlaceholder
      title="复习"
      summary="待复习列表按到期日排序；进入复习模式；完成后回列表并更新角标。"
      milestone="M3"
      bullets={["复习档位 1/3/7/14 天（review_plan.interval_index 0~3）", "「还需再看」不推进档位，next_review_at 设为次日"]}
    />
  );
}
