import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SystemToolContext } from "../runtime";
import type { CapabilityRegistry } from "./capability-registry";

interface DelegateTaskInput {
  description: string;
  input?: unknown;
}

interface DelegateTaskArgs {
  targetAgentId?: string;
  description: string;
  input?: unknown;
}

export function registerCollaborationTools(params: {
  registerSystemTool: (
    definition: Tool,
    handler: (args: Record<string, unknown>, context: SystemToolContext) => Promise<unknown>,
  ) => void;
  capabilityRegistry: CapabilityRegistry;
  delegateTask: (parentId: string, childId: string, task: DelegateTaskInput) => Promise<string>;
  randomAgentId: () => string;
}) {
  params.registerSystemTool(
    {
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
    },
    async (args, context) => {
      const parsed: DelegateTaskArgs = {
        targetAgentId: typeof args.targetAgentId === "string" ? args.targetAgentId : undefined,
        description: typeof args.description === "string" ? args.description : "",
        input: args.input,
      };
      const targetId = parsed.targetAgentId
        || params.capabilityRegistry.findBestAgent(parsed.description)?.agentId
        || params.randomAgentId();
      const taskId = await params.delegateTask(context.agentId, targetId, {
        description: parsed.description,
        input: parsed.input,
      });
      return { taskId, targetAgentId: targetId };
    },
  );

  params.registerSystemTool(
    {
      name: "list_agent_capabilities",
      description: "列出所有已注册 Agent 的能力",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      return { capabilities: params.capabilityRegistry.getAllCapabilities() };
    },
  );
}
