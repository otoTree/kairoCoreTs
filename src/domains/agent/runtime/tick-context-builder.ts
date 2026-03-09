import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KairoEvent } from "../../events";
import type { AIPlugin } from "../../ai/ai.plugin";
import type { MCPPlugin } from "../../mcp/mcp.plugin";
import type { Observation } from "../observation-bus";
import type { AgentMemory } from "../memory";
import type { SharedMemory } from "../shared-memory";
import type { SystemTool } from "./runtime-types";
import { buildUserPromptFromObservations } from "./prompt/prompt-builder";
import { buildRuntimeSystemPrompt } from "./prompt/runtime-system-prompt-builder";

export interface TickContextBuildInput {
  events: KairoEvent[];
  ai: AIPlugin;
  mcp?: MCPPlugin;
  memory: AgentMemory;
  observationMapper: (event: KairoEvent) => Observation | null;
  systemTools: Map<string, SystemTool>;
  sharedMemory?: SharedMemory;
  compressionThresholdChars: number;
  agentId: string;
}

export interface TickContextBuildResult {
  observations: Observation[];
  systemPrompt: string;
  userPrompt: string;
  correlationId?: string;
  causationId?: string;
}

export async function buildTickContext(input: TickContextBuildInput): Promise<TickContextBuildResult | null> {
  const observations: Observation[] = input.events
    .map(event => input.observationMapper(event))
    .filter((item): item is Observation => item !== null);
  if (observations.length === 0) {
    return null;
  }

  let context = input.memory.getContext();
  if (context.length > input.compressionThresholdChars) {
    console.log(`[AgentRuntime] Context length ${context.length} > ${input.compressionThresholdChars}. Triggering compression...`);
    await input.memory.compress(input.ai);
    context = input.memory.getContext();
  }

  const availableTools: Tool[] = [];
  if (input.systemTools.size > 0) {
    availableTools.push(...Array.from(input.systemTools.values()).map(tool => tool.definition));
  }

  if (input.mcp) {
    const lastObservation = observations.length > 0
      ? JSON.stringify(observations[observations.length - 1])
      : context.slice(-500);
    try {
      const mcpTools = await input.mcp.getRelevantTools(lastObservation);
      if (mcpTools.length > 0) {
        availableTools.push(...mcpTools);
      }
    } catch (error) {
      console.warn("[AgentRuntime] Failed to route tools:", error);
    }
  }

  const toolsContext = availableTools.length > 0
    ? `\n可用工具 (Available Tools):\n${JSON.stringify(availableTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })), null, 2)}`
    : "";

  const recentContext = observations.map(observation => JSON.stringify(observation)).join(" ").slice(-500);
  const recalledMemories = await input.memory.recall(recentContext);
  const memoryContext = recalledMemories.length > 0 ? `\n【Recalled Memories】\n${recalledMemories.join("\n")}` : "";

  const systemPrompt = await buildRuntimeSystemPrompt({
    agentId: input.agentId,
    context,
    toolsContext,
    memoryContext,
    sharedMemory: input.sharedMemory,
    hasCreateLongTaskTool: input.systemTools.has("kairo_create_long_task"),
    hasQueryTaskTool: input.systemTools.has("kairo_query_task_status"),
    hasCancelTaskTool: input.systemTools.has("kairo_cancel_task"),
    hasFeishuSendFileTool: input.systemTools.has("kairo_feishu_send_file"),
  });
  const userPrompt = buildUserPromptFromObservations(observations);

  const triggerEvent = input.events[input.events.length - 1];
  const causationId = triggerEvent?.id;
  const correlationId = triggerEvent?.correlationId || causationId;

  return {
    observations,
    systemPrompt,
    userPrompt,
    correlationId,
    causationId,
  };
}
