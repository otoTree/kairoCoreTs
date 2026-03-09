import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AIPlugin } from "../../ai/ai.plugin";
import type { EventBus } from "../../events";
import type { MCPPlugin } from "../../mcp/mcp.plugin";
import type { AgentMemory } from "../memory";
import type { SharedMemory } from "../shared-memory";
import type { AgentAction } from "./action-types";

export interface AgentCapabilityDefinition {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface SystemToolContext {
  agentId: string;
  traceId?: string;
  spanId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface SystemTool {
  definition: Tool;
  handler: (args: Record<string, unknown>, context: SystemToolContext) => Promise<unknown>;
}

export interface VaultResolver {
  resolve(handleId: string): string | undefined;
}

export interface AgentRuntimeOptions {
  id?: string;
  ai: AIPlugin;
  maxTokens?: number;
  mcp?: MCPPlugin;
  bus: EventBus;
  memory: AgentMemory;
  sharedMemory?: SharedMemory;
  vault?: VaultResolver;
  onAction?: (action: AgentAction) => void;
  onLog?: (log: unknown) => void;
  onActionResult?: (result: { action: AgentAction; result: unknown }) => void;
  systemTools?: SystemTool[];
  capabilities?: AgentCapabilityDefinition[];
}
