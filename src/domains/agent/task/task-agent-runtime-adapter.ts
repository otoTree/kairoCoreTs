import type { AgentRuntime } from "../runtime";
import type { EventBus } from "../../events";
import type { TaskAgentConfig } from "./task-agent-manager";

export class TaskAgentRuntimeAdapter {
  private runtime: AgentRuntime;
  private bus: EventBus;
  private config: TaskAgentConfig;
  private lastProgress?: { current: number; total: number };

  constructor(runtime: AgentRuntime, bus: EventBus, config: TaskAgentConfig) {
    this.runtime = runtime;
    this.bus = bus;
    this.config = config;
    this.interceptActions();
  }

  private interceptActions() {
    const originalOnAction = this.runtime["onAction"];

    this.runtime["onAction"] = (action: any) => {
      if (originalOnAction) {
        originalOnAction(action);
      }

      if (action.type === "say") {
        this.extractAndReportProgress(action.content);
      }

      if (action.type === "finish") {
        this.reportCompletion(action.result);
      }

      if (action.type === "noop") {
        this.reportNoop(action.content);
      }
    };
  }

  private extractAndReportProgress(message: string) {
    const patterns = [
      /(\d+)\/(\d+)/,
      /第\s*(\d+)\s*[步题]/,
      /completed\s+(\d+)\s+of\s+(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        const current = parseInt(match[1]);
        const total = match[2] ? parseInt(match[2]) : this.lastProgress?.total;

        if (total) {
          this.lastProgress = { current, total };
          this.reportProgress({ current, total }, message);
          break;
        }
      }
    }
  }

  private reportProgress(progress: { current: number; total: number }, message: string) {
    this.bus.publish({
      type: "kairo.task.agent.progress",
      source: `task-agent:${this.config.id}`,
      data: {
        taskAgentId: this.config.id,
        taskId: this.config.taskId,
        progress,
        message,
        timestamp: Date.now(),
      },
    });
  }

  private reportCompletion(result?: any) {
    this.bus.publish({
      type: "kairo.task.agent.completed",
      source: `task-agent:${this.config.id}`,
      data: {
        taskAgentId: this.config.id,
        taskId: this.config.taskId,
        result,
        timestamp: Date.now(),
      },
    });
  }

  private reportNoop(message?: string) {
    this.bus.publish({
      type: "kairo.task.agent.noop",
      source: `task-agent:${this.config.id}`,
      data: {
        taskAgentId: this.config.id,
        taskId: this.config.taskId,
        message: message || "Task Agent 当前无可执行动作，进入等待状态",
        timestamp: Date.now(),
      },
    });
  }

  reportError(error: any) {
    this.bus.publish({
      type: "kairo.task.agent.completed",
      source: `task-agent:${this.config.id}`,
      data: {
        taskAgentId: this.config.id,
        taskId: this.config.taskId,
        error: error.message || String(error),
        timestamp: Date.now(),
      },
    });
  }

  dispose() {
    return;
  }
}
