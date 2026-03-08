import { InMemoryGlobalBus, type EventBus, type EventStore, type KairoEvent } from "../events";
import type { AgentRuntime } from "./runtime";
import { TaskOrchestrator, TaskType, TaskStatus, type Task } from "./task-orchestrator";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";

/**
 * Task Agent 配置
 */
export interface TaskAgentConfig {
  id: string;
  taskId: string;
  parentAgentId: string;
  description: string;
  context: Record<string, any>;
  bus?: EventBus;
}

/**
 * Task Agent 状态
 */
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

/**
 * Task Agent Manager - 管理专门执行长程任务的 Agent
 *
 * 架构设计：
 * - 主 Agent 保持响应性，处理用户交互
 * - Task Agent 专门执行长程任务，定期报告进度
 * - 通过事件总线进行通信，解耦合
 */
export class TaskAgentManager {
  private bus: EventBus;
  private orchestrator: TaskOrchestrator;
  private logger: Logger;

  // 活跃的 task agents
  private taskAgents: Map<string, TaskAgentState> = new Map();

  // Agent 工厂函数（由外部注入）
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
    // 监听任务创建事件
    this.bus.subscribe("kairo.task.created", this.handleTaskCreated.bind(this));

    // 监听任务取消事件
    this.bus.subscribe("kairo.task.cancelled", this.handleTaskCancelled.bind(this));
  }

  /**
   * 为长程任务创建专门的 task agent
   */
  async createTaskAgent(task: Task): Promise<string> {
    if (!this.createAgentRuntime) {
      throw new Error("Agent runtime factory not configured");
    }

    const taskAgentId = `task-agent-${task.id}`;

    this.logger.info(`Creating task agent: ${taskAgentId}`, { task });

    // 创建 task agent 状态
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

      // 创建 agent runtime
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

      // 启动 agent
      runtime.start();

      // 发送初始任务消息
      localBus.publish({
        type: `kairo.agent.${taskAgentId}.message`,
        source: "task-agent-manager",
        data: {
          content: this.buildTaskPrompt(task),
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

  /**
   * 构建任务提示词
   */
  private buildTaskPrompt(task: Task): string {
    return `
【长程任务委派】

你是一个专门执行长程任务的 Task Agent。你的职责是：
1. 专注完成以下任务，不被其他事情干扰
2. 定期报告进度给主 Agent
3. 任务完成后汇报结果

【任务详情】
- 任务ID: ${task.id}
- 描述: ${task.description}
- 总步骤: ${task.progress?.total || "未知"}
- 当前进度: ${task.progress?.current || 0}

【任务上下文】
${JSON.stringify(task.context, null, 2)}

【执行要求】
1. 每完成 ${task.config?.checkpointInterval || 10} 步，使用 say 动作报告进度，并设置 continue: true
2. 进度格式：✅ 已完成第 X 步 (X/${task.progress?.total})
3. 遇到错误时立即报告，不要继续执行
4. 完成所有步骤后，使用 finish 动作结束任务

【重要】
- 你是独立的 Task Agent，主 Agent 可能正在处理其他用户请求
- 你的进度报告会自动转发给主 Agent 和用户
- 不要等待用户确认，持续执行直到完成

现在开始执行任务。
`.trim();
  }

  /**
   * 停止 task agent
   */
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

  /**
   * 获取 task agent 状态
   */
  getTaskAgentState(taskAgentId: string): TaskAgentState | undefined {
    return this.taskAgents.get(taskAgentId);
  }

  /**
   * 获取所有活跃的 task agents
   */
  getActiveTaskAgents(): TaskAgentState[] {
    return Array.from(this.taskAgents.values()).filter(
      state => state.status === "running" || state.status === "paused"
    );
  }

  /**
   * 处理任务创建事件
   */
  private async handleTaskCreated(event: KairoEvent) {
    const { task } = event.data as { task: Task };

    // 只为长程任务创建 task agent
    if (task.type !== TaskType.LONG) return;

    try {
      const taskAgentId = await this.createTaskAgent(task);

      // 通知主 agent
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

      // 通知主 agent 失败
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

  /**
   * 处理任务取消事件
   */
  private async handleTaskCancelled(event: KairoEvent) {
    const { taskId } = event.data as { taskId: string };

    // 查找对应的 task agent
    for (const [agentId, state] of this.taskAgents.entries()) {
      if (state.taskId === taskId) {
        await this.stopTaskAgent(agentId);
        break;
      }
    }
  }

  /**
   * 处理 task agent 的进度报告
   */
  private handleTaskAgentProgress(event: KairoEvent) {
    const { taskAgentId, taskId, progress, message } = event.data as any;

    const state = this.taskAgents.get(taskAgentId);
    if (!state) return;

    state.lastProgressReport = Date.now();

    // 更新任务进度
    if (progress) {
      this.orchestrator.updateProgress(taskId, progress);
    }

    // 转发进度给主 agent
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

  /**
   * 处理 task agent 完成
   */
  private async handleTaskAgentCompleted(event: KairoEvent) {
    const { taskAgentId, taskId, result, error } = event.data as any;

    const state = this.taskAgents.get(taskAgentId);
    if (!state) return;

    let completionError = error ? String(error) : undefined;
    if (!completionError && this.reviewEnabled) {
      try {
        const review = await this.bus.request<
          { scope: string; taskId: string; taskAgentId: string; result?: any },
          { ok?: boolean; reasons?: string[] }
        >(
          "kairo.review.request",
          {
            scope: "task-completion",
            taskId,
            taskAgentId,
            result,
          },
          this.reviewTimeoutMs,
        );
        if (review?.ok === false) {
          const reason = Array.isArray(review.reasons) && review.reasons.length > 0
            ? review.reasons.join("; ")
            : "unknown_review_failure";
          completionError = `Review 未通过: ${reason}`;
        }
      } catch (reviewError) {
        this.logger.warn("task completion review timeout, fallback to complete", { taskId, reviewError });
      }
    }

    if (completionError) {
      state.status = "failed";
      this.orchestrator.failTask(taskId, completionError);
    } else {
      state.status = "completed";
      this.orchestrator.completeTask(taskId, result);
    }

    // 通知主 agent
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

    // 停止 task agent
    await this.stopTaskAgent(taskAgentId);
  }

  /**
   * 清理已完成的 task agents
   */
  cleanup() {
    const now = Date.now();
    const timeout = 60 * 60 * 1000; // 1 小时

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
