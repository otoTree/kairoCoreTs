import { InMemoryGlobalBus, type EventBus, type EventStore, type KairoEvent } from "../../events";
import type { AgentRuntime } from "../runtime";
import { TaskOrchestrator, TaskType, TaskStatus, type Task } from "./task-orchestrator";
import { rootLogger } from "../../observability/logger";
import type { Logger } from "../../observability/types";
import { buildTaskAgentPrompt } from "./task-agent-prompt";
import { requestTaskCompletionReview } from "./task-completion-review";

export interface TaskAgentConfig {
  id: string;
  taskId: string;
  parentAgentId: string;
  description: string;
  context: Record<string, any>;
  bus?: EventBus;
}

export interface TaskAgentState {
  id: string;
  taskId: string;
  runtime?: AgentRuntime;
  localBus?: EventBus;
  unsubscribers?: Array<() => void>;
  status: "initializing" | "running" | "paused" | "completed" | "failed";
  createdAt: number;
  lastProgressReport?: number;
}

export interface TaskAgentManagerOptions {
  reviewEnabled?: boolean;
  reviewTimeoutMs?: number;
}

class TaskAgentLocalEventStore implements EventStore {
  private events: KairoEvent[] = [];

  async append(event: KairoEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > 1000) {
      this.events.shift();
    }
  }

  async query(): Promise<KairoEvent[]> {
    return [...this.events];
  }
}

export class TaskAgentManager {
  private bus: EventBus;
  private orchestrator: TaskOrchestrator;
  private logger: Logger;
  private taskAgents: Map<string, TaskAgentState> = new Map();
  private createAgentRuntime?: (config: TaskAgentConfig) => Promise<AgentRuntime>;
  private reviewEnabled: boolean;
  private reviewTimeoutMs: number;

  constructor(
    bus: EventBus,
    orchestrator: TaskOrchestrator,
    createAgentRuntime?: (config: TaskAgentConfig) => Promise<AgentRuntime>,
    options: TaskAgentManagerOptions = {},
  ) {
    this.bus = bus;
    this.orchestrator = orchestrator;
    this.logger = rootLogger.child({ component: "TaskAgentManager" });
    this.createAgentRuntime = createAgentRuntime;
    this.reviewEnabled = options.reviewEnabled === true;
    this.reviewTimeoutMs = Math.max(20, options.reviewTimeoutMs || 200);

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.bus.subscribe("kairo.task.created", this.handleTaskCreated.bind(this));
    this.bus.subscribe("kairo.task.cancelled", this.handleTaskCancelled.bind(this));
  }

  async createTaskAgent(task: Task): Promise<string> {
    if (!this.createAgentRuntime) {
      throw new Error("Agent runtime factory not configured");
    }

    const taskAgentId = `task-agent-${task.id}`;
    this.logger.info(`Creating task agent: ${taskAgentId}`, { task });

    const state: TaskAgentState = {
      id: taskAgentId,
      taskId: task.id,
      status: "initializing",
      createdAt: Date.now(),
    };

    this.taskAgents.set(taskAgentId, state);

    try {
      const localBus = new InMemoryGlobalBus(new TaskAgentLocalEventStore());
      state.localBus = localBus;
      state.unsubscribers = [
        localBus.subscribe("kairo.task.agent.progress", this.handleTaskAgentProgress.bind(this)),
        localBus.subscribe("kairo.task.agent.noop", this.handleTaskAgentNoop.bind(this)),
        localBus.subscribe("kairo.task.agent.completed", this.handleTaskAgentCompleted.bind(this)),
      ];

      const runtime = await this.createAgentRuntime({
        id: taskAgentId,
        taskId: task.id,
        parentAgentId: task.agentId,
        description: task.description,
        context: task.context || {},
        bus: localBus,
      });

      state.runtime = runtime;
      state.status = "running";
      runtime.start();

      localBus.publish({
        type: `kairo.agent.${taskAgentId}.message`,
        source: "task-agent-manager",
        data: {
          content: buildTaskAgentPrompt(task),
          taskId: task.id,
          context: task.context,
        },
        correlationId: task.correlationId,
      });

      this.logger.info(`Task agent created and started: ${taskAgentId}`);
      return taskAgentId;
    } catch (error) {
      this.logger.error(`Failed to create task agent: ${taskAgentId}`, { error });
      state.status = "failed";
      throw error;
    }
  }

  async stopTaskAgent(taskAgentId: string): Promise<void> {
    const state = this.taskAgents.get(taskAgentId);
    if (!state) return;

    this.logger.info(`Stopping task agent: ${taskAgentId}`);

    if (state.runtime) {
      state.runtime.stop();
    }
    if (state.unsubscribers) {
      for (const unsub of state.unsubscribers) {
        unsub();
      }
      state.unsubscribers = [];
    }

    state.status = "completed";
    this.taskAgents.delete(taskAgentId);
  }

