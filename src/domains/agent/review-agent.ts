import type { EventBus, KairoEvent } from "../events";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";
import { TaskStatus, type TaskOrchestrator } from "./task-orchestrator";
import { readFile } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";
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

type ReviewToolResult = {
  ok: boolean;
  detail?: string;
  data?: any;
};

type ReviewToolHandler = (input: Record<string, any>) => Promise<ReviewToolResult>;

export class ReviewAgent {
  private bus: EventBus;
  private orchestrator: TaskOrchestrator;
  private logger: Logger;
  private unsubscribers: Array<() => void> = [];
  private latestProgress = new Map<string, { current: number; total: number; timestamp: number }>();
  private latestSayContentByAgent = new Map<string, string>();
  private reviewTools = new Map<string, ReviewToolHandler>();

  constructor(bus: EventBus, orchestrator: TaskOrchestrator) {
    this.bus = bus;
    this.orchestrator = orchestrator;
    this.logger = rootLogger.child({ component: "ReviewAgent" });
    this.registerBuiltInReviewTools();
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
        const verification = await this.verifyArtifactPaths(expectedPaths);
        if (verification.missingPaths.length > 0) {
          reasons.push("expected_artifact_unverified");
          reasons.push(`missing_artifact_paths:${verification.missingPaths.join(",")}`);
        }
        const workspacePaths = expectedPaths
          .map(path => this.normalizePath(path))
          .filter(path => this.isPathInWorkspace(path));
        if (workspacePaths.length > 0) {
          const diffCheck = await this.runReviewTool("git_diff_paths_changed", { paths: workspacePaths });
          if (!diffCheck.ok) {
            reasons.push("git_diff_no_changes");
            if (Array.isArray(diffCheck.data?.unchangedPaths) && diffCheck.data.unchangedPaths.length > 0) {
              reasons.push(`git_diff_unchanged_paths:${diffCheck.data.unchangedPaths.join(",")}`);
            }
          }
        }
      }
    }
    const commitRequest = this.parseCommitRequest(request);
    if (commitRequest.autoCommit) {
      if (reasons.length > 0) {
        reasons.push("commit_blocked_by_review");
      } else {
        const commitResult = await this.runReviewTool("git_commit", {
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

  private registerBuiltInReviewTools() {
    this.reviewTools.set("read_file", async (input) => {
      const normalized = this.normalizePath(String(input.path || ""));
      const ok = await this.tryReadFile(normalized);
      return { ok, detail: ok ? undefined : "read_failed" };
    });
    this.reviewTools.set("shell_exists", async (input) => {
      const normalized = this.normalizePath(String(input.path || ""));
      const ok = await this.checkPathByShell(normalized);
      return { ok, detail: ok ? undefined : "shell_not_found" };
    });
    this.reviewTools.set("git_diff_paths_changed", async (input) => {
      const paths = Array.isArray(input.paths) ? input.paths.map(item => String(item)) : [];
      const repoOk = await this.ensureGitRepo();
      if (!repoOk.ok) {
        return { ok: false, detail: repoOk.detail };
      }
      if (paths.length === 0) {
        return { ok: false, detail: "no_paths" };
      }
      const workspaceRoot = process.cwd();
      const pathSpecs = paths
        .filter(path => this.isPathInWorkspace(path))
        .map(path => this.quoteShellArg(relative(workspaceRoot, path)));
      if (pathSpecs.length === 0) {
        return { ok: false, detail: "no_workspace_paths" };
      }

      const base = `git -C ${this.quoteShellArg(workspaceRoot)}`;
      const changedTracked = await this.runShellDetailed(`${base} diff --name-only HEAD -- ${pathSpecs.join(" ")}`);
      const changedUntracked = await this.runShellDetailed(`${base} ls-files --others --exclude-standard -- ${pathSpecs.join(" ")}`);

      const changed = new Set<string>();
      for (const line of [changedTracked.stdout, changedUntracked.stdout].join("\n").split("\n")) {
        const value = line.trim();
        if (value.length > 0) {
          changed.add(resolvePath(workspaceRoot, value));
        }
      }
      const unchangedPaths = paths.filter(path => !changed.has(path));
      return {
        ok: unchangedPaths.length === 0,
        data: {
          changedPaths: Array.from(changed.values()),
          unchangedPaths,
        },
      };
    });
    this.reviewTools.set("git_commit", async (input) => {
      const repoOk = await this.ensureGitRepo();
      if (!repoOk.ok) {
        return { ok: false, detail: repoOk.detail };
      }
      const message = typeof input.message === "string" && input.message.trim().length > 0
        ? input.message.trim()
        : "chore: auto commit after review pass";
      const workspaceRoot = process.cwd();
      const base = `git -C ${this.quoteShellArg(workspaceRoot)}`;
      const addResult = await this.runShellDetailed(`${base} add -A`);
      if (addResult.exitCode !== 0) {
        return { ok: false, detail: addResult.stderr || "git_add_failed" };
      }
      const diffCached = await this.runShellDetailed(`${base} diff --cached --name-only`);
      if (diffCached.stdout.trim().length === 0) {
        return { ok: false, detail: "no_staged_changes" };
      }
      const commitResult = await this.runShellDetailed(`${base} commit -m ${this.quoteShellArg(message)}`);
      if (commitResult.exitCode !== 0) {
        return { ok: false, detail: commitResult.stderr || commitResult.stdout || "git_commit_failed" };
      }
      return { ok: true };
    });
  }

  private async runReviewTool(name: string, input: Record<string, any>): Promise<ReviewToolResult> {
    const handler = this.reviewTools.get(name);
    if (!handler) {
      return { ok: false, detail: "tool_not_found" };
    }
    try {
      return await handler(input);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async verifyArtifactPath(path: string): Promise<boolean> {
    const steps = ["read_file", "shell_exists"];
    for (const step of steps) {
      const result = await this.runReviewTool(step, { path });
      if (result.ok) {
        return true;
      }
    }
    return false;
  }

  private async verifyArtifactPaths(paths: string[]): Promise<{ verifiedPaths: string[]; missingPaths: string[] }> {
    const verifiedPaths: string[] = [];
    const missingPaths: string[] = [];
    for (const path of paths) {
      const verified = await this.verifyArtifactPath(path);
      if (verified) {
        verifiedPaths.push(path);
      } else {
        missingPaths.push(path);
      }
    }
    return { verifiedPaths, missingPaths };
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

  private isPathInWorkspace(path: string): boolean {
    const workspaceRoot = process.cwd();
    const normalized = this.normalizePath(path);
    const rel = relative(workspaceRoot, normalized);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../"));
  }

  private parseCommitRequest(request: ReviewRequest): { autoCommit: boolean; commitMessage?: string } {
    if (!request.result || typeof request.result !== "object") {
      return { autoCommit: false };
    }
    const value = request.result as Record<string, any>;
    if (value.autoCommit === true) {
      return {
        autoCommit: true,
        commitMessage: typeof value.commitMessage === "string" ? value.commitMessage : undefined,
      };
    }
    return { autoCommit: false };
  }

  private async ensureGitRepo(): Promise<ReviewToolResult> {
    const result = await this.runShellDetailed(`git -C ${this.quoteShellArg(process.cwd())} rev-parse --is-inside-work-tree`);
    if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
      return { ok: false, detail: "not_git_repo" };
    }
    return { ok: true };
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

  private async runShellDetailed(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return await new Promise(resolve => {
      const child = spawn("sh", ["-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
      });
      child.on("close", code => {
        resolve({
          exitCode: typeof code === "number" ? code : 1,
          stdout,
          stderr,
        });
      });
      child.on("error", error => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: `${stderr}${String(error)}`,
        });
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
