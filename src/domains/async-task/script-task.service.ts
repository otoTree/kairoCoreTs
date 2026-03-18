import type { AgentPlugin, SystemToolContext } from "../agent";
import type { KernelPlugin } from "../kernel/kernel.plugin";
import type { StateRepository } from "../database/repositories/state-repository";
import { normalizeRepeat, resolveNextRun } from "./cron";
import { ScriptTaskLogBuffer } from "./script-task-log-buffer";
import { ScriptTaskReporter } from "./script-task-reporter";
import type {
  CreateScriptTaskInput,
  ScriptTask,
  ScriptTaskProcessBinding,
  ScriptTaskRun,
  ScriptTaskStatus,
} from "./script-task.types";

export class ScriptTaskService {
  private readonly tasks = new Map<string, ScriptTask>();
  private readonly runs = new Map<string, ScriptTaskRun>();
  private readonly processBindings = new Map<string, ScriptTaskProcessBinding>();
  private readonly scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly taskPrefix = "async-task:script:task:";
  private readonly runPrefix = "async-task:script:run:";
  private readonly bindingPrefix = "async-task:script:binding:";
  private readonly outputHandler = (event: { id: string; type: "stdout" | "stderr"; data: Uint8Array }) => {
    void this.handleProcessOutput(event.id, event.type, event.data);
  };
  private readonly exitHandler = (event: { id: string; code: number }) => {
    void this.handleProcessExit(event.id, event.code);
  };
  private readonly logBuffer = new ScriptTaskLogBuffer();
  private readonly reporter: ScriptTaskReporter;

  constructor(
    private readonly agent: AgentPlugin,
    private readonly kernel?: KernelPlugin,
    private readonly stateRepo?: StateRepository,
  ) {
    this.reporter = new ScriptTaskReporter(agent);
  }

  async start() {
    if (!this.kernel) {
      return;
    }
    this.kernel.processManager.on("output", this.outputHandler);
    this.kernel.processManager.on("exit", this.exitHandler);
    await this.recoverState();
    this.registerTools();
  }

  stop() {
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
    if (this.kernel) {
      this.kernel.processManager.off("output", this.outputHandler);
      this.kernel.processManager.off("exit", this.exitHandler);
    }
  }

