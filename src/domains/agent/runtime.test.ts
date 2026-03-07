import { describe, it, expect, mock, beforeEach } from "bun:test";
import { AgentRuntime } from "./runtime";
import { InMemoryGlobalBus, RingBufferEventStore } from "../events";
import { InMemoryAgentMemory } from "./memory";
import type { AIPlugin } from "../ai/ai.plugin";
import type { AIProvider } from "../ai/types";

// Mock AI Provider
const mockChat = mock(async () => ({
  content: JSON.stringify({ thought: "thinking...", action: { type: "noop" } }),
  usage: { input: 0, output: 0, total: 0 }
}));

const mockAI: AIPlugin = {
  name: "ai",
  setup: () => {},
  start: async () => {},
  registerProvider: () => {},
  getProvider: () => ({} as AIProvider),
  chat: mockChat as any,
} as unknown as AIPlugin;

describe("AgentRuntime (Event Driven)", () => {
  let bus: InMemoryGlobalBus;
  let memory: InMemoryAgentMemory;
  let runtime: AgentRuntime;

  beforeEach(() => {
    (mockChat as any).mockReset?.();
    mockChat.mockImplementation(async () => ({
      content: JSON.stringify({ thought: "thinking...", action: { type: "noop" } }),
      usage: { input: 0, output: 0, total: 0 }
    }));

    bus = new InMemoryGlobalBus(new RingBufferEventStore());
    memory = new InMemoryAgentMemory();
    runtime = new AgentRuntime({
      ai: mockAI,
      mcp: { 
        callTool: async () => "Success",
        getRelevantTools: async () => [{ name: "test_tool", description: "test", inputSchema: {} }]
      } as any, // Mock MCP
      bus,
      memory,
    });
  });

  it("should respond to direct agent messages", async () => {
    runtime.start();

    // Publish a direct message
    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "orchestrator",
      data: { content: "Hello" }
    });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockChat).toHaveBeenCalled();
    const calls = mockChat.mock.calls as unknown as any[][];
    const prompt = calls[0]![0] as any[];
    const userMessage = prompt.find((p: any) => p.role === "user").content;
    expect(userMessage).toContain("User: Hello");
    
    runtime.stop();
  });

  it("should respond to tool result events matching pending action", async () => {
    runtime.start();

    // 1. Simulate Agent producing an action (we cheat by accessing private pendingActions or mocking the flow)
    // Since we can't easily trigger an action without AI, let's mock AI to return a tool call first.
    
    mockChat.mockResolvedValueOnce({
        content: JSON.stringify({ 
            thought: "I need to test", 
            action: { type: "tool_call", function: { name: "test_tool", arguments: {} } } 
        }),
        usage: { input: 0, output: 0, total: 0 }
    });

    // 2. Trigger a cycle
    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "Do test" }
    });
    
    // Wait for tick to complete (Agent publishes Action, calls tool (fails as no MCP), publishes Result)
    // Wait, we didn't provide MCP, so tool call will fail inside runtime and runtime will publish error result.
    // This internally tests the flow.
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Check if AI was called again with the result?
    // The first call was "Do test".
    // The agent produced "tool_call".
    // Runtime executed tool (failed). Published "tool.result".
    // Runtime SHOULD consume "tool.result".
    // Trigger next tick.
    // AI called again with "Action Result: ...".
    
    // So mockChat should be called TWICE.
    // 1. User: Do test
    // 2. User: Do test ... Action Result: Tool call failed...
    
    // We need to mock the second response to be noop
    mockChat.mockResolvedValueOnce({
        content: JSON.stringify({ thought: "Done", action: { type: "noop" } }),
        usage: { input: 0, output: 0, total: 0 }
    });
    
    // Wait more for second tick
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockChat).toHaveBeenCalledTimes(2);
    
    const calls = mockChat.mock.calls as unknown as any[][];
    const secondPrompt = calls[1]![0] as any[];
    const userMessage = secondPrompt.find((p: any) => p.role === "user").content;
    
    expect(userMessage).toContain("Action Result:");
    
    runtime.stop();
  });

  it("should ignore tool result events not intended for it", async () => {
    runtime.start();

    // Publish a random tool result
    await bus.publish({
      type: "kairo.tool.result",
      source: "tool:random",
      data: { result: "Should be ignored" },
      causationId: "random-id"
    });

    // Wait
    await new Promise(resolve => setTimeout(resolve, 50));

    // AI should NOT be called
    expect(mockChat).not.toHaveBeenCalled();
    
    runtime.stop();
  });

  it("should auto-continue after say action with continue flag", async () => {
    runtime.start();
    const emitted: any[] = [];
    bus.subscribe("kairo.>", (e) => {
      emitted.push(e);
    });

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "先告知用户，然后继续执行",
        action: { type: "say", content: "正在处理", continue: true }
      }),
      usage: { input: 0, output: 0, total: 0 }
    });
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "执行完成",
        action: { type: "finish", result: "done" }
      }),
      usage: { input: 0, output: 0, total: 0 }
    });

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "开始任务" }
    });

    await new Promise(resolve => setTimeout(resolve, 120));

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(emitted.some(e => e.type === "kairo.agent.progress")).toBe(true);
    expect(emitted.some(e => e.type === "kairo.agent.internal.continue")).toBe(true);
    expect(emitted.some(e => e.type === "kairo.intent.ended")).toBe(true);

    runtime.stop();
  });

  it("should convert repeated say loops to noop", async () => {
    runtime.start();
    const actionEvents: any[] = [];
    const continueEvents: any[] = [];
    bus.subscribe("kairo.agent.action", (e) => {
      actionEvents.push(e);
    });
    bus.subscribe("kairo.agent.internal.continue", (e) => {
      continueEvents.push(e);
    });

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "先告知用户，然后继续执行",
        action: { type: "say", content: "正在处理", continue: true }
      }),
      usage: { input: 0, output: 0, total: 0 }
    });
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "继续告知用户",
        action: { type: "say", content: "正在处理", continue: true }
      }),
      usage: { input: 0, output: 0, total: 0 }
    });

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "开始任务" }
    });

    await new Promise(resolve => setTimeout(resolve, 180));

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]?.data?.action?.type).toBe("say");
    expect(continueEvents).toHaveLength(1);

    runtime.stop();
  });

  it("should end intent when action type is finish", async () => {
    runtime.start();
    const intentEvents: any[] = [];
    bus.subscribe("kairo.intent.*", (e) => {
      intentEvents.push(e);
    });

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "任务完成，收尾",
        action: { type: "finish", result: "ok" }
      }),
      usage: { input: 0, output: 0, total: 0 }
    });

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "结束" }
    });

    await new Promise(resolve => setTimeout(resolve, 80));

    const ended = intentEvents.find(e => e.type === "kairo.intent.ended");
    expect(ended).toBeDefined();
    expect(ended.data.result).toBe("ok");

    runtime.stop();
  });
});
