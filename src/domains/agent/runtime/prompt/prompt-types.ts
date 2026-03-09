import type { Observation } from "../../observation-bus";

export type AgentRole = "main" | "task";

export interface PromptBuildContext {
  agentId: string;
  role: AgentRole;
  context: string;
  toolsContext: string;
  memoryContext: string;
  facts: string;
  longTaskGuidance: string;
  channelFileGuidance: string;
  validActionTypes: string[];
  projectRoot: string;
  workspaceDir: string;
  skillsDir: string;
  mcpDir: string;
  nowIso: string;
}

export interface PromptSectionContext {
  hasCreateLongTaskTool: boolean;
  hasQueryTaskTool: boolean;
  hasCancelTaskTool: boolean;
  hasFeishuSendFileTool: boolean;
}

export type PromptObservation = Observation;
