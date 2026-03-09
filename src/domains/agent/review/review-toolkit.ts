import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { relative, resolve as resolvePath } from "node:path";
import type { ReviewRequest } from "./review-types";

export interface ReviewToolResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
}

type ReviewToolHandler = (input: Record<string, unknown>) => Promise<ReviewToolResult>;

export class ReviewToolkit {
  private reviewTools = new Map<string, ReviewToolHandler>();

  constructor() {
    this.registerBuiltInReviewTools();
  }

  normalizeText(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  }

  normalizePath(path: string): string {
    if (!path) {
      return path;
    }
    if (path.startsWith("/")) {
      return path;
    }
    return resolvePath(process.cwd(), path);
  }

  isPathInWorkspace(path: string): boolean {
    const workspaceRoot = process.cwd();
    const normalized = this.normalizePath(path);
    const rel = relative(workspaceRoot, normalized);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../"));
  }

  hasArtifactExpectation(text: string): boolean {
    if (!text) {
      return false;
    }
    return /(代码|文本|文件|产物|写入|保存|生成|输出|脚本|markdown|readme|配置|create|write|file|code|text|artifact|output)/i.test(text);
  }

  hasArtifactEvidence(text: string): boolean {
    if (!text) {
      return false;
    }
    return /(已生成|已写入|保存到|输出到|created|written|saved|generated|updated|path|\/|\.ts|\.tsx|\.js|\.jsx|\.json|\.md|\.txt|\.py|\.yml|\.yaml|\.toml|\.css|\.html)/i.test(text);
  }

  extractPaths(text: string): string[] {
    if (!text) {
      return [];
    }
    const matches = text.match(/(\/[^\s"'`]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|txt|py|java|go|rs|yml|yaml|toml|css|html))/g) || [];
    return Array.from(new Set(matches));
  }

  parseCommitRequest(request: ReviewRequest): { autoCommit: boolean; commitMessage?: string } {
    if (!request.result || typeof request.result !== "object") {
      return { autoCommit: false };
    }
    const value = request.result as Record<string, unknown>;
    if (value.autoCommit === true) {
      return {
        autoCommit: true,
        commitMessage: typeof value.commitMessage === "string" ? value.commitMessage : undefined,
      };
    }
    return { autoCommit: false };
  }

  async runReviewTool(name: string, input: Record<string, unknown>): Promise<ReviewToolResult> {
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

  async verifyArtifactPaths(paths: string[]): Promise<{ verifiedPaths: string[]; missingPaths: string[] }> {
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
}
