import type { AgentPlugin } from "../agent/agent.plugin";
import type { KernelPlugin } from "../kernel/kernel.plugin";
import type { StateRepository } from "../database/repositories/state-repository";
import type { SystemToolContext } from "../agent/runtime";
import { normalizeRepeat, resolveNextRun } from "./cron";
import type { ProcessTask, ScheduledTask } from "./async-task.types";

export class AsyncTaskService {
  private scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private scheduledTasks = new Map<string, ScheduledTask>();
  private processTasks = new Map<string, ProcessTask>();
  private readonly schedulePrefix = "async-task:schedule:";
  private readonly processPrefix = "async-task:process:";
  private readonly processExitHandler = (event: { id: string; code: number }) => {
    void this.handleProcessExit(event.id, event.code);
  };

  constructor(
    private readonly agent: AgentPlugin,
    private readonly kernel?: KernelPlugin,
    private readonly stateRepo?: StateRepository,
  ) {}

  async start() {
    if (this.kernel) {
      this.kernel.processManager.on("exit", this.processExitHandler);
    }
    await this.recoverState();
    this.registerTools();
  }

  stop() {
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
    if (this.kernel) {
      this.kernel.processManager.off("exit", this.processExitHandler);
    }
  }

  private registerTools() {
    this.agent.registerSystemTool({
      name: "kairo_async_schedule",
      description: "Schedule a delegated task for later execution.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description" },
          input: { type: "object", description: "Task input payload" },
          targetAgentId: { type: "string", description: "Target agent id" },
          delayMs: { type: "number", description: "Delay in milliseconds before execution" },
          runAt: { type: "string", description: "Absolute ISO datetime for execution" },
          repeat: {
            type: "object",
            description: "Repeat strategy. Either intervalMs or cron.",
            properties: {
              intervalMs: { type: "number", description: "Repeat interval in milliseconds" },
              cron: { type: "string", description: "Cron expression with 5 fields" },
            },
          },
        },
        required: ["description"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const requesterAgentId = context.agentId || "default";
      const repeat = normalizeRepeat(args.repeat);
      const executeAt = this.resolveExecuteAt(args.delayMs, args.runAt);
      const taskId = `async_sched_${crypto.randomUUID().slice(0, 12)}`;
      const task: ScheduledTask = {
        id: taskId,
        requesterAgentId,
        targetAgentId: args.targetAgentId,
        description: args.description,
        input: args.input,
        repeat,
        executeAt,
        createdAt: Date.now(),
        status: "scheduled",
        runCount: 0,
      };
      this.scheduledTasks.set(taskId, task);

      const waitMs = this.armSchedule(task);
      await this.persistScheduledTask(task);

      await this.publishAsyncEvent("kairo.async.schedule.created", {
        taskId,
        requesterAgentId,
        targetAgentId: task.targetAgentId,
        executeAt: new Date(executeAt).toISOString(),
        repeat,
      });

      return {
        taskId,
        status: task.status,
        executeAt: new Date(executeAt).toISOString(),
        waitMs,
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_schedule_cancel",
      description: "Cancel a scheduled task before it is dispatched.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Scheduled task id" },
        },
        required: ["taskId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const task = this.scheduledTasks.get(args.taskId);
      if (!task) {
        throw new Error(`Scheduled task ${args.taskId} not found`);
      }
      if (task.requesterAgentId !== context.agentId) {
        throw new Error(`No permission to cancel scheduled task ${args.taskId}`);
      }
      if (task.status !== "scheduled") {
        return { taskId: task.id, status: task.status };
      }
      const timer = this.scheduleTimers.get(task.id);
      if (timer) {
        clearTimeout(timer);
        this.scheduleTimers.delete(task.id);
      }
      task.status = "cancelled";
      await this.persistScheduledTask(task);
      await this.publishAsyncEvent("kairo.async.schedule.cancelled", {
        taskId: task.id,
        requesterAgentId: task.requesterAgentId,
      });
      return { taskId: task.id, status: task.status };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_tasks_list",
      description: "List async scheduled tasks and process tasks owned by the caller.",
      inputSchema: { type: "object", properties: {} },
    }, async (_args: any, context: SystemToolContext) => {
      const owner = context.agentId || "default";
      const scheduled = Array.from(this.scheduledTasks.values())
        .filter((task) => task.requesterAgentId === owner)
        .sort((a, b) => b.createdAt - a.createdAt);
      const processes = Array.from(this.processTasks.values())
        .filter((task) => task.ownerAgentId === owner)
        .sort((a, b) => b.createdAt - a.createdAt);
      return { scheduled, processes };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_process_start",
      description: "Start a long-running process in background and return immediately.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Optional process id" },
          command: { type: "string", description: "Executable command" },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments",
          },
          cwd: { type: "string", description: "Working directory" },
          env: { type: "object", description: "Environment variables" },
        },
        required: ["command"],
      },
    }, async (args: any, context: SystemToolContext) => {
      if (!this.kernel) {
        throw new Error("Kernel service is not available");
      }
      const ownerAgentId = context.agentId || "default";
      const processId = args.processId || `async_proc_${crypto.randomUUID().slice(0, 12)}`;
      const command = [args.command, ...((Array.isArray(args.args) ? args.args : []).map(String))];
      await this.kernel.processManager.spawn(processId, command, {
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        env: args.env && typeof args.env === "object" ? args.env : undefined,
      }, ownerAgentId);

      const task: ProcessTask = {
        processId,
        ownerAgentId,
        command,
        createdAt: Date.now(),
        status: "running",
      };
      this.processTasks.set(processId, task);
      await this.persistProcessTask(task);

      await this.publishAsyncEvent("kairo.async.process.started", {
        processId,
        ownerAgentId,
        command,
      });

      return {
        processId,
        status: task.status,
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_process_status",
      description: "Query long-running background process status.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process id" },
        },
        required: ["processId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      if (!this.kernel) {
        throw new Error("Kernel service is not available");
      }
      this.ensureProcessOwnership(args.processId, context.agentId || "default");
      const runtime = this.kernel.processManager.getStatus(args.processId);
      const tracked = this.processTasks.get(args.processId);
      return {
        processId: args.processId,
        runtime,
        tracked,
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_process_kill",
      description: "Kill a long-running background process.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process id" },
        },
        required: ["processId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      if (!this.kernel) {
        throw new Error("Kernel service is not available");
      }
      this.ensureProcessOwnership(args.processId, context.agentId || "default");
      this.kernel.processManager.kill(args.processId);
      const tracked = this.processTasks.get(args.processId);
      if (tracked) {
        tracked.status = "cancelled";
        tracked.endedAt = Date.now();
        await this.persistProcessTask(tracked);
      }
      await this.publishAsyncEvent("kairo.async.process.cancelled", {
        processId: args.processId,
        ownerAgentId: context.agentId || "default",
      });
      return {
        processId: args.processId,
        status: tracked?.status || "cancelled",
      };
    });
  }

  private resolveExecuteAt(delayMs: unknown, runAt: unknown): number {
    if (typeof runAt === "string" && runAt.trim().length > 0) {
      const parsed = Date.parse(runAt);
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid runAt datetime: ${runAt}`);
      }
      return parsed;
    }
    const normalizedDelay = typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : 0;
    if (normalizedDelay < 0) {
      throw new Error("delayMs must be >= 0");
    }
    return Date.now() + normalizedDelay;
  }

  private armSchedule(task: ScheduledTask): number {
    const existing = this.scheduleTimers.get(task.id);
    if (existing) {
      clearTimeout(existing);
    }
    const waitMs = Math.max(0, task.executeAt - Date.now());
    const timer = setTimeout(() => {
      void this.dispatchScheduledTask(task.id);
    }, waitMs);
    this.scheduleTimers.set(task.id, timer);
    return waitMs;
  }

  private async dispatchScheduledTask(taskId: string) {
    const task = this.scheduledTasks.get(taskId);
    if (!task || task.status !== "scheduled") return;

    this.scheduleTimers.delete(taskId);

    try {
      const targetAgentId = task.targetAgentId
        || this.agent.capabilityRegistry.findBestAgent(task.description)?.agentId
        || "default";

      const delegatedTaskId = await this.agent.delegateTask(task.requesterAgentId, targetAgentId, {
        description: task.description,
        input: task.input,
      });

      task.lastDispatchedAt = Date.now();
      task.runCount = (task.runCount || 0) + 1;
      task.delegatedTaskId = delegatedTaskId;
      task.error = undefined;

      if (task.repeat) {
        task.executeAt = resolveNextRun(task.repeat, task.lastDispatchedAt);
        task.status = "scheduled";
        this.armSchedule(task);
      } else {
        task.status = "dispatched";
      }
      await this.persistScheduledTask(task);

      await this.publishAsyncEvent("kairo.async.schedule.dispatched", {
        taskId: task.id,
        requesterAgentId: task.requesterAgentId,
        targetAgentId,
        delegatedTaskId,
        runCount: task.runCount,
        nextExecuteAt: task.status === "scheduled" ? new Date(task.executeAt).toISOString() : undefined,
      });

      await this.agent.globalBus.publish({
        type: `kairo.agent.${task.requesterAgentId}.message`,
        source: "async-task",
        data: {
          content: `[异步任务已触发] 任务 ${task.id} 已派发到 Agent ${targetAgentId}，子任务 ID: ${delegatedTaskId}`,
        },
      });
    } catch (e: any) {
      task.status = "failed";
      task.error = e?.message || String(e);
      await this.persistScheduledTask(task);
      await this.publishAsyncEvent("kairo.async.schedule.failed", {
        taskId: task.id,
        requesterAgentId: task.requesterAgentId,
        error: task.error,
      });
    }
  }

  private async handleProcessExit(processId: string, code: number) {
    const task = this.processTasks.get(processId);
    if (!task) return;
    if (task.status === "cancelled") return;

    task.status = code === 0 ? "exited" : "failed";
    task.exitCode = code;
    task.endedAt = Date.now();
    await this.persistProcessTask(task);

    await this.publishAsyncEvent("kairo.async.process.exited", {
      processId,
      ownerAgentId: task.ownerAgentId,
      exitCode: code,
      status: task.status,
    });

    await this.agent.globalBus.publish({
      type: `kairo.agent.${task.ownerAgentId}.message`,
      source: "async-task",
      data: {
        content: `[长任务结束] 进程 ${processId} 已退出，状态 ${task.status}，exitCode=${code}`,
      },
    });
  }

  private ensureProcessOwnership(processId: string, ownerAgentId: string) {
    const tracked = this.processTasks.get(processId);
    if (!tracked) {
      throw new Error(`Process ${processId} was not started by async task domain`);
    }
    if (tracked.ownerAgentId !== ownerAgentId) {
      throw new Error(`No permission to operate process ${processId}`);
    }
  }

  private async publishAsyncEvent(type: string, data: any) {
    await this.agent.globalBus.publish({
      type,
      source: "domain:async-task",
      data,
    });
  }

  private async persistScheduledTask(task: ScheduledTask) {
    if (!this.stateRepo) return;
    try {
      await this.stateRepo.save(`${this.schedulePrefix}${task.id}`, task);
    } catch (e) {
      console.warn("[AsyncTask] Failed to persist scheduled task:", e);
    }
  }

  private async persistProcessTask(task: ProcessTask) {
    if (!this.stateRepo) return;
    try {
      await this.stateRepo.save(`${this.processPrefix}${task.processId}`, task);
    } catch (e) {
      console.warn("[AsyncTask] Failed to persist process task:", e);
    }
  }

  private async recoverState() {
    if (!this.stateRepo) return;
    await this.recoverScheduledTasks();
    await this.recoverProcessTasks();
  }

  private async recoverScheduledTasks() {
    if (!this.stateRepo) return;
    try {
      const records = await this.stateRepo.getByPrefix<ScheduledTask>(this.schedulePrefix);
      for (const record of records) {
        const task = record.value;
        this.scheduledTasks.set(task.id, task);
        if (task.status === "scheduled") {
          this.armSchedule(task);
        }
      }
    } catch (e) {
      console.warn("[AsyncTask] Failed to recover scheduled tasks:", e);
    }
  }

  private async recoverProcessTasks() {
    if (!this.stateRepo || !this.kernel) return;
    try {
      const records = await this.stateRepo.getByPrefix<ProcessTask>(this.processPrefix);
      for (const record of records) {
        const task = record.value;
        const runtime = this.kernel.processManager.getStatus(task.processId);
        if (task.status === "running") {
          if (runtime.state === "running") {
            this.processTasks.set(task.processId, task);
            continue;
          }
          if (runtime.state === "exited") {
            task.status = runtime.exitCode === 0 ? "exited" : "failed";
            task.exitCode = runtime.exitCode;
            task.endedAt = Date.now();
          } else {
            task.status = "failed";
            task.exitCode = task.exitCode ?? -1;
            task.endedAt = Date.now();
          }
          await this.persistProcessTask(task);
        }
        this.processTasks.set(task.processId, task);
      }
    } catch (e) {
      console.warn("[AsyncTask] Failed to recover process tasks:", e);
    }
  }
}