  getTaskAgentState(taskAgentId: string): TaskAgentState | undefined {
    return this.taskAgents.get(taskAgentId);
  }

  getActiveTaskAgents(): TaskAgentState[] {
    return Array.from(this.taskAgents.values()).filter(
      state => state.status === "running" || state.status === "paused"
    );
  }

  private async handleTaskCreated(event: KairoEvent) {
    const { task } = event.data as { task: Task };
    if (task.type !== TaskType.LONG) return;

    try {
      const taskAgentId = await this.createTaskAgent(task);
      this.bus.publish({
        type: `kairo.agent.${task.agentId}.message`,
        source: "task-agent-manager",
        data: {
          content: `✅ 已为长程任务创建专门的 Task Agent (${taskAgentId})，任务将在后台执行，我会定期向你报告进度。你现在可以继续处理其他请求。`,
          taskId: task.id,
          taskAgentId,
        },
        correlationId: task.correlationId,
      });
    } catch (error) {
      this.logger.error("Failed to create task agent", { error, task });
      this.bus.publish({
        type: `kairo.agent.${task.agentId}.message`,
        source: "task-agent-manager",
        data: {
          content: `❌ 创建 Task Agent 失败: ${error}`,
          taskId: task.id,
        },
        correlationId: task.correlationId,
      });
    }
  }

  private async handleTaskCancelled(event: KairoEvent) {
    const { taskId } = event.data as { taskId: string };
    for (const [agentId, state] of this.taskAgents.entries()) {
      if (state.taskId === taskId) {
        await this.stopTaskAgent(agentId);
        break;
      }
    }
  }

  private handleTaskAgentProgress(event: KairoEvent) {
    const { taskAgentId, taskId, progress, message } = event.data as any;

    const state = this.taskAgents.get(taskAgentId);
    if (!state) return;

    state.lastProgressReport = Date.now();

    if (progress) {
      this.orchestrator.updateProgress(taskId, progress);
    }

    const task = this.orchestrator.getTask(taskId);
    if (task) {
      this.bus.publish({
        type: `kairo.agent.${task.agentId}.message`,
        source: "task-agent-manager",
        data: {
          content: `[Task Agent 进度] ${message || `${progress?.current}/${progress?.total}`}`,
          taskId,
          taskAgentId,
          progress,
        },
        correlationId: task.correlationId,
      });
    }
  }

  private handleTaskAgentNoop(event: KairoEvent) {
    const { taskAgentId, taskId, message } = event.data as any;
    const state = this.taskAgents.get(taskAgentId);
    if (!state) return;
    const task = this.orchestrator.getTask(taskId);
    if (!task) return;

    this.bus.publish({
      type: `kairo.agent.${task.agentId}.message`,
      source: "task-agent-manager",
      data: {
        content: `[Task Agent 状态] ${message || "Task Agent 返回 noop，等待后续输入或事件继续执行。"}`,
        taskId,
        taskAgentId,
      },
      correlationId: task.correlationId,
    });
  }

  private async handleTaskAgentCompleted(event: KairoEvent) {
    const { taskAgentId, taskId, result, error } = event.data as any;

    const state = this.taskAgents.get(taskAgentId);
    if (!state) return;

    let completionError = error ? String(error) : undefined;
    if (!completionError && this.reviewEnabled) {
      completionError = await requestTaskCompletionReview({
        bus: this.bus,
        logger: this.logger,
        taskId,
        taskAgentId,
        result,
        timeoutMs: this.reviewTimeoutMs,
      });
    }

    if (completionError) {
      state.status = "failed";
      this.orchestrator.failTask(taskId, completionError);
    } else {
      state.status = "completed";
      this.orchestrator.completeTask(taskId, result);
    }

    const task = this.orchestrator.getTask(taskId);
    if (task) {
      const message = completionError
        ? `❌ Task Agent 执行失败: ${completionError}`
        : `✅ Task Agent 已完成任务: ${task.description}`;

      this.bus.publish({
        type: `kairo.agent.${task.agentId}.message`,
        source: "task-agent-manager",
        data: {
          content: message,
          taskId,
          taskAgentId,
          result,
          error: completionError,
        },
        correlationId: task.correlationId,
      });
    }

    await this.stopTaskAgent(taskAgentId);
  }

  cleanup() {
    const now = Date.now();
    const timeout = 60 * 60 * 1000;

    for (const [agentId, state] of this.taskAgents.entries()) {
      if (
        (state.status === "completed" || state.status === "failed") &&
        now - state.createdAt > timeout
      ) {
        this.taskAgents.delete(agentId);
        this.logger.debug(`Cleaned up task agent: ${agentId}`);
      }
    }
  }
}
