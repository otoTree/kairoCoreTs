import { afterEach, describe, expect, it } from "bun:test";
import { AgentPlugin } from "./agent.plugin";

const originalAgentMaxTokens = process.env.AGENT_MAX_TOKENS;

afterEach(() => {
  if (originalAgentMaxTokens === undefined) {
    delete process.env.AGENT_MAX_TOKENS;
    return;
  }
  process.env.AGENT_MAX_TOKENS = originalAgentMaxTokens;
});

describe("AgentPlugin maxTokens config", () => {
  it("should read AGENT_MAX_TOKENS when value is valid", () => {
    process.env.AGENT_MAX_TOKENS = "32000";
    const plugin = new AgentPlugin() as any;
    expect(plugin.runtimeMaxTokens).toBe(32000);
  });

  it("should ignore AGENT_MAX_TOKENS when value is invalid", () => {
    process.env.AGENT_MAX_TOKENS = "-10";
    const plugin = new AgentPlugin() as any;
    expect(plugin.runtimeMaxTokens).toBeUndefined();
  });

  it("should keep AGENT_MAX_TOKENS undefined when not configured", () => {
    delete process.env.AGENT_MAX_TOKENS;
    const plugin = new AgentPlugin() as any;
    expect(plugin.runtimeMaxTokens).toBeUndefined();
  });

  it("should exclude feishu tools for task agents", () => {
    const plugin = new AgentPlugin() as any;
    plugin.systemTools = [
      {
        definition: { name: "kairo_feishu_send_file" },
        handler: async () => ({}),
      },
      {
        definition: { name: "kairo_file_patch" },
        handler: async () => ({}),
      },
    ];

    const tools = plugin.getTaskAgentSystemTools();
    expect(tools.map((tool: any) => tool.definition.name)).toEqual(["kairo_file_patch"]);
  });

  it("should reject unnamed tools for task agents", () => {
    const plugin = new AgentPlugin() as any;
    expect(plugin.isTaskAgentToolAllowed(undefined)).toBe(false);
    expect(plugin.isTaskAgentToolAllowed("")).toBe(false);
    expect(plugin.isTaskAgentToolAllowed("kairo_create_long_task")).toBe(true);
  });
});
