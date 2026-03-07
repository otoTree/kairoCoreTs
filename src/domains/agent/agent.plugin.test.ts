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
});
