import type { EventBus, KairoEvent } from "../events";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";
import { TaskStatus, type TaskOrchestrator } from "./task-orchestrator";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";

export interface ReviewRequest {
  scope: "task-completion" | "agent-finish";
  taskId?: string;
  taskAgentId?: string;
  agentId?: string;
  result?: unknown;
  claimText?: string;
  lastSayContent?: string;
}

export interface ReviewVerdict {
  ok: boolean;
  scope: ReviewRequest["scope"];
  taskId?: string;
  agentId?: string;
  reasons: string[];
  reviewedAt: number;
}

export class ReviewAgent {
  private bus: EventBus;
  private orchestrator: TaskOrchestrator;
  private logger: Logger;
  private unsubscribers: Array<() => void> = [];
  private latestProgress = new Map<string, { current: number; total: number; timestamp: number }>();
  private latestSayContentByAgent = new Map<string, string>();

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
      const content = this.normalizeText(action.content);
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
    const claimText = this.normalizeText(request.claimText);
    const lastSayContent = this.normalizeText(request.lastSayContent);
    if (typeof request.claimText === "string" && claimText.length === 0) {
      reasons.push("empty_finish_result");
    }
    if (this.hasArtifactExpectation(lastSayContent)) {
      if (claimText.length === 0) {
        reasons.push("artifact_claim_missing");
      } else if (!this.hasArtifactEvidence(claimText)) {
        reasons.push("artifact_evidence_missing");
      }
      const expectedPaths = this.extractPaths(lastSayContent);
      if (expectedPaths.length > 0 && !expectedPaths.some(path => claimText.includes(path))) {
        reasons.push("expected_path_not_confirmed");
      }
      if (expectedPaths.length > 0) {
        const verified = await this.verifyArtifactPaths(expectedPaths);
        if (!verified) {
          reasons.push("expected_artifact_unverified");
        }
      }
    }
    return this.buildVerdict(reasons.length === 0, "agent-finish", request.taskId, request.agentId, reasons);
  }

  private async verifyArtifactPaths(paths: string[]): Promise<boolean> {
    for (const path of paths) {
      const normalized = this.normalizePath(path);
      const readable = await this.tryReadFile(normalized);
      if (readable) {
        return true;
      }
      const shellOk = await this.checkPathByShell(normalized);
      if (shellOk) {
        return true;
      }
    }
    return false;
  }

  private normalizePath(path: string): string {
    if (!path) {
      return path;
    }
    if (path.startsWith("/")) {
      return path;
    }
    return resolvePath(process.cwd(), path);
  }

  private async tryReadFile(filePath: string): Promise<boolean> {
    try {
      await readFile(filePath, { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  private async checkPathByShell(filePath: string): Promise<boolean> {
    const quotedPath = this.quoteShellArg(filePath);
    const result = await this.runShell(`[ -e ${quotedPath} ]`);
    return result.exitCode === 0;
  }

  private quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async runShell(command: string): Promise<{ exitCode: number }> {
    return await new Promise(resolve => {
      const child = spawn("sh", ["-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("close", code => {
        resolve({ exitCode: typeof code === "number" ? code : 1 });
      });
      child.on("error", () => {
        resolve({ exitCode: 1 });
      });
    });
  }

  private normalizeText(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  }

  private hasArtifactExpectation(text: string): boolean {
    if (!text) {
      return false;
    }
    return /(代码|文本|文件|产物|写入|保存|生成|输出|脚本|markdown|readme|配置|create|write|file|code|text|artifact|output)/i.test(text);
  }

  private hasArtifactEvidence(text: string): boolean {
    if (!text) {
      return false;
    }
    return /(已生成|已写入|保存到|输出到|created|written|saved|generated|updated|path|\/|\.ts|\.tsx|\.js|\.jsx|\.json|\.md|\.txt|\.py|\.yml|\.yaml|\.toml|\.css|\.html)/i.test(text);
  }

  private extractPaths(text: string): string[] {
    if (!text) {
      return [];
    }
    const matches = text.match(/(\/[^\s"'`]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|txt|py|java|go|rs|yml|yaml|toml|css|html))/g) || [];
    return Array.from(new Set(matches));
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
