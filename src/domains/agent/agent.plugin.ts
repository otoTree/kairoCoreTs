import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import type { AIPlugin } from "../ai/ai.plugin";
import type { MCPPlugin } from "../mcp/mcp.plugin";
import { LegacyObservationBusAdapter, type ObservationBus } from "./observation-bus";
import { InMemoryAgentMemory, type AgentMemory } from "./memory";
import { InMemorySharedMemory, type SharedMemory } from "./shared-memory";
import { AgentRuntime, type SystemTool } from "./runtime";
import { InMemoryGlobalBus, RingBufferEventStore, type EventBus, type KairoEvent } from "../events";
import type { Vault } from "../vault/vault";
import type { MemoryStore } from "../memory/memory-store";
import { CapabilityRegistry, type AgentCapability } from "./capability-registry";
import { TaskOrchestrator, TaskStatus, TaskType } from "./task-orchestrator";
import { TaskAgentManager, type TaskAgentConfig } from "./task-agent-manager";
import { TaskAgentRuntimeAdapter } from "./task-agent-runtime-adapter";
import { CheckpointManager } from "./checkpoint-manager";
import { ReviewAgent } from "./review-agent";

export class AgentPlugin implements Plugin {
  readonly name = "agent";
  
  public readonly globalBus: EventBus;
  public readonly bus: ObservationBus; // Legacy adapter exposed as bus for compatibility
  public readonly memory: AgentMemory; // Kept for legacy/default agent
  public readonly sharedMemory: SharedMemory;

  private agents: Map<string, AgentRuntime> = new Map();
  private activeAgentId: string = "default";
  // 能力注册表
  public readonly capabilityRegistry = new CapabilityRegistry();
  
  private app?: Application;
  private actionListeners: ((action: any) => void)[] = [];
  private logListeners: ((log: any) => void)[] = [];
  private actionResultListeners: ((result: any) => void)[] = [];
  
  private ai?: AIPlugin;
  private mcp?: MCPPlugin;
  private vault?: Vault;
  private memoryStore?: MemoryStore;
  private systemTools: SystemTool[] = [];
  private orchestrator?: TaskOrchestrator;
  private taskAgentManager?: TaskAgentManager;
  private checkpointManager?: CheckpointManager;
  private reviewAgent?: ReviewAgent;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly runtimeMaxTokens?: number;

  constructor() {
    this.globalBus = new InMemoryGlobalBus(new RingBufferEventStore());
    this.bus = new LegacyObservationBusAdapter(this.globalBus);
    this.memory = new InMemoryAgentMemory();
    this.sharedMemory = new InMemorySharedMemory();
    this.runtimeMaxTokens = this.resolveRuntimeMaxTokens();
  }

