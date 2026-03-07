import type { AgentRuntime } from "./runtime";
import type { EventBus } from "../events";
import type { TaskAgentConfig } from "./task-agent-manager";

/**
 * Task Agent Runtime 适配器
 *
 * 为 task agent 提供自动进度报告功能
 */
export class TaskAgentRuntimeAdapter {
  private runtime: AgentRuntime;
  private bus: EventBus;
  private config: TaskAgentConfig;

  private progressReportTimer?: NodeJS.Timeout;
  private lastProgress?: { current: number; total: number };

  constructor(runtime: AgentRuntime, bus: EventBus, config: TaskAgentConfig) {
    this.runtime = runtime;
    this.bus = bus;
    this.config = config;

    this.setupProgressReporting();
    this.interceptActions();
  }

  /**
   * 设置自动进度报告
   */
  private setupProgressReporting() {
    const interval = this.config.progressReportInterval || 5000;

    this.progressReportTimer = setInterval(() => {
      if (this.lastProgress) {
        this.reportProgress(this.lastProgress, "定期进度报告");
      }
    }, interval);
  }

  /**
   * 拦截 agent 的 action，自动提取进度信息
   */
  private interceptActions() {
    const originalOnAction = this.runtime["onAction"];

    this.runtime["onAction"] = (action: any) => {
      // 调用原始回调
      if (originalOnAction) {
        originalOnAction(action);
      }

      // 拦截 say 动作，提取进度
      if (action.type === "say") {
        this.extractAndReportProgress(action.content);
      }

      // 拦截 finish 动作，报告完成
      if (action.type === "finish") {
        this.reportCompletion(action.result);
      }
    };
  }

  /**
   * 从消息中提取进度信息
   */
  private extractAndReportProgress(message: string) {
    // 匹配格式：X/Y 或 第X步 (X/Y)
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

  /**
   * 报告进度
   */
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

  /**
   * 报告完成
   */
  private reportCompletion(result?: any) {
    if (this.progressReportTimer) {
      clearInterval(this.progressReportTimer);
      this.progressReportTimer = undefined;
    }

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

  /**
   * 报告错误
   */
  reportError(error: any) {
    if (this.progressReportTimer) {
      clearInterval(this.progressReportTimer);
      this.progressReportTimer = undefined;
    }

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

  /**
   * 清理资源
   */
  dispose() {
    if (this.progressReportTimer) {
      clearInterval(this.progressReportTimer);
      this.progressReportTimer = undefined;
    }
  }
}
