import type { AIPlugin } from "../../../ai/ai.plugin";
import type { EventBus } from "../../../events";
import type { MCPPlugin } from "../../../mcp/mcp.plugin";
import type { Vault } from "../../../vault/vault";
import type { AgentMemory } from "../../memory";
import type { SharedMemory } from "../../shared-memory";
import type { AgentRuntimeOptions, SystemTool } from "../../runtime";

export interface RuntimeBuilderCallbacks {
  onAction?: (action: unknown) => void;
  onLog?: (log: unknown) => void;
  onActionResult?: (result: unknown) => void;
}

export interface RuntimeBuilderBaseOptions {
  ai: AIPlugin;
  maxTokens?: number;
  mcp?: MCPPlugin;
  sharedMemory: SharedMemory;
  vault?: Vault;
  callbacks?: RuntimeBuilderCallbacks;
}

export interface RuntimeBuilderInput {
  id: string;
  bus: EventBus;
  memory: AgentMemory;
  systemTools: SystemTool[];
}

export class AgentRuntimeOptionsBuilder {
  constructor(private readonly base: RuntimeBuilderBaseOptions) {}

  build(input: RuntimeBuilderInput): AgentRuntimeOptions {
    return {
      id: input.id,
      ai: this.base.ai,
      maxTokens: this.base.maxTokens,
      mcp: this.base.mcp,
      bus: input.bus,
      memory: input.memory,
      sharedMemory: this.base.sharedMemory,
      vault: this.base.vault,
      onAction: this.base.callbacks?.onAction,
      onLog: this.base.callbacks?.onLog,
      onActionResult: this.base.callbacks?.onActionResult,
      systemTools: input.systemTools,
    };
  }
}
