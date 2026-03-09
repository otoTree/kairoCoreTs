import type { EventBus, KairoEvent } from "../../events";
import { rootLogger } from "../../observability/logger";
import type { Logger } from "../../observability/types";
import { TaskStatus, type TaskOrchestrator } from "../task";
import type { ReviewRequest, ReviewVerdict } from "./review-types";
import { ReviewToolkit } from "./review-toolkit";

export class ReviewAgent {
  private bus: EventBus;
  private orchestrator: TaskOrchestrator;
  private logger: Logger;
  private unsubscribers: Array<() => void> = [];
  private latestProgress = new Map<string, { current: number; total: number; timestamp: number }>();
  private latestSayContentByAgent = new Map<string, string>();
  private readonly reviewToolkit = new ReviewToolkit();

  constructor(bus: EventBus, orchestrator: TaskOrchestrator) {
    this.bus = bus;
    this.orchestrator = orchestrator;
    this.logger = rootLogger.child({ component: "ReviewAgent" });
    this.start();
  }

  start() {
    if (this.unsubscribers.length > 0) {
      return;
    }
    this.unsubscribers = [
      this.bus.subscribe("kairo.task.agent.progress", this.handleTaskProgress.bind(this)),
      this.bus.subscribe("kairo.review.requested", this.handleReviewRequested.bind(this)),
      this.bus.subscribe("kairo.review.request", this.handleReviewRequest.bind(this)),
      this.bus.subscribe("kairo.agent.action", this.handleAgentAction.bind(this)),
    ];
  }

