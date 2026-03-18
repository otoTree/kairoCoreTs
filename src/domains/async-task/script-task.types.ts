import type { RepeatStrategy } from "./async-task.types";

export type ScriptTaskStatus =
  | "scheduled"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ScriptTaskRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ScriptTaskExecutionPolicy {
  allowConcurrentRuns?: boolean;
  overlapStrategy?: "skip" | "queue_one" | "parallel";
  timeoutMs?: number;
}

export interface ScriptTaskReportPolicy {
  onSuccess?: boolean;
  onFailure?: boolean;
  includeOutputSummary?: boolean;
  includeLogPaths?: boolean;
  triggerFollowupAgentTask?: boolean;
  followupDescriptionTemplate?: string;
}

export interface ScriptTaskArtifacts {
  outputPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface ScriptTask {
  taskId: string;
  ownerAgentId: string;
  reportToAgentId: string;
  description: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inlineScript?: string;
  shell?: string;
  createdAt: number;
  scheduledAt?: number;
  startedAt?: number;
  endedAt?: number;
  nextExecuteAt?: number;
  repeat?: RepeatStrategy;
  status: ScriptTaskStatus;
  runCount: number;
  lastRunId?: string;
  lastProcessId?: string;
  lastExitCode?: number;
  lastError?: string;
  executionPolicy?: ScriptTaskExecutionPolicy;
  reportPolicy?: ScriptTaskReportPolicy;
  artifacts?: ScriptTaskArtifacts;
  pendingRun?: boolean;
}

export interface ScriptTaskRun {
  runId: string;
  taskId: string;
  processId: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: ScriptTaskRunStatus;
  exitCode?: number;
  error?: string;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  summary?: string;
}

export interface ScriptTaskProcessBinding {
  processId: string;
  taskId: string;
  runId: string;
  ownerAgentId: string;
}

export interface CreateScriptTaskInput {
  description: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inlineScript?: string;
  shell?: string;
  delayMs?: number;
  runAt?: string;
  repeat?: RepeatStrategy;
  reportToAgentId?: string;
  executionPolicy?: ScriptTaskExecutionPolicy;
  reportPolicy?: ScriptTaskReportPolicy;
  artifacts?: ScriptTaskArtifacts;
}

export interface ScriptTaskReportPayload {
  taskId: string;
  runId: string;
  processId: string;
  ownerAgentId: string;
  reportToAgentId: string;
  description: string;
  status: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  command: string;
  args?: string[];
  cwd?: string;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  artifacts?: ScriptTaskArtifacts;
  nextExecuteAt?: number;
}
