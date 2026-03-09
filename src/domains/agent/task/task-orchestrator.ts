import type { EventBus, KairoEvent } from "../../events";
import { rootLogger } from "../../observability/logger";
import type { Logger } from "../../observability/types";

export enum TaskStatus {
  PENDING = "pending",
  RUNNING = "running",
  PAUSED = "paused",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled"
}

export enum TaskType {
  SHORT = "short",
  LONG = "long",
  BACKGROUND = "background"
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  agentId: string;
  context?: Record<string, any>;
  progress?: {
    current: number;
    total: number;
    message?: string;
  };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  correlationId?: string;
  parentTaskId?: string;
  config?: {
    maxRetries?: number;
    timeout?: number;
    autoResume?: boolean;
    checkpointInterval?: number;
  };
}

export interface TaskEvent {
  taskId: string;
  type: "created" | "started" | "progress" | "paused" | "resumed" | "completed" | "failed" | "cancelled";
  data?: any;
  timestamp: number;
}

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
    this.bus.subscribe("kairo.agent.progress", this.handleProgress.bind(this));
    this.bus.subscribe("kairo.intent.started", this.handleIntentStarted.bind(this));
    this.bus.subscribe("kairo.intent.ended", this.handleIntentEnded.bind(this));
    this.bus.subscribe("kairo.cancel", this.handleCancel.bind(this));
  }

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

  updateProgress(taskId: string, progress: Task["progress"]) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.progress = progress;
    this.emitTaskEvent(taskId, "progress", { progress });
  }

  pauseTask(taskId: string, reason?: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.RUNNING) return;

    task.status = TaskStatus.PAUSED;
    this.emitTaskEvent(taskId, "paused", { reason });
    this.logger.info(`Task paused: ${taskId}`, { reason });
  }

  resumeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.PAUSED) return;

    task.status = TaskStatus.RUNNING;
    this.emitTaskEvent(taskId, "resumed");
    this.logger.info(`Task resumed: ${taskId}`);

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

  failTask(taskId: string, error: any) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = TaskStatus.FAILED;
    task.completedAt = Date.now();
    this.emitTaskEvent(taskId, "failed", { error });
    this.logger.error(`Task failed: ${taskId}`, { error });
  }

  cancelTask(taskId: string, reason?: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = TaskStatus.CANCELLED;
    task.completedAt = Date.now();
    this.emitTaskEvent(taskId, "cancelled", { reason });
    this.logger.info(`Task cancelled: ${taskId}`, { reason });
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByAgent(agentId: string): Task[] {
    return Array.from(this.tasks.values())
      .filter(task => task.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getActiveTasks(agentId: string): Task[] {
    return Array.from(this.tasks.values()).filter(
      task => task.agentId === agentId &&
              (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PAUSED)
    );
  }

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
    const data = event.data as any;
    if (!data.taskId) return;
    this.updateProgress(data.taskId, data.progress);
  }

  private handleIntentStarted(event: KairoEvent) {}

  private handleIntentEnded(event: KairoEvent) {}

  private handleCancel(event: KairoEvent) {
    const data = event.data as any;
    if (data.taskId) {
      this.cancelTask(data.taskId, data.reason);
    }
  }

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
