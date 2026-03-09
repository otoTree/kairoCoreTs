import type { EventBus } from "../../events";
import type { Logger } from "../../observability/types";

export async function requestTaskCompletionReview(params: {
  bus: EventBus;
  logger: Logger;
  taskId: string;
  taskAgentId: string;
  result: unknown;
  timeoutMs: number;
}): Promise<string | undefined> {
  try {
    const review = await params.bus.request<
      { scope: string; taskId: string; taskAgentId: string; result?: unknown },
      { ok?: boolean; reasons?: string[] }
    >(
      "kairo.review.request",
      {
        scope: "task-completion",
        taskId: params.taskId,
        taskAgentId: params.taskAgentId,
        result: params.result,
      },
      params.timeoutMs,
    );
    if (review?.ok === false) {
      const reason = Array.isArray(review.reasons) && review.reasons.length > 0
        ? review.reasons.join("; ")
        : "unknown_review_failure";
      return `Review 未通过: ${reason}`;
    }
  } catch (reviewError) {
    params.logger.warn("task completion review timeout, fallback to complete", { taskId: params.taskId, reviewError });
  }
  return undefined;
}
