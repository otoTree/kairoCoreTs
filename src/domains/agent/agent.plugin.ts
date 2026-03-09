import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import { LegacyObservationBusAdapter, type ObservationBus } from "./observation-bus";
import { InMemoryAgentMemory, type AgentMemory } from "./memory";
import { InMemorySharedMemory, type SharedMemory } from "./shared-memory";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntime, type SystemTool, type SystemToolContext } from "./runtime";
import { InMemoryGlobalBus, RingBufferEventStore, type EventBus, type KairoEvent } from "../events";
import type { MemoryStore } from "../memory/memory-store";
import { CapabilityRegistry, type AgentCapability } from "./collaboration";
import { CheckpointManager, TaskAgentManager, type TaskAgentConfig, TaskOrchestrator } from "./task";
import { ReviewAgent } from "./review";
import { AgentBootstrap } from "./bootstrap";
import { AgentRouter } from "./routing";
import { AgentTaskTools } from "./task";
import { AgentRuntimeFactory } from "./agent-runtime-factory";
import { registerCollaborationTools } from "./collaboration/register-collaboration-tools";
import { bridgeLegacyEventToDefaultAgent } from "./routing/legacy-event-bridge";

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
  private actionListeners: Array<(action: unknown) => void> = [];
  private logListeners: Array<(log: unknown) => void> = [];
  private actionResultListeners: Array<(result: unknown) => void> = [];
  
  private memoryStore?: MemoryStore;
  private systemTools: SystemTool[] = [];
  private orchestrator?: TaskOrchestrator;
  private taskAgentManager?: TaskAgentManager;
  private checkpointManager?: CheckpointManager;
  private reviewAgent?: ReviewAgent;
  private router?: AgentRouter;
  private runtimeFactory?: AgentRuntimeFactory;
  private readonly bootstrap = new AgentBootstrap();
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

  registerSystemTool(
    definition: unknown,
    handler: (args: Record<string, unknown>, context: SystemToolContext) => Promise<unknown>,
  ) {
    const tool: SystemTool = { definition: definition as Tool, handler };
    this.systemTools.push(tool);
    // Dynamically add to existing agents
    for (const agent of this.agents.values()) {
        agent.registerSystemTool(definition, handler);
    }
  }

  onAction(listener: (action: unknown) => void) {
    this.actionListeners.push(listener);
    return () => {
      this.actionListeners = this.actionListeners.filter(l => l !== listener);
    };
  }

  onLog(listener: (log: unknown) => void) {
    this.logListeners.push(listener);
    return () => {
      this.logListeners = this.logListeners.filter(l => l !== listener);
    };
  }

  onActionResult(listener: (result: unknown) => void) {
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

    const dependencies = this.bootstrap.resolveDependencies(this.app);
    this.memoryStore = dependencies.memoryStore;
    if (this.memoryStore && this.memory instanceof InMemoryAgentMemory) {
      this.memory.setLongTermMemory(this.memoryStore);
    }

    this.runtimeFactory = new AgentRuntimeFactory({
      ai: dependencies.ai,
      maxTokens: this.runtimeMaxTokens,
      mcp: dependencies.mcp,
      globalBus: this.globalBus,
      sharedMemory: this.sharedMemory,
      vault: dependencies.vault,
      memoryStore: dependencies.memoryStore,
      callbacks: {
        onAction: (action) => this.actionListeners.forEach(listener => listener(action)),
        onLog: (log) => this.logListeners.forEach(listener => listener(log)),
        onActionResult: (result) => this.actionResultListeners.forEach(listener => listener(result)),
      },
    });

    this.spawnAgent("default", this.memory);
    const taskSubsystem = this.bootstrap.createTaskSubsystem(
      this.globalBus,
      this.createTaskAgentRuntime.bind(this),
    );
    this.orchestrator = taskSubsystem.orchestrator;
    this.checkpointManager = taskSubsystem.checkpointManager;
    this.reviewAgent = taskSubsystem.reviewAgent;
    this.taskAgentManager = taskSubsystem.taskAgentManager;
    await this.bootstrap.recoverTasks(this.orchestrator, this.checkpointManager);
    new AgentTaskTools(
      this.orchestrator,
      this.registerSystemTool.bind(this),
      () => this.activeAgentId,
    ).register();
    registerCollaborationTools({
      registerSystemTool: this.registerSystemTool.bind(this),
      capabilityRegistry: this.capabilityRegistry,
      delegateTask: this.delegateTask.bind(this),
      randomAgentId: () => crypto.randomUUID(),
    });
    this.cleanupTimer = setInterval(() => {
      this.orchestrator?.cleanup();
      this.taskAgentManager?.cleanup();
    }, 60 * 60 * 1000);

    this.router = new AgentRouter({
      ai: dependencies.ai,
      bus: this.globalBus,
      memory: this.memory,
      hasAgent: id => this.agents.has(id),
      spawnAgent: id => {
        this.spawnAgent(id);
      },
      hasDefaultAgent: () => this.agents.has("default"),
    });
    this.globalBus.subscribe("kairo.user.message", this.handleUserMessage.bind(this));

    this.globalBus.subscribe("kairo.agent.capability", (event: KairoEvent) => {
      const data = event.data as AgentCapability;
      if (data?.agentId && data?.name) {
        this.capabilityRegistry.register(data);
      }
    });

    this.globalBus.subscribe("kairo.legacy.*", async (event) => {
      await bridgeLegacyEventToDefaultAgent(this.globalBus, event);
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
    this.router = undefined;
    this.runtimeFactory = undefined;
  }

  private async createTaskAgentRuntime(config: TaskAgentConfig): Promise<AgentRuntime> {
    if (!this.runtimeFactory) {
      throw new Error("Runtime factory not initialized");
    }
    return this.runtimeFactory.createTaskAgentRuntime(config, this.getTaskAgentSystemTools());
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

  private spawnAgent(id: string, memory?: AgentMemory) {
    if (!this.runtimeFactory) {
      throw new Error("Runtime factory not initialized");
    }
    return this.runtimeFactory.spawnAgent(this.agents, id, this.systemTools, memory);
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
    if (!this.router) {
      return;
    }
    await this.router.handleUserMessage(event);
  }
}
