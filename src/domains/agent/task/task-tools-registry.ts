import { TaskStatus, TaskType, type TaskOrchestrator } from "./task-orchestrator";
import type { SystemToolContext } from "../runtime";

type ToolArgs = Record<string, unknown>;

export interface RegisterSystemTool {
  (definition: unknown, handler: (args: ToolArgs, context: SystemToolContext) => Promise<unknown>): void;
}

export class AgentTaskTools {
  constructor(
    private readonly orchestrator: TaskOrchestrator,
    private readonly registerSystemTool: RegisterSystemTool,
    private readonly getActiveAgentId: () => string,
  ) {}

  register() {
    this.registerCreateLongTask();
    this.registerQueryTaskStatus();
    this.registerCancelTask();
  }

  private registerCreateLongTask() {
    this.registerSystemTool(
      {
        name: "kairo_create_long_task",
        description: "创建一个长程任务，由专门的 Task Agent 在后台执行",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string", description: "任务描述" },
            totalSteps: { type: "number", description: "总步骤数" },
            context: { type: "object", description: "任务上下文（可选）" },
            checkpointInterval: {
              type: "number",
              description: "检查点间隔（默认10）",
              default: 10,
            },
          },
          required: ["description", "totalSteps"],
        },
      },
      async (args, context) => {
        const description = typeof args.description === "string" ? args.description : "";
        const totalSteps =
          typeof args.totalSteps === "number"
            ? args.totalSteps
            : Number(args.totalSteps || 0);
        const customContext =
          args.context && typeof args.context === "object"
            ? (args.context as Record<string, unknown>)
            : {};
        const checkpointInterval =
          typeof args.checkpointInterval === "number"
            ? args.checkpointInterval
            : Number(args.checkpointInterval || 10);
        const task = this.orchestrator.createTask({
          type: TaskType.LONG,
          description,
          agentId: context?.agentId || this.getActiveAgentId(),
          context: {
            totalSteps,
            currentStep: 0,
            ...customContext,
          },
          config: {
            autoResume: true,
            checkpointInterval: checkpointInterval || 10,
          },
          correlationId: context?.correlationId,
        });

        this.orchestrator.startTask(task.id);
        this.orchestrator.updateProgress(task.id, {
          current: 0,
          total: Number(totalSteps) || 0,
          message: "任务已创建",
        });

        return {
          taskId: task.id,
          message: "长程任务已创建，Task Agent 将在后台执行",
        };
      },
    );
  }

  private registerQueryTaskStatus() {
    this.registerSystemTool(
      {
        name: "kairo_query_task_status",
        description: "查询长程任务的执行状态",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务ID（可选）" },
          },
        },
      },
      async (args, context) => {
        const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
        if (taskId) {
          const task = this.orchestrator.getTask(taskId);
          return task || { error: "Task not found" };
        }

        const agentId = context?.agentId || this.getActiveAgentId();
        const tasks = this.orchestrator.getTasksByAgent(agentId);
        const activeTasks = tasks.filter(
          (task) => task.status === TaskStatus.RUNNING || task.status === TaskStatus.PAUSED,
        );
        return {
          summary: {
            total: tasks.length,
            pending: tasks.filter(task => task.status === TaskStatus.PENDING).length,
            running: tasks.filter(task => task.status === TaskStatus.RUNNING).length,
            paused: tasks.filter(task => task.status === TaskStatus.PAUSED).length,
            completed: tasks.filter(task => task.status === TaskStatus.COMPLETED).length,
            failed: tasks.filter(task => task.status === TaskStatus.FAILED).length,
            cancelled: tasks.filter(task => task.status === TaskStatus.CANCELLED).length,
          },
          activeTasks: activeTasks.map(task => ({
            id: task.id,
            description: task.description,
            status: task.status,
            progress: task.progress,
          })),
          recentTasks: tasks.slice(0, 10).map(task => ({
            id: task.id,
            description: task.description,
            status: task.status,
            progress: task.progress,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
          })),
        };
      },
    );
  }

  private registerCancelTask() {
    this.registerSystemTool(
      {
        name: "kairo_cancel_task",
        description: "取消正在执行的长程任务",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务ID" },
            reason: { type: "string", description: "取消原因（可选）" },
          },
          required: ["taskId"],
        },
      },
      async (args) => {
        const taskId = typeof args.taskId === "string" ? args.taskId : "";
        const reason = typeof args.reason === "string" ? args.reason : undefined;
        this.orchestrator.cancelTask(taskId, reason);
        return { message: `任务 ${taskId} 已取消` };
      },
    );
  }
}
