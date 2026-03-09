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