  private registerTools() {
    this.agent.registerSystemTool({
      name: "kairo_async_script_run",
      description: "Run a script task immediately in the background.",
      inputSchema: this.buildScriptTaskSchema(),
    }, async (args: any, context: SystemToolContext) => {
      const task = await this.createTask(args, context, true);
      const run = task.lastRunId ? this.runs.get(task.lastRunId) : undefined;
      return {
        taskId: task.taskId,
        runId: run?.runId,
        processId: run?.processId,
        status: task.status,
        startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_schedule",
      description: "Schedule a script task for future or repeated execution.",
      inputSchema: this.buildScriptTaskSchema(true),
    }, async (args: any, context: SystemToolContext) => {
      const task = await this.createTask(args, context, false);
      return {
        taskId: task.taskId,
        status: task.status,
        executeAt: task.nextExecuteAt ? new Date(task.nextExecuteAt).toISOString() : undefined,
        waitMs: task.nextExecuteAt ? Math.max(0, task.nextExecuteAt - Date.now()) : 0,
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_status",
      description: "Query the current status of a script task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const task = this.getVisibleTask(String(args.taskId), context.agentId || "default");
      const latestRun = task.lastRunId ? this.runs.get(task.lastRunId) : undefined;
      const runtime = task.lastProcessId ? this.kernel?.processManager.getStatus(task.lastProcessId) : undefined;
      return {
        task,
        latestRun,
        runtime,
        nextExecuteAt: task.nextExecuteAt,
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_list",
      description: "List visible script tasks for the caller.",
      inputSchema: { type: "object", properties: {} },
    }, async (_args: any, context: SystemToolContext) => {
      const viewer = context.agentId || "default";
      const visible = Array.from(this.tasks.values())
        .filter((task) => this.canViewTask(task, viewer))
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        scheduled: visible.filter((task) => task.status === "scheduled"),
        running: visible.filter((task) => task.status === "starting" || task.status === "running"),
        recentCompleted: visible.filter((task) => ["succeeded", "failed", "cancelled"].includes(task.status)),
      };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_runs",
      description: "List historical runs for a script task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const task = this.getVisibleTask(String(args.taskId), context.agentId || "default");
      const runs = Array.from(this.runs.values())
        .filter((run) => run.taskId === task.taskId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return { taskId: task.taskId, runs };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_cancel",
      description: "Cancel a scheduled script task and optionally kill the active run.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          killRunning: { type: "boolean" },
        },
        required: ["taskId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const task = this.getOwnedTask(String(args.taskId), context.agentId || "default");
      const timer = this.scheduleTimers.get(task.taskId);
      if (timer) {
        clearTimeout(timer);
        this.scheduleTimers.delete(task.taskId);
      }
      task.repeat = undefined;
      task.nextExecuteAt = undefined;
      if (args.killRunning && task.lastProcessId && (task.status === "running" || task.status === "starting")) {
        this.kernel?.processManager.kill(task.lastProcessId);
      } else if (task.status === "scheduled") {
        task.status = "cancelled";
        task.endedAt = Date.now();
        await this.persistTask(task);
      }
      return { taskId: task.taskId, status: task.status };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_kill",
      description: "Kill the currently running process for a script task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const task = this.getOwnedTask(String(args.taskId), context.agentId || "default");
      if (!task.lastProcessId) {
        throw new Error(`Task ${task.taskId} has no active process`);
      }
      this.kernel?.processManager.kill(task.lastProcessId);
      return { taskId: task.taskId, processId: task.lastProcessId, status: "cancelling" };
    });

    this.agent.registerSystemTool({
      name: "kairo_async_script_rerun",
      description: "Trigger an existing script task immediately without changing its schedule.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
    }, async (args: any, context: SystemToolContext) => {
      const task = this.getOwnedTask(String(args.taskId), context.agentId || "default");
      const run = await this.startTask(task.taskId, true);
      return {
        taskId: task.taskId,
        runId: run.runId,
        processId: run.processId,
        status: task.status,
      };
    });
  }

  private buildScriptTaskSchema(allowSchedule = false) {
    return {
      type: "object",
      properties: {
        description: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object" },
        inlineScript: { type: "string" },
        shell: { type: "string" },
        delayMs: { type: "number" },
        runAt: { type: "string" },
        repeat: {
          type: "object",
          properties: {
            intervalMs: { type: "number" },
            cron: { type: "string" },
          },
        },
        reportToAgentId: { type: "string" },
        executionPolicy: {
          type: "object",
          properties: {
            allowConcurrentRuns: { type: "boolean" },
            overlapStrategy: { type: "string", enum: ["skip", "queue_one", "parallel"] },
            timeoutMs: { type: "number" },
          },
        },
        reportPolicy: {
          type: "object",
          properties: {
            onSuccess: { type: "boolean" },
            onFailure: { type: "boolean" },
            includeOutputSummary: { type: "boolean" },
            includeLogPaths: { type: "boolean" },
            triggerFollowupAgentTask: { type: "boolean" },
            followupDescriptionTemplate: { type: "string" },
          },
        },
        artifacts: { type: "object" },
      },
      required: allowSchedule ? ["description", "command"] : ["description", "command"],
    };
  }

  private async createTask(args: any, context: SystemToolContext, forceImmediate: boolean) {
    if (!this.kernel) {
      throw new Error("Kernel service is not available");
    }
    const ownerAgentId = context.agentId || "default";
    const input = this.normalizeInput(args, ownerAgentId);
    const taskId = `script_task_${crypto.randomUUID().slice(0, 12)}`;
    const task: ScriptTask = {
      taskId,
      ownerAgentId,
      reportToAgentId: input.reportToAgentId || ownerAgentId,
      description: input.description,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      inlineScript: input.inlineScript,
      shell: input.shell,
      createdAt: Date.now(),
      scheduledAt: undefined,
      nextExecuteAt: undefined,
      repeat: input.repeat,
      status: "scheduled",
      runCount: 0,
      executionPolicy: {
        overlapStrategy: "skip",
        ...input.executionPolicy,
      },
      reportPolicy: {
        onSuccess: true,
        onFailure: true,
        includeOutputSummary: true,
        includeLogPaths: true,
        ...input.reportPolicy,
      },
      artifacts: input.artifacts,
    };

    this.tasks.set(taskId, task);
    await this.persistTask(task);

    const immediate = forceImmediate || this.isImmediate(input);
    if (immediate) {
      await this.startTask(taskId, true);
    } else {
      task.nextExecuteAt = this.resolveExecuteAt(input.delayMs, input.runAt);
      task.scheduledAt = task.nextExecuteAt;
      task.status = "scheduled";
      this.armSchedule(task);
      await this.persistTask(task);
    }
    return task;
  }

  private normalizeInput(args: any, ownerAgentId: string): CreateScriptTaskInput {
    if (typeof args?.description !== "string" || args.description.trim().length === 0) {
      throw new Error("description is required");
    }
    if (typeof args?.command !== "string" || args.command.trim().length === 0) {
      throw new Error("command is required");
    }
    const repeat = normalizeRepeat(args.repeat);
    return {
      description: args.description.trim(),
      command: args.command.trim(),
      args: Array.isArray(args.args) ? args.args.map((item: unknown) => String(item)) : undefined,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      env: args.env && typeof args.env === "object" ? Object.fromEntries(
        Object.entries(args.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
      ) : undefined,
      inlineScript: typeof args.inlineScript === "string" ? args.inlineScript : undefined,
      shell: typeof args.shell === "string" ? args.shell : undefined,
      delayMs: typeof args.delayMs === "number" ? args.delayMs : undefined,
      runAt: typeof args.runAt === "string" ? args.runAt : undefined,
      repeat,
      reportToAgentId: typeof args.reportToAgentId === "string" ? args.reportToAgentId : ownerAgentId,
      executionPolicy: args.executionPolicy && typeof args.executionPolicy === "object" ? args.executionPolicy : undefined,
      reportPolicy: args.reportPolicy && typeof args.reportPolicy === "object" ? args.reportPolicy : undefined,
      artifacts: args.artifacts && typeof args.artifacts === "object" ? args.artifacts : undefined,
    };
  }

  private isImmediate(input: CreateScriptTaskInput) {
    return input.delayMs === undefined && !input.runAt && !input.repeat;
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

  private armSchedule(task: ScriptTask) {
    const existing = this.scheduleTimers.get(task.taskId);
    if (existing) {
      clearTimeout(existing);
    }
    const waitMs = Math.max(0, (task.nextExecuteAt || Date.now()) - Date.now());
    const timer = setTimeout(() => {
      void this.startTask(task.taskId, false);
    }, waitMs);
    this.scheduleTimers.set(task.taskId, timer);
  }

  private async startTask(taskId: string, manualTrigger: boolean): Promise<ScriptTaskRun> {
    const task = this.tasks.get(taskId);
    if (!task || !this.kernel) {
      throw new Error(`Task ${taskId} not found`);
    }

    const activeRun = task.lastRunId ? this.runs.get(task.lastRunId) : undefined;
    const isBusy = activeRun && (activeRun.status === "starting" || activeRun.status === "running");
    const strategy = task.executionPolicy?.allowConcurrentRuns ? "parallel" : task.executionPolicy?.overlapStrategy || "skip";

    if (isBusy && strategy !== "parallel") {
      if (strategy === "queue_one") {
        task.pendingRun = true;
        await this.persistTask(task);
      }
      if (!manualTrigger) {
        if (task.repeat) {
          task.nextExecuteAt = resolveNextRun(task.repeat, Date.now());
          task.status = "scheduled";
          this.armSchedule(task);
          await this.persistTask(task);
        }
        throw new Error(`Task ${task.taskId} is already running`);
      }
      throw new Error(`Task ${task.taskId} is already running`);
    }

    this.scheduleTimers.delete(task.taskId);
    const runId = `script_run_${crypto.randomUUID().slice(0, 12)}`;
    const processId = `script_proc_${crypto.randomUUID().slice(0, 12)}`;
    const command = this.buildCommand(task);
    const startedAt = Date.now();
    const logs = await this.logBuffer.initialize(task.taskId, runId);
    const run: ScriptTaskRun = {
      runId,
      taskId: task.taskId,
      processId,
      startedAt,
      status: "starting",
      stdoutLogPath: logs.stdoutLogPath,
      stderrLogPath: logs.stderrLogPath,
    };
    const binding: ScriptTaskProcessBinding = {
      processId,
      taskId: task.taskId,
      runId,
      ownerAgentId: task.ownerAgentId,
    };

    this.runs.set(runId, run);
    this.processBindings.set(processId, binding);
    task.status = "starting";
    task.startedAt = startedAt;
    task.endedAt = undefined;
    task.lastRunId = runId;
    task.lastProcessId = processId;
    task.lastError = undefined;
    task.pendingRun = false;

    await this.persistRun(run);
    await this.persistBinding(binding);
    await this.persistTask(task);

    try {
      await this.kernel.processManager.spawn(processId, command, {
        cwd: task.cwd,
        env: task.env,
      }, task.ownerAgentId);
      run.status = "running";
      task.status = "running";
      task.runCount += 1;
      await this.persistRun(run);
      await this.persistTask(task);

      if (task.executionPolicy?.timeoutMs && task.executionPolicy.timeoutMs > 0) {
        setTimeout(() => {
          const latest = this.runs.get(runId);
          if (latest && (latest.status === "starting" || latest.status === "running")) {
            this.kernel?.processManager.kill(processId);
          }
        }, task.executionPolicy.timeoutMs);
      }

      await this.publishEvent("kairo.async.script.started", {
        taskId: task.taskId,
        runId,
        processId,
        ownerAgentId: task.ownerAgentId,
      });
      return run;
    } catch (error: any) {
      run.status = "failed";
      run.error = error?.message || String(error);
      run.endedAt = Date.now();
      run.durationMs = run.endedAt - run.startedAt;
      task.status = "failed";
      task.endedAt = run.endedAt;
      task.lastError = run.error;
      await this.persistRun(run);
      await this.persistTask(task);
      throw error;
    }
  }

  private buildCommand(task: ScriptTask) {
    if (task.inlineScript) {
      const shell = task.shell || task.command || "/bin/sh";
      return [shell, "-c", task.inlineScript];
    }
    return [task.command, ...(task.args || [])];
  }

  private async handleProcessOutput(processId: string, type: "stdout" | "stderr", data: Uint8Array) {
    const binding = this.processBindings.get(processId);
    if (!binding) {
      return;
    }
    const run = this.runs.get(binding.runId);
    if (!run) {
      return;
    }
    await this.logBuffer.append(run.runId, type, data);
    Object.assign(run, this.logBuffer.snapshot(run.runId));
    await this.persistRun(run);
  }

  private async handleProcessExit(processId: string, code: number) {
    const binding = this.processBindings.get(processId);
    if (!binding) {
      return;
    }
    const task = this.tasks.get(binding.taskId);
    const run = this.runs.get(binding.runId);
    if (!task || !run) {
      return;
    }

    await this.logBuffer.flush(run.runId);
    Object.assign(run, this.logBuffer.snapshot(run.runId));
    run.endedAt = Date.now();
    run.durationMs = run.endedAt - run.startedAt;
    run.exitCode = code;
    run.status = this.resolveFinalStatus(task, code);
    if (run.status !== "succeeded") {
      run.error = run.error || task.lastError;
    }
    run.summary = this.buildRunSummary(task, run);

    task.status = run.status;
    task.endedAt = run.endedAt;
    task.lastExitCode = code;
    task.lastError = run.status === "succeeded" ? undefined : (run.error || `Process exited with code ${code}`);

    await this.persistRun(run);
    await this.persistTask(task);
    await this.publishEvent("kairo.async.script.process_exited", {
      taskId: task.taskId,
      runId: run.runId,
      processId,
      exitCode: code,
      status: run.status,
    });
    await this.reporter.reportCompletion(task, run);

    const shouldQueueNext = Boolean(task.repeat);
    if (shouldQueueNext) {
      task.status = "scheduled";
      task.nextExecuteAt = resolveNextRun(task.repeat!, run.endedAt);
      await this.persistTask(task);
      this.armSchedule(task);
    }

    this.logBuffer.close(run.runId);
    await this.stateRepo?.delete(`${this.bindingPrefix}${processId}`);
    this.processBindings.delete(processId);

    if (task.pendingRun) {
      task.pendingRun = false;
      await this.persistTask(task);
      await this.startTask(task.taskId, true);
    }
  }

  private resolveFinalStatus(task: ScriptTask, code: number): ScriptTaskStatus {
    if (task.status === "cancelled" || code === -1) {
      return "cancelled";
    }
    return code === 0 ? "succeeded" : "failed";
  }

  private buildRunSummary(task: ScriptTask, run: ScriptTaskRun) {
    return [
      `Script task "${task.description}" finished with status ${run.status}.`,
      `exitCode=${run.exitCode ?? "unknown"}`,
      run.stderrTail ? `stderr=${run.stderrTail}` : undefined,
    ].filter(Boolean).join(" ");
  }

  private canViewTask(task: ScriptTask, viewer: string) {
    return task.ownerAgentId === viewer || task.reportToAgentId === viewer;
  }

  private getVisibleTask(taskId: string, viewer: string) {
    const task = this.tasks.get(taskId);
    if (!task || !this.canViewTask(task, viewer)) {
      throw new Error(`Script task ${taskId} not found`);
    }
    return task;
  }

  private getOwnedTask(taskId: string, ownerAgentId: string) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Script task ${taskId} not found`);
    }
    if (task.ownerAgentId !== ownerAgentId) {
      throw new Error(`No permission to operate script task ${taskId}`);
    }
    return task;
  }

  private async publishEvent(type: string, data: unknown) {
    await this.agent.globalBus.publish({
      type,
      source: "domain:async-task",
      data,
    });
  }

  private async persistTask(task: ScriptTask) {
    await this.stateRepo?.save(`${this.taskPrefix}${task.taskId}`, task);
  }

  private async persistRun(run: ScriptTaskRun) {
    await this.stateRepo?.save(`${this.runPrefix}${run.runId}`, run);
  }

  private async persistBinding(binding: ScriptTaskProcessBinding) {
    await this.stateRepo?.save(`${this.bindingPrefix}${binding.processId}`, binding);
  }

  private async recoverState() {
    if (!this.stateRepo || !this.kernel) {
      return;
    }
    const [tasks, runs, bindings] = await Promise.all([
      this.stateRepo.getByPrefix<ScriptTask>(this.taskPrefix),
      this.stateRepo.getByPrefix<ScriptTaskRun>(this.runPrefix),
      this.stateRepo.getByPrefix<ScriptTaskProcessBinding>(this.bindingPrefix),
    ]);

    for (const record of tasks) {
      this.tasks.set(record.value.taskId, record.value);
    }
    for (const record of runs) {
      this.runs.set(record.value.runId, record.value);
      this.logBuffer.restore(record.value);
    }
    for (const record of bindings) {
      this.processBindings.set(record.value.processId, record.value);
    }

    for (const task of this.tasks.values()) {
      if (task.status === "scheduled" && task.nextExecuteAt) {
        if (task.repeat && task.nextExecuteAt < Date.now()) {
          task.nextExecuteAt = resolveNextRun(task.repeat, Date.now());
          await this.persistTask(task);
        }
        this.armSchedule(task);
      }

      if ((task.status === "running" || task.status === "starting") && task.lastProcessId && task.lastRunId) {
        const runtime = this.kernel.processManager.getStatus(task.lastProcessId);
        const run = this.runs.get(task.lastRunId);
        if (!run) {
          continue;
        }
        if (runtime.state === "running") {
          continue;
        }
        if (runtime.state === "exited") {
          await this.handleProcessExit(task.lastProcessId, runtime.exitCode ?? -1);
          continue;
        }
        run.status = "failed";
        run.error = "Process status unknown during recovery";
        run.endedAt = Date.now();
        run.durationMs = run.endedAt - run.startedAt;
        task.status = "failed";
        task.endedAt = run.endedAt;
        task.lastError = run.error;
        await this.persistRun(run);
        await this.persistTask(task);
      }
    }
  }
}
