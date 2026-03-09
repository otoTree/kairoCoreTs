import { buildPromptSections, buildSystemPrompt } from "./prompt-builder";
import type { SharedMemory } from "../../shared-memory";

export interface RuntimeSystemPromptBuilderInput {
  agentId: string;
  context: string;
  toolsContext: string;
  memoryContext: string;
  sharedMemory?: SharedMemory;
  hasCreateLongTaskTool: boolean;
  hasQueryTaskTool: boolean;
  hasCancelTaskTool: boolean;
  hasFeishuSendFileTool: boolean;
}

export async function buildRuntimeSystemPrompt(input: RuntimeSystemPromptBuilderInput): Promise<string> {
  let facts = "";
  if (input.sharedMemory) {
    const allFacts = await input.sharedMemory.getFacts();
    if (allFacts.length > 0) {
      facts = `\n【Shared Knowledge】\n${allFacts.map(f => `- ${f}`).join("\n")}`;
    }
  }
  const projectRoot = process.env.KAIRO_PROJECT_ROOT || process.cwd();
  const workspaceDir = process.env.KAIRO_WORKSPACE_DIR || projectRoot;
  const skillsDir = process.env.KAIRO_SKILLS_DIR || `${projectRoot}/data/skills`;
  const mcpDir = process.env.KAIRO_MCP_DIR || `${projectRoot}/mcp`;
  const validActionTypes = ["say", "query", "render", "finish", "noop"];
  if (input.toolsContext && input.toolsContext.trim().length > 0) {
    validActionTypes.push("tool_call");
  }
  const sections = buildPromptSections({
    hasCreateLongTaskTool: input.hasCreateLongTaskTool,
    hasQueryTaskTool: input.hasQueryTaskTool,
    hasCancelTaskTool: input.hasCancelTaskTool,
    hasFeishuSendFileTool: input.hasFeishuSendFileTool,
  });
  return buildSystemPrompt({
    agentId: input.agentId,
    role: "main",
    context: input.context,
    toolsContext: input.toolsContext,
    memoryContext: input.memoryContext,
    facts,
    longTaskGuidance: sections.longTaskGuidance,
    channelFileGuidance: sections.channelFileGuidance,
    validActionTypes,
    projectRoot,
    workspaceDir,
    skillsDir,
    mcpDir,
    nowIso: new Date().toISOString(),
  });
}
