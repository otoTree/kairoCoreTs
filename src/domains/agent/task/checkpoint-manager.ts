import type { EventBus } from "../../events";
import type { Task, TaskOrchestrator } from "./task-orchestrator";
import { rootLogger } from "../../observability/logger";
import type { Logger } from "../../observability/types";
import * as fs from "fs/promises";
import * as path from "path";

export interface Checkpoint {
  taskId: string;
  timestamp: number;
  progress: Task["progress"];
  context: Record<string, any>;
  metadata?: Record<string, any>;
}

export class CheckpointManager {
  private orchestrator: TaskOrchestrator;
  private bus: EventBus;
  private logger: Logger;
  private checkpointDir: string;

  constructor(
    orchestrator: TaskOrchestrator,
    bus: EventBus,
    checkpointDir: string = process.env.KAIRO_CHECKPOINT_DIR || path.join(process.cwd(), "data", "checkpoints"),
  ) {
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
    this.bus.subscribe("kairo.task.progress", this.handleProgress.bind(this));
    this.bus.subscribe("kairo.task.completed", this.handleCompleted.bind(this));
    this.bus.subscribe("kairo.task.failed", this.handleCompleted.bind(this));
    this.bus.subscribe("kairo.task.cancelled", this.handleCompleted.bind(this));
  }

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
      this.bus.publish({
        type: "kairo.task.checkpoint.saved",
        source: "checkpoint-manager",
        data: { taskId, checkpoint },
      });
    } catch (error) {
      this.logger.error(`Failed to save checkpoint: ${taskId}`, { error });
    }
  }

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

    task.progress = checkpoint.progress;
    task.context = { ...task.context, ...checkpoint.context };

    this.logger.info(`Task restored from checkpoint: ${taskId}`, {
      progress: checkpoint.progress,
    });

    this.bus.publish({
      type: "kairo.task.checkpoint.restored",
      source: "checkpoint-manager",
      data: { taskId, checkpoint },
    });

    this.orchestrator.resumeTask(taskId);
    return true;
  }

  private getCheckpointPath(taskId: string): string {
    return path.join(this.checkpointDir, `${taskId}.json`);
  }

  private async handleProgress(event: any) {
    const { taskId, task } = event.data;
    if (!taskId || !task) return;

    const checkpointInterval = task.config?.checkpointInterval;
    if (!checkpointInterval) return;

    const progress = task.progress;
    if (!progress) return;

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
    await this.deleteCheckpoint(taskId);
  }
}

export async function exampleCrashRecovery(
  orchestrator: TaskOrchestrator,
  checkpointManager: CheckpointManager
) {
  const checkpoints = await checkpointManager.listCheckpoints();

  for (const checkpoint of checkpoints) {
    const task = orchestrator.getTask(checkpoint.taskId);

    if (task && (task.status === "running" || task.status === "paused")) {
      console.log(`发现未完成的任务: ${task.description}`);
      console.log(`进度: ${checkpoint.progress?.current}/${checkpoint.progress?.total}`);
      await checkpointManager.restoreTask(checkpoint.taskId);
      console.log("任务已恢复");
    }
  }
}
