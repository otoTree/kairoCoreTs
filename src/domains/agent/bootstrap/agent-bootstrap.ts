import type { Application } from "../../../core/app";
import type { AIPlugin } from "../../ai/ai.plugin";
import type { EventBus } from "../../events";
import type { MemoryStore } from "../../memory/memory-store";
import type { MCPPlugin } from "../../mcp/mcp.plugin";
import type { Vault } from "../../vault/vault";
import { CheckpointManager } from "../task";
import { ReviewAgent } from "../review";
import { TaskAgentManager, type TaskAgentConfig, TaskOrchestrator } from "../task";
import type { AgentRuntime } from "../runtime";

export interface AgentDependencies {
  ai: AIPlugin;
  mcp?: MCPPlugin;
  vault?: Vault;
  memoryStore?: MemoryStore;
}

export interface AgentTaskSubsystem {
  orchestrator: TaskOrchestrator;
  checkpointManager: CheckpointManager;
  reviewAgent: ReviewAgent;
  taskAgentManager: TaskAgentManager;
}

export class AgentBootstrap {
  resolveDependencies(app: Application): AgentDependencies {
    const ai = this.resolveRequired<AIPlugin>(
      app,
      "ai",
      "[Agent] AI service not found. Agent cannot start.",
    );
    const mcp = this.resolveOptional<MCPPlugin>(app, "mcp", "[Agent] MCP service not found. Tools will be disabled.");
    const vault = this.resolveOptional<Vault>(app, "vault", "[Agent] Vault service not found.");
    const memoryStore = this.resolveOptional<MemoryStore>(
      app,
      "memoryStore",
      "[Agent] MemoryStore service not found.",
    );
    return { ai, mcp, vault, memoryStore };
  }

  createTaskSubsystem(
    bus: EventBus,
    createTaskAgentRuntime: (config: TaskAgentConfig) => Promise<AgentRuntime>,
  ): AgentTaskSubsystem {
    const orchestrator = new TaskOrchestrator(bus);
    const checkpointManager = new CheckpointManager(orchestrator, bus);
    const reviewAgent = new ReviewAgent(bus, orchestrator);
    const taskAgentManager = new TaskAgentManager(
      bus,
      orchestrator,
      createTaskAgentRuntime,
      { reviewEnabled: true, reviewTimeoutMs: 200 },
    );
    return { orchestrator, checkpointManager, reviewAgent, taskAgentManager };
  }

  async recoverTasks(orchestrator: TaskOrchestrator, checkpointManager: CheckpointManager) {
    const checkpoints = await checkpointManager.listCheckpoints();
    for (const checkpoint of checkpoints) {
      const task = orchestrator.getTask(checkpoint.taskId);
      if (task && (task.status === "running" || task.status === "paused")) {
        await checkpointManager.restoreTask(checkpoint.taskId);
      }
    }
  }

  private resolveRequired<T>(app: Application, serviceName: string, message: string): T {
    try {
      return app.getService<T>(serviceName);
    } catch (error) {
      console.error(message);
      throw error;
    }
  }

  private resolveOptional<T>(app: Application, serviceName: string, message: string): T | undefined {
    try {
      return app.getService<T>(serviceName);
    } catch {
      console.warn(message);
      return undefined;
    }
  }
}