  stop() {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  private handleTaskProgress(event: KairoEvent) {
    const { taskId, progress } = event.data as any;
    if (!taskId || !progress) {
      return;
    }
    if (!Number.isFinite(progress.current) || !Number.isFinite(progress.total)) {
      return;
    }
    this.latestProgress.set(taskId, {
      current: Number(progress.current),
      total: Number(progress.total),
      timestamp: Date.now(),
    });
  }

  private async handleReviewRequested(event: KairoEvent) {
    const request = event.data as ReviewRequest;
    const verdict = await this.evaluate(request);
    await this.publishVerdict(event, request, verdict);
  }

  private async handleReviewRequest(event: KairoEvent) {
    const request = event.data as ReviewRequest;
    const verdict = await this.evaluate(request);
    await this.bus.publish({
      type: "kairo.review.response",
      source: "review-agent",
      data: verdict,
      correlationId: event.correlationId,
      causationId: event.id,
    });
    await this.publishVerdict(event, request, verdict);
  }

  private async publishVerdict(event: KairoEvent, request: ReviewRequest, verdict: ReviewVerdict) {
    await this.bus.publish({
      type: verdict.ok ? "kairo.review.passed" : "kairo.review.failed",
      source: "review-agent",
      data: {
        request,
        verdict,
      },
      correlationId: event.correlationId,
      causationId: event.id,
    });
    if (request.scope === "agent-finish" && request.agentId && verdict.ok === false) {
      const reasons = verdict.reasons.length > 0 ? verdict.reasons.join("; ") : "unknown_reason";
      await this.bus.publish({
        type: `kairo.agent.${request.agentId}.message`,
        source: "review-agent",
        data: {
          content: `[Review 未通过] ${reasons}`,
          review: verdict,
        },
        correlationId: event.correlationId,
        causationId: event.id,
      });
    }
  }

  private handleAgentAction(event: KairoEvent) {
    const action = (event.data as any)?.action;
    if (!action) {
      return;
    }
    const agentId = this.resolveAgentId(event.source);
    if (!agentId) {
      return;
    }
    if (action.type === "say") {
      const content = this.reviewToolkit.normalizeText(action.content);
      if (content) {
        this.latestSayContentByAgent.set(agentId, content);
      }
      return;
    }
    if (action.type !== "finish") {
      return;
    }
    this.bus.publish({
      type: "kairo.review.requested",
      source: "review-agent",
      data: {
        scope: "agent-finish",
        agentId,
        result: action.result,
        claimText: typeof action.result === "string" ? action.result : undefined,
        lastSayContent: this.latestSayContentByAgent.get(agentId),
      },
      correlationId: event.correlationId,
      causationId: event.id,
    }).catch(error => {
      this.logger.warn("failed to publish agent finish review request", { error });
    });
  }

  private resolveAgentId(source: string | undefined): string {
    const value = source || "";
    return value.startsWith("agent:") ? value.slice("agent:".length) : value;
  }

  private async evaluate(request: ReviewRequest): Promise<ReviewVerdict> {
    if (request.scope === "agent-finish") {
      return await this.evaluateAgentFinish(request);
    }
    return this.evaluateTaskCompletion(request);
  }

  private evaluateTaskCompletion(request: ReviewRequest): ReviewVerdict {
    const reasons: string[] = [];
    const taskId = request.taskId;
    if (!taskId) {
      reasons.push("missing_task_id");
      return this.buildVerdict(false, "task-completion", undefined, request.agentId, reasons);
    }
    const task = this.orchestrator.getTask(taskId);
    if (!task) {
      reasons.push("task_not_found");
      return this.buildVerdict(false, "task-completion", taskId, request.agentId, reasons);
    }
    if (task.status === TaskStatus.CANCELLED) {
      reasons.push("task_cancelled");
    }
    const progress = task.progress || this.latestProgress.get(taskId);
    if (progress && Number.isFinite(progress.total) && progress.total > 0) {
      if (Number(progress.current) < Number(progress.total)) {
        reasons.push("progress_not_reached_total");
      }
    }
    return this.buildVerdict(reasons.length === 0, "task-completion", taskId, task.agentId, reasons);
  }

  private async evaluateAgentFinish(request: ReviewRequest): Promise<ReviewVerdict> {
    const reasons: string[] = [];
    const claimText = this.reviewToolkit.normalizeText(request.claimText);
    const lastSayContent = this.reviewToolkit.normalizeText(request.lastSayContent);
    if (typeof request.claimText === "string" && claimText.length === 0) {
      reasons.push("empty_finish_result");
    }
    if (this.reviewToolkit.hasArtifactExpectation(lastSayContent)) {
      if (claimText.length === 0) {
        reasons.push("artifact_claim_missing");
      } else if (!this.reviewToolkit.hasArtifactEvidence(claimText)) {
        reasons.push("artifact_evidence_missing");
      }
      const expectedPaths = this.reviewToolkit.extractPaths(lastSayContent);
      if (expectedPaths.length > 0 && !expectedPaths.some(path => claimText.includes(path))) {
        reasons.push("expected_path_not_confirmed");
      }
      if (expectedPaths.length > 0) {
        const verification = await this.reviewToolkit.verifyArtifactPaths(expectedPaths);
        if (verification.missingPaths.length > 0) {
          reasons.push("expected_artifact_unverified");
          reasons.push(`missing_artifact_paths:${verification.missingPaths.join(",")}`);
        }
        const workspacePaths = expectedPaths
          .map(path => this.reviewToolkit.normalizePath(path))
          .filter(path => this.reviewToolkit.isPathInWorkspace(path));
        if (workspacePaths.length > 0) {
          const diffCheck = await this.reviewToolkit.runReviewTool("git_diff_paths_changed", { paths: workspacePaths });
          if (!diffCheck.ok) {
            reasons.push("git_diff_no_changes");
            const diffData = diffCheck.data as { unchangedPaths?: string[] } | undefined;
            if (Array.isArray(diffData?.unchangedPaths) && diffData.unchangedPaths.length > 0) {
              reasons.push(`git_diff_unchanged_paths:${diffData.unchangedPaths.join(",")}`);
            }
          }
        }
      }
    }
    const commitRequest = this.reviewToolkit.parseCommitRequest(request);
    if (commitRequest.autoCommit) {
      if (reasons.length > 0) {
        reasons.push("commit_blocked_by_review");
      } else {
        const commitResult = await this.reviewToolkit.runReviewTool("git_commit", {
          message: commitRequest.commitMessage,
        });
        if (!commitResult.ok) {
          reasons.push("git_commit_failed");
          if (typeof commitResult.detail === "string" && commitResult.detail.length > 0) {
            reasons.push(`git_commit_error:${commitResult.detail}`);
          }
        }
      }
    }
    return this.buildVerdict(reasons.length === 0, "agent-finish", request.taskId, request.agentId, reasons);
  }

  private buildVerdict(
    ok: boolean,
    scope: ReviewRequest["scope"],
    taskId: string | undefined,
    agentId: string | undefined,
    reasons: string[],
  ): ReviewVerdict {
    return {
      ok,
      scope,
      taskId,
      agentId,
      reasons,
      reviewedAt: Date.now(),
    };
  }
}
