export type ScheduledTaskStatus = "scheduled" | "dispatched" | "cancelled" | "failed";
export type ProcessTaskStatus = "running" | "exited" | "failed" | "cancelled";

export interface RepeatStrategy {
  intervalMs?: number;
  cron?: string;
}

export interface ScheduledTask {
  id: string;
  requesterAgentId: string;
  targetAgentId?: string;
  description: string;
  input?: any;
  repeat?: RepeatStrategy;
  executeAt: number;
  createdAt: number;
  status: ScheduledTaskStatus;
  runCount?: number;
  lastDispatchedAt?: number;
  delegatedTaskId?: string;
  error?: string;
}

export interface ProcessTask {
  processId: string;
  ownerAgentId: string;
  command: string[];
  createdAt: number;
  status: ProcessTaskStatus;
  exitCode?: number;
  endedAt?: number;
}