  private resolveRuntimeMaxTokens(): number | undefined {
    const raw = process.env.AGENT_MAX_TOKENS;
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.warn(`[Agent] Invalid AGENT_MAX_TOKENS value: ${raw}`);
      return undefined;
    }
    return parsed;
  }

  registerSystemTool(definition: any, handler: (args: any, context: any) => Promise<any>) {
    const tool = { definition, handler };
    this.systemTools.push(tool);
    // Dynamically add to existing agents
    for (const agent of this.agents.values()) {
        agent.registerSystemTool(definition, handler);
    }
  }

  onAction(listener: (action: any) => void) {
    this.actionListeners.push(listener);
    return () => {
      this.actionListeners = this.actionListeners.filter(l => l !== listener);
    };
  }

  onLog(listener: (log: any) => void) {
    this.logListeners.push(listener);
    return () => {
      this.logListeners = this.logListeners.filter(l => l !== listener);
    };
  }

  onActionResult(listener: (result: any) => void) {
    this.actionResultListeners.push(listener);
    return () => {
      this.actionResultListeners = this.actionResultListeners.filter(l => l !== listener);
    };
  }

  public getAgent(id: string): AgentRuntime | undefined {
    return this.agents.get(id);
  }

  setup(app: Application) {
    this.app = app;
    console.log("[Agent] Setting up Agent domain...");
    app.registerService("agent", this);
  }

  async start() {
    if (!this.app) {
      throw new Error("AgentPlugin not initialized");
    }

    console.log("[Agent] Starting Agent domain...");
    
    try {
      this.ai = this.app.getService<AIPlugin>("ai");
    } catch (e) {
      console.error("[Agent] AI service not found. Agent cannot start.");
      throw e;
    }

    try {
      this.mcp = this.app.getService<MCPPlugin>("mcp");
    } catch (e) {
      console.warn("[Agent] MCP service not found. Tools will be disabled.");
    }

    try {
        this.vault = this.app.getService<Vault>("vault");
    } catch (e) {
        console.warn("[Agent] Vault service not found.");
    }

    try {
        this.memoryStore = this.app.getService<MemoryStore>("memoryStore");
    } catch (e) {
        console.warn("[Agent] MemoryStore service not found.");
    }

    // Spawn default agent
    // If MemoryStore is available, inject it into the default memory
    if (this.memoryStore && this.memory instanceof InMemoryAgentMemory) {
        this.memory.setLongTermMemory(this.memoryStore);
    }

    this.spawnAgent("default", this.memory);
    this.orchestrator = new TaskOrchestrator(this.globalBus);
    this.checkpointManager = new CheckpointManager(this.orchestrator, this.globalBus);
    this.reviewAgent = new ReviewAgent(this.globalBus, this.orchestrator);
    this.taskAgentManager = new TaskAgentManager(
      this.globalBus,
      this.orchestrator,
      this.createTaskAgentRuntime.bind(this),
      { reviewEnabled: true, reviewTimeoutMs: 200 },
    );
    await this.recoverTasks();
    this.registerTaskTools();
    this.cleanupTimer = setInterval(() => {
      this.orchestrator?.cleanup();
      this.taskAgentManager?.cleanup();
    }, 60 * 60 * 1000);

    // Subscribe to user messages for routing
    this.globalBus.subscribe("kairo.user.message", this.handleUserMessage.bind(this));

    // 订阅能力声明事件
    this.globalBus.subscribe("kairo.agent.capability", (event: KairoEvent) => {
      const data = event.data as AgentCapability;
      if (data?.agentId && data?.name) {
        this.capabilityRegistry.register(data);
      }
    });

    // 注册任务委派工具
    this.registerSystemTool({
      name: "delegate_task",
      description: "将任务委派给另一个 Agent",
      inputSchema: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "目标 Agent ID，留空则自动路由" },
          description: { type: "string", description: "任务描述" },
          input: { type: "object", description: "任务输入数据" },
        },
        required: ["description"],
      },
    }, async (args: any, context: any) => {
      const targetId = args.targetAgentId || this.capabilityRegistry.findBestAgent(args.description)?.agentId || crypto.randomUUID();
      const taskId = await this.delegateTask(context.agentId, targetId, {
        description: args.description,
        input: args.input,
      });
      return { taskId, targetAgentId: targetId };
    });

    // 注册能力查询工具
    this.registerSystemTool({
      name: "list_agent_capabilities",
      description: "列出所有已注册 Agent 的能力",
      inputSchema: { type: "object", properties: {} },
    }, async () => {
      return { capabilities: this.capabilityRegistry.getAllCapabilities() };
    });
    
    // Subscribe to legacy messages and route to default
    this.globalBus.subscribe("kairo.legacy.*", async (event) => {
         const type = event.type.replace("kairo.legacy.", "");
         
         if (type === "user_message") {
             await this.globalBus.publish({
                type: `kairo.agent.default.message`,
                source: "orchestrator",
                data: { content: (event.data as any).text }
            });
         } else if (type === "system_event") {
              // Route system events to default agent as user message or special event?
              // AgentRuntime.mapEventToObservation handles 'user_message' or 'agent.ID.message'.
              // It maps them to { type: "user_message", ... }
              // If we want it to be a system event observation, we need a new event type or map it differently.
              // AgentRuntime.mapEventToObservation:
              // if (event.type === "kairo.user.message" || event.type === `kairo.agent.${this.id}.message`) -> user_message
              
              // We need a way to send system events.
              // Let's use `kairo.agent.default.message` with special content?
              // Or update AgentRuntime to listen to `kairo.agent.${this.id}.event`?
              
              // Simplest: Send as message for now, or update AgentRuntime.
              // Let's just log it for now as "System: ..."
              
              await this.globalBus.publish({
                type: `kairo.agent.default.message`,
                source: "orchestrator",
                data: { content: `[System Event] ${(event.data as any).name}: ${JSON.stringify((event.data as any).payload)}` }
            });
         }
    });
  }

  async stop() {
    console.log("[Agent] Stopping Agent domain...");
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.taskAgentManager) {
      const activeTaskAgents = this.taskAgentManager.getActiveTaskAgents();
      for (const taskAgent of activeTaskAgents) {
        await this.taskAgentManager.stopTaskAgent(taskAgent.id);
      }
    }
    if (this.reviewAgent) {
      this.reviewAgent.stop();
      this.reviewAgent = undefined;
    }
    for (const agent of this.agents.values()) {
        agent.stop();
    }
    this.agents.clear();
  }

  private async createTaskAgentRuntime(config: TaskAgentConfig): Promise<AgentRuntime> {
    const memory = new InMemoryAgentMemory();
    if (this.memoryStore) {
      memory.setLongTermMemory(this.memoryStore);
    }

    const runtime = new AgentRuntime({
      id: config.id,
      ai: this.ai!,
      maxTokens: this.runtimeMaxTokens,
      mcp: this.mcp,
      bus: config.bus || this.globalBus,
      memory,
      sharedMemory: this.sharedMemory,
      vault: this.vault,
      onAction: (a) => this.actionListeners.forEach(l => l(a)),
      onLog: (l) => this.logListeners.forEach(listener => listener(l)),
      onActionResult: (r) => this.actionResultListeners.forEach(l => l(r)),
      systemTools: this.getTaskAgentSystemTools(),
    });

    new TaskAgentRuntimeAdapter(runtime, config.bus || this.globalBus, config);
    return runtime;
  }

  private getTaskAgentSystemTools(): SystemTool[] {
    return this.systemTools.filter(tool => this.isTaskAgentToolAllowed(tool.definition?.name));
  }

  private isTaskAgentToolAllowed(toolName: unknown): boolean {
    if (typeof toolName !== "string" || toolName.length === 0) {
      return false;
    }
    if (toolName.startsWith("kairo_feishu_")) {
      return false;
    }
    return true;
  }

  private async recoverTasks() {
    if (!this.orchestrator || !this.checkpointManager) return;
    const checkpoints = await this.checkpointManager.listCheckpoints();
    for (const checkpoint of checkpoints) {
      const task = this.orchestrator.getTask(checkpoint.taskId);
      if (task && (task.status === "running" || task.status === "paused")) {
        await this.checkpointManager.restoreTask(checkpoint.taskId);
      }
    }
  }

  private registerTaskTools() {
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
      async (args: any, context: any) => {
        if (!this.orchestrator) {
          throw new Error("Task orchestrator not initialized");
        }
        const task = this.orchestrator.createTask({
          type: TaskType.LONG,
          description: args.description,
          agentId: context?.agentId || this.activeAgentId,
          context: {
            totalSteps: args.totalSteps,
            currentStep: 0,
            ...(args.context || {}),
          },
          config: {
            autoResume: true,
            checkpointInterval: args.checkpointInterval || 10,
          },
          correlationId: context?.correlationId,
        });

        this.orchestrator.startTask(task.id);
        this.orchestrator.updateProgress(task.id, {
          current: 0,
          total: Number(args.totalSteps) || 0,
          message: "任务已创建",
        });

        return {
          taskId: task.id,
          message: "长程任务已创建，Task Agent 将在后台执行",
        };
      },
    );

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
      async (args: any, context: any) => {
        if (!this.orchestrator) {
          throw new Error("Task orchestrator not initialized");
        }
        if (args?.taskId) {
          const task = this.orchestrator.getTask(args.taskId);
          return task || { error: "Task not found" };
        }

        const agentId = context?.agentId || this.activeAgentId;
        const tasks = this.orchestrator.getTasksByAgent(agentId);
        const activeTasks = tasks.filter(
          t => t.status === TaskStatus.RUNNING || t.status === TaskStatus.PAUSED,
        );
        const summary = {
          total: tasks.length,
          pending: tasks.filter(t => t.status === TaskStatus.PENDING).length,
          running: tasks.filter(t => t.status === TaskStatus.RUNNING).length,
          paused: tasks.filter(t => t.status === TaskStatus.PAUSED).length,
          completed: tasks.filter(t => t.status === TaskStatus.COMPLETED).length,
          failed: tasks.filter(t => t.status === TaskStatus.FAILED).length,
          cancelled: tasks.filter(t => t.status === TaskStatus.CANCELLED).length,
        };
        return {
          summary,
          activeTasks: activeTasks.map(t => ({
            id: t.id,
            description: t.description,
            status: t.status,
            progress: t.progress,
          })),
          recentTasks: tasks.slice(0, 10).map(t => ({
            id: t.id,
            description: t.description,
            status: t.status,
            progress: t.progress,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
          })),
        };
      },
    );

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
      async (args: any) => {
        if (!this.orchestrator) {
          throw new Error("Task orchestrator not initialized");
        }
        this.orchestrator.cancelTask(args.taskId, args.reason);
        return { message: `任务 ${args.taskId} 已取消` };
      },
    );
  }

  private spawnAgent(id: string, memory?: AgentMemory) {
      if (this.agents.has(id)) return this.agents.get(id)!;
      
      const agentMemory = memory || new InMemoryAgentMemory();
      if (this.memoryStore && agentMemory instanceof InMemoryAgentMemory) {
          agentMemory.setLongTermMemory(this.memoryStore);
      }

      const runtime = new AgentRuntime({
          id,
          ai: this.ai!,
          maxTokens: this.runtimeMaxTokens,
          mcp: this.mcp,
          bus: this.globalBus,
          memory: agentMemory,
          sharedMemory: this.sharedMemory,
          vault: this.vault,
          onAction: (a) => this.actionListeners.forEach(l => l(a)),
          onLog: (l) => this.logListeners.forEach(l => l(l)),
          onActionResult: (r) => this.actionResultListeners.forEach(l => l(r)),
          systemTools: this.systemTools
      });
      
      this.agents.set(id, runtime);
      runtime.start();
      return runtime;
  }

  /**
   * 任务委派：将任务从父 Agent 发送给子 Agent
   */
  async delegateTask(parentId: string, childId: string, task: {
    description: string;
    input?: any;
    timeout?: number;
  }): Promise<string> {
    if (!this.agents.has(childId)) {
      this.spawnAgent(childId);
    }

    const taskId = crypto.randomUUID();

    await this.globalBus.publish({
      type: `kairo.agent.${childId}.task`,
      source: `agent:${parentId}`,
      data: {
        taskId,
        parentId,
        description: task.description,
        input: task.input,
        timeout: task.timeout || 30000,
      },
    });

    return taskId;
  }

  private async handleUserMessage(event: KairoEvent) {
        const content = (event.data as any).content;
        const target = (event.data as any).targetAgentId;
        
        if (target) {
            if (!this.agents.has(target)) {
                 // Auto-spawn if targeted explicitly?
                 this.spawnAgent(target);
            }
            await this.globalBus.publish({
                type: `kairo.agent.${target}.message`,
                source: "orchestrator",
                data: { content }
            });
            return;
        }
        
        // Semantic Routing: Check relevance to default agent
        // We only check default for now as it's the main context.
        const defaultAgent = this.agents.get("default");
        if (!defaultAgent) return; // Should not happen

        try {
            // Get a snippet of context (last 1000 chars)
            // Accessing private memory via 'any' or assuming getContext is public (it is)
            const context = this.memory.getContext(); 
            const recentContext = context.slice(-1000);

            const prompt = `You are a Router.
Current Conversation Context:
${recentContext}

New User Message: "${content}"

Is this message relevant to the current conversation?
Or is it a completely new, unrelated topic?
If it is unrelated, we should spawn a new agent.

Reply JSON: { "relevant": boolean }`;

            const response = await this.ai!.chat([{ role: "user", content: prompt }]);
            
            // Safe parse
            let relevant = true;
            try {
                const json = JSON.parse(response.content.replace(/```json/g, "").replace(/```/g, "").trim());
                relevant = json.relevant;
            } catch (e) {
                console.warn("[Orchestrator] Failed to parse routing decision, defaulting to relevant.", e);
            }

            if (relevant) {
                 await this.globalBus.publish({
                    type: `kairo.agent.default.message`,
                    source: "orchestrator",
                    data: { content }
                });
            } else {
                const newId = crypto.randomUUID();
                console.log(`[Orchestrator] Spawning new agent ${newId} for unrelated task.`);
                this.spawnAgent(newId);
                await this.globalBus.publish({
                    type: `kairo.agent.${newId}.message`,
                    source: "orchestrator",
                    data: { content }
                });
            }

        } catch (e) {
            console.error("[Orchestrator] Routing error:", e);
             // Fallback
             await this.globalBus.publish({
                type: `kairo.agent.default.message`,
                source: "orchestrator",
                data: { content }
            });
        }
  }
}
