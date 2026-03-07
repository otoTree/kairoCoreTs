import type { EventBus, KairoEvent } from "../events";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";

/**
 * 任务状态
 */
export enum TaskStatus {
  PENDING = "pending",      // 等待开始
  RUNNING = "running",      // 执行中
  PAUSED = "paused",        // 暂停（等待用户输入等）
  COMPLETED = "completed",  // 已完成
  FAILED = "failed",        // 失败
  CANCELLED = "cancelled"   // 已取消
}

/**
 * 任务类型
 */
export enum TaskType {
  SHORT = "short",          // 短任务（单次交互）
  LONG = "long",            // 长任务（多步骤）
  BACKGROUND = "background" // 后台任务
}

/**
 * 任务定义
 */
export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  agentId: string;

  // 任务上下文
  context?: Record<string, any>;

  // 进度跟踪
  progress?: {
    current: number;
    total: number;
    message?: string;
  };

  // 时间戳
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  // 关联事件
  correlationId?: string;
  parentTaskId?: string;

  // 任务配置
  config?: {
    maxRetries?: number;
    timeout?: number;
    autoResume?: boolean;  // 是否自动恢复
    checkpointInterval?: number; // 检查点间隔
  };
}

/**
 * 任务事件
 */
export interface TaskEvent {
  taskId: string;
  type: "created" | "started" | "progress" | "paused" | "resumed" | "completed" | "failed" | "cancelled";
  data?: any;
  timestamp: number;
}

/**
 * 任务编排器 - 管理长程任务的生命周期
 */
export class TaskOrchestrator {
  private tasks: Map<string, Task> = new Map();
  private bus: EventBus;
  private logger: Logger;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.logger = rootLogger.child({ component: "TaskOrchestrator" });
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // 监听 agent 进度事件
    this.bus.subscribe("kairo.agent.progress", this.handleProgress.bind(this));

    // 监听 intent 开始/结束
    this.bus.subscribe("kairo.intent.started", this.handleIntentStarted.bind(this));
    this.bus.subscribe("kairo.intent.ended", this.handleIntentEnded.bind(this));

    // 监听取消事件
    this.bus.subscribe("kairo.cancel", this.handleCancel.bind(this));
  }

  /**
   * 创建新任务
   */
  createTask(params: {
    type: TaskType;
    description: string;
    agentId: string;
    context?: Record<string, any>;
    config?: Task["config"];
    correlationId?: string;
    parentTaskId?: string;
  }): Task {
    const totalFromContext = Number((params.context as any)?.totalSteps);
    const hasValidTotal = Number.isFinite(totalFromContext) && totalFromContext > 0;
    const task: Task = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: params.type,
      status: TaskStatus.PENDING,
      description: params.description,
      agentId: params.agentId,
      context: params.context,
      progress: hasValidTotal ? { current: 0, total: totalFromContext } : undefined,
      config: params.config,
      correlationId: params.correlationId,
      parentTaskId: params.parentTaskId,
      createdAt: Date.now(),
    };

    this.tasks.set(task.id, task);
    this.emitTaskEvent(task.id, "created");

    this.logger.info(`Task created: ${task.id}`, { task });

    return task;
  }

  /**
   * 启动任务
   */
  startTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== TaskStatus.PENDING) {
      throw new Error(`Task ${taskId} cannot be started from status ${task.status}`);
    }

    task.status = TaskStatus.RUNNING;
    task.startedAt = Date.now();

    this.emitTaskEvent(taskId, "started");
    this.logger.info(`Task started: ${taskId}`);
  }

  /**
   * 更新任务进度
   */
  updateProgress(taskId: string, progress: Task["progress"]) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.progress = progress;
    this.emitTaskEvent(taskId, "progress", { progress });
  }

  /**
   * 暂停任务
   */
  pauseTask(taskId: string, reason?: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.RUNNING) return;

    task.status = TaskStatus.PAUSED;
    this.emitTaskEvent(taskId, "paused", { reason });
    this.logger.info(`Task paused: ${taskId}`, { reason });
  }

  /**
   * 恢复任务
   */
  resumeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.PAUSED) return;

    task.status = TaskStatus.RUNNING;
    this.emitTaskEvent(taskId, "resumed");
    this.logger.info(`Task resumed: ${taskId}`);

    // 发送内部继续事件给 agent
    this.bus.publish({
      type: `kairo.agent.${task.agentId}.message`,
      source: "task-orchestrator",
      data: {
        content: `[任务恢复] 继续执行任务: ${task.description}`,
        taskId: task.id,
        context: task.context,
      },
      correlationId: task.correlationId,
    });
  }

  /**
   * 完成任务
   */
  completeTask(taskId: string, result?: any) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = TaskStatus.COMPLETED;
    task.completedAt = Date.now();

    this.emitTaskEvent(taskId, "completed", { result });
    this.logger.info(`Task completed: ${taskId}`, {
      duration: task.completedAt - (task.startedAt || task.createdAt)
    });
  }

  /**
   * 任务失败
   */
  failTask(taskId: string, error: any) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = TaskStatus.FAILED;
    task.completedAt = Date.now();

    this.emitTaskEvent(taskId, "failed", { error });
    this.logger.error(`Task failed: ${taskId}`, { error });
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string, reason?: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = TaskStatus.CANCELLED;
    task.completedAt = Date.now();

    this.emitTaskEvent(taskId, "cancelled", { reason });
    this.logger.info(`Task cancelled: ${taskId}`, { reason });
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取 agent 的所有活跃任务
   */
  getActiveTasks(agentId: string): Task[] {
    return Array.from(this.tasks.values()).filter(
      task => task.agentId === agentId &&
              (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PAUSED)
    );
  }

  /**
   * 检查是否应该自动继续
   */
  shouldAutoContinue(agentId: string): boolean {
    const activeTasks = this.getActiveTasks(agentId);
    return activeTasks.some(task =>
      task.type === TaskType.LONG &&
      task.status === TaskStatus.RUNNING &&
      task.config?.autoResume !== false
    );
  }

  private emitTaskEvent(taskId: string, type: TaskEvent["type"], data?: any) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.bus.publish({
      type: `kairo.task.${type}`,
      source: "task-orchestrator",
      data: {
        taskId,
        task,
        ...data,
      },
      correlationId: task.correlationId,
    });
  }

  private handleProgress(event: KairoEvent) {
    // 从进度事件中提取任务信息
    const data = event.data as any;
    if (!data.taskId) return;

    this.updateProgress(data.taskId, data.progress);
  }

  private handleIntentStarted(event: KairoEvent) {
    // 可以在这里自动创建任务
  }

  private handleIntentEnded(event: KairoEvent) {
    // 检查是否有关联的任务需要更新
  }

  private handleCancel(event: KairoEvent) {
    const data = event.data as any;
    if (data.taskId) {
      this.cancelTask(data.taskId, data.reason);
    }
  }

  /**
   * 清理已完成的任务（可选）
   */
  cleanup(olderThan: number = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, task] of this.tasks.entries()) {
      if (
        task.status === TaskStatus.COMPLETED ||
        task.status === TaskStatus.FAILED ||
        task.status === TaskStatus.CANCELLED
      ) {
        if (task.completedAt && now - task.completedAt > olderThan) {
          this.tasks.delete(id);
          this.logger.debug(`Cleaned up task: ${id}`);
        }
      }
    }
  }
}
