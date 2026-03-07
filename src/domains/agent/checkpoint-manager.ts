import type { EventBus } from "../events";
import type { Task, TaskOrchestrator } from "./task-orchestrator";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * 检查点数据
 */
export interface Checkpoint {
  taskId: string;
  timestamp: number;
  progress: Task["progress"];
  context: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * 检查点管理器 - 支持任务的持久化和恢复
 */
export class CheckpointManager {
  private orchestrator: TaskOrchestrator;
  private bus: EventBus;
  private logger: Logger;
  private checkpointDir: string;

  constructor(orchestrator: TaskOrchestrator, bus: EventBus, checkpointDir: string = "./.kairo/checkpoints") {
    this.orchestrator = orchestrator;
    this.bus = bus;
    this.logger = rootLogger.child({ component: "CheckpointManager" });
    this.checkpointDir = checkpointDir;

    this.setupEventHandlers();
    this.ensureCheckpointDir();
  }

  private async ensureCheckpointDir() {
    try {
      await fs.mkdir(this.checkpointDir, { recursive: true });
    } catch (error) {
      this.logger.error("Failed to create checkpoint directory", { error });
    }
  }

  private setupEventHandlers() {
    // 监听任务进度，自动保存检查点
    this.bus.subscribe("kairo.task.progress", this.handleProgress.bind(this));

    // 监听任务完成，清理检查点
    this.bus.subscribe("kairo.task.completed", this.handleCompleted.bind(this));
    this.bus.subscribe("kairo.task.failed", this.handleCompleted.bind(this));
    this.bus.subscribe("kairo.task.cancelled", this.handleCompleted.bind(this));
  }

  /**
   * 保存检查点
   */
  async saveCheckpoint(taskId: string, metadata?: Record<string, any>): Promise<void> {
    const task = this.orchestrator.getTask(taskId);
    if (!task) {
      this.logger.warn(`Task not found for checkpoint: ${taskId}`);
      return;
    }

    const checkpoint: Checkpoint = {
      taskId,
      timestamp: Date.now(),
      progress: task.progress,
      context: task.context || {},
      metadata,
    };

    const filePath = this.getCheckpointPath(taskId);

    try {
      await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
      this.logger.info(`Checkpoint saved: ${taskId}`, { progress: task.progress });

      // 发布检查点保存事件
      this.bus.publish({
        type: "kairo.task.checkpoint.saved",
        source: "checkpoint-manager",
        data: { taskId, checkpoint },
      });
    } catch (error) {
      this.logger.error(`Failed to save checkpoint: ${taskId}`, { error });
    }
  }

  /**
   * 加载检查点
   */
  async loadCheckpoint(taskId: string): Promise<Checkpoint | null> {
    const filePath = this.getCheckpointPath(taskId);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const checkpoint: Checkpoint = JSON.parse(content);
      this.logger.info(`Checkpoint loaded: ${taskId}`, { checkpoint });
      return checkpoint;
    } catch (error) {
      if ((error as any).code !== "ENOENT") {
        this.logger.error(`Failed to load checkpoint: ${taskId}`, { error });
      }
      return null;
    }
  }

  /**
   * 删除检查点
   */
  async deleteCheckpoint(taskId: string): Promise<void> {
    const filePath = this.getCheckpointPath(taskId);

    try {
      await fs.unlink(filePath);
      this.logger.info(`Checkpoint deleted: ${taskId}`);
    } catch (error) {
      if ((error as any).code !== "ENOENT") {
        this.logger.error(`Failed to delete checkpoint: ${taskId}`, { error });
      }
    }
  }

  /**
   * 列出所有检查点
   */
  async listCheckpoints(): Promise<Checkpoint[]> {
    try {
      const files = await fs.readdir(this.checkpointDir);
      const checkpoints: Checkpoint[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(this.checkpointDir, file);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            checkpoints.push(JSON.parse(content));
          } catch (error) {
            this.logger.warn(`Failed to read checkpoint file: ${file}`, { error });
          }
        }
      }

      return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      this.logger.error("Failed to list checkpoints", { error });
      return [];
    }
  }

  /**
   * 恢复任务从检查点
   */
  async restoreTask(taskId: string): Promise<boolean> {
    const checkpoint = await this.loadCheckpoint(taskId);
    if (!checkpoint) {
      this.logger.warn(`No checkpoint found for task: ${taskId}`);
      return false;
    }

    const task = this.orchestrator.getTask(taskId);
    if (!task) {
      this.logger.warn(`Task not found: ${taskId}`);
      return false;
    }

    // 恢复任务状态
    task.progress = checkpoint.progress;
    task.context = { ...task.context, ...checkpoint.context };

    this.logger.info(`Task restored from checkpoint: ${taskId}`, {
      progress: checkpoint.progress,
    });

    // 发布恢复事件
    this.bus.publish({
      type: "kairo.task.checkpoint.restored",
      source: "checkpoint-manager",
      data: { taskId, checkpoint },
    });

    // 恢复任务执行
    this.orchestrator.resumeTask(taskId);

    return true;
  }

  private getCheckpointPath(taskId: string): string {
    return path.join(this.checkpointDir, `${taskId}.json`);
  }

  private async handleProgress(event: any) {
    const { taskId, task } = event.data;
    if (!taskId || !task) return;

    // 检查是否需要保存检查点
    const checkpointInterval = task.config?.checkpointInterval;
    if (!checkpointInterval) return;

    const progress = task.progress;
    if (!progress) return;

    // 每隔 checkpointInterval 保存一次
    if (progress.current % checkpointInterval === 0) {
      await this.saveCheckpoint(taskId, {
        autoSaved: true,
        progressMilestone: progress.current,
      });
    }
  }

  private async handleCompleted(event: any) {
    const { taskId } = event.data;
    if (!taskId) return;

    // 任务完成后删除检查点
    await this.deleteCheckpoint(taskId);
  }
}

/**
 * 使用示例：崩溃恢复
 */
export async function exampleCrashRecovery(
  orchestrator: TaskOrchestrator,
  checkpointManager: CheckpointManager
) {
  // 启动时检查是否有未完成的任务
  const checkpoints = await checkpointManager.listCheckpoints();

  for (const checkpoint of checkpoints) {
    const task = orchestrator.getTask(checkpoint.taskId);

    if (task && (task.status === "running" || task.status === "paused")) {
      console.log(`发现未完成的任务: ${task.description}`);
      console.log(`进度: ${checkpoint.progress?.current}/${checkpoint.progress?.total}`);

      // 询问用户是否恢复
      // const shouldRestore = await askUser("是否恢复此任务？");

      // if (shouldRestore) {
      await checkpointManager.restoreTask(checkpoint.taskId);
      console.log("任务已恢复");
      // }
    }
  }
}
