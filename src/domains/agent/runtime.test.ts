import { describe, it, expect, mock, beforeEach } from "bun:test";
import { AgentRuntime } from "./runtime";
import { InMemoryGlobalBus, RingBufferEventStore } from "../events";
import { InMemoryAgentMemory, type AgentMemory } from "./memory";
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

  it("should include directory responsibilities in system prompt", async () => {
    const previousProjectRoot = process.env.KAIRO_PROJECT_ROOT;
    const previousWorkspaceDir = process.env.KAIRO_WORKSPACE_DIR;
    const previousSkillsDir = process.env.KAIRO_SKILLS_DIR;
    const previousMcpDir = process.env.KAIRO_MCP_DIR;
    process.env.KAIRO_PROJECT_ROOT = "/tmp/project-root";
    process.env.KAIRO_WORKSPACE_DIR = "/tmp/project-root/workspace";
    process.env.KAIRO_SKILLS_DIR = "/tmp/project-root/skills";
    process.env.KAIRO_MCP_DIR = "/tmp/project-root/mcp";
    try {
      runtime.start();

      await bus.publish({
        type: `kairo.agent.${runtime.id}.message`,
        source: "user",
        data: { content: "目录规则测试" }
      });

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(mockChat).toHaveBeenCalled();
      const calls = mockChat.mock.calls as unknown as any[][];
      const prompt = calls[calls.length - 1]![0] as any[];
      const systemMessage = prompt.find((p: any) => p.role === "system").content;
      expect(systemMessage).toContain("SkillsDir: /tmp/project-root/skills");
      expect(systemMessage).toContain("MCPDir: /tmp/project-root/mcp");
      expect(systemMessage).toContain("Workspace is the primary working area");
      runtime.stop();
    } finally {
      process.env.KAIRO_PROJECT_ROOT = previousProjectRoot;
      process.env.KAIRO_WORKSPACE_DIR = previousWorkspaceDir;
      process.env.KAIRO_SKILLS_DIR = previousSkillsDir;
      process.env.KAIRO_MCP_DIR = previousMcpDir;
    }
  });

  it("should include chunked file writing policy in system prompt", async () => {
    runtime.start();

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "请写入一个文件" }
    });

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(mockChat).toHaveBeenCalled();
    const calls = mockChat.mock.calls as unknown as any[][];
    const prompt = calls[calls.length - 1]![0] as any[];
    const systemMessage = prompt.find((p: any) => p.role === "system").content;
    expect(systemMessage).toContain("do not attempt to write a long file in one shot");
    expect(systemMessage).toContain("write files in multiple chunks");

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

  it("should parse fenced JSON even with trailing non-JSON text", async () => {
    runtime.start();
    const actionEvents: any[] = [];
    bus.subscribe("kairo.agent.action", (e) => {
      actionEvents.push(e);
    });

    mockChat.mockResolvedValueOnce({
      content: `先说明一下
\`\`\`json
{"thought":"解析成功","action":{"type":"say","content":"ok"}}
\`\`\`
附加文本 {invalid-json-tail}`,
      usage: { input: 0, output: 0, total: 0 }
    });

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "测试解析" }
    });

    await new Promise(resolve => setTimeout(resolve, 80));

    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]?.data?.action?.type).toBe("say");
    expect(actionEvents[0]?.data?.action?.content).toBe("ok");

    runtime.stop();
  });

  it("should recover truncated fenced JSON response", async () => {
    runtime.start();
    const actionEvents: any[] = [];
    bus.subscribe("kairo.agent.action", (e) => {
      actionEvents.push(e);
    });

    mockChat.mockResolvedValueOnce({
      content: `\`\`\`markdown
{"thought":"继续执行","action":{"type":"tool_call","function":{"name":"kairo_terminal_exec","arguments":{"sessionId":"main","command":"cat > /app/skills/short-drama-generator/SKILL.md << 'EOF'\\n标题"}}`,
      usage: { input: 0, output: 0, total: 0 }
    });

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "测试截断 JSON 恢复" }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]?.data?.action?.type).toBe("tool_call");
    expect(actionEvents[0]?.data?.action?.function?.name).toBe("kairo_terminal_exec");

    runtime.stop();
  });

  it("should fallback to say when model returns plain text", async () => {
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
      content: "这是普通文本响应，不是 JSON",
      usage: { input: 0, output: 0, total: 0 }
    });

    await bus.publish({
      type: `kairo.agent.${runtime.id}.message`,
      source: "user",
      data: { content: "测试纯文本兜底" }
    });

    await new Promise(resolve => setTimeout(resolve, 80));

    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]?.data?.action?.type).toBe("say");
    expect(actionEvents[0]?.data?.action?.continue).toBe(true);
    expect(actionEvents[0]?.data?.action?.content).toBe("响应格式错误，正在自动纠正并重试。");
    expect(continueEvents).toHaveLength(1);
    expect(continueEvents[0]?.data?.reason).toBe("response_parse_failed");
    expect(mockChat).toHaveBeenCalledTimes(2);

    runtime.stop();
  });

  it("should pass maxTokens to ai chat calls", async () => {
    const runtimeWithMaxTokens = new AgentRuntime({
      ai: mockAI,
      bus,
      memory,
      maxTokens: 256,
    });
    runtimeWithMaxTokens.start();

    await bus.publish({
      type: `kairo.agent.${runtimeWithMaxTokens.id}.message`,
      source: "user",
      data: { content: "测试 maxTokens" }
    });

    await new Promise(resolve => setTimeout(resolve, 80));

    const calls = mockChat.mock.calls as unknown as any[][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[1]).toEqual({ maxTokens: 256 });

    runtimeWithMaxTokens.stop();
  });

  it("should trigger compression at 80 percent of configured maxTokens", async () => {
    const compress = mock(async () => {});
    const lightweightMemory: AgentMemory = {
      getContext: () => "x".repeat(21),
      update: () => {},
      compress: compress as any,
      recall: async () => [],
      memorize: async () => {},
    };
    const runtimeWithThreshold = new AgentRuntime({
      ai: mockAI,
      bus,
      memory: lightweightMemory,
      maxTokens: 10,
    });
    runtimeWithThreshold.start();

    await bus.publish({
      type: `kairo.agent.${runtimeWithThreshold.id}.message`,
      source: "user",
      data: { content: "触发压缩" }
    });

    await new Promise(resolve => setTimeout(resolve, 80));

    expect(compress).toHaveBeenCalledTimes(1);

    runtimeWithThreshold.stop();
  });

  it("should memorize every configured tick interval", async () => {
    const previousInterval = process.env.KAIRO_MEMORY_MEMORIZE_INTERVAL_TICKS;
    process.env.KAIRO_MEMORY_MEMORIZE_INTERVAL_TICKS = "2";
    const memorize = mock(async () => {});
    const lightweightMemory: AgentMemory = {
      getContext: () => "",
      update: () => {},
      compress: async () => {},
      recall: async () => [],
      memorize: memorize as any,
    };
    const runtimeWithPeriodicMemorize = new AgentRuntime({
      ai: mockAI,
      bus,
      memory: lightweightMemory,
    });

    try {
      runtimeWithPeriodicMemorize.start();

      await bus.publish({
        type: `kairo.agent.${runtimeWithPeriodicMemorize.id}.message`,
        source: "user",
        data: { content: "第一条消息" }
      });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(memorize).toHaveBeenCalledTimes(0);

      await bus.publish({
        type: `kairo.agent.${runtimeWithPeriodicMemorize.id}.message`,
        source: "user",
        data: { content: "第二条消息" }
      });
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(memorize).toHaveBeenCalledTimes(1);
      const memorizeContent = (memorize as any).mock.calls[0]?.[0];
      expect(memorizeContent).toContain("Observation:");
      expect(memorizeContent).toContain("Thought:");
      expect(memorizeContent).toContain("Action:");
    } finally {
      runtimeWithPeriodicMemorize.stop();
      process.env.KAIRO_MEMORY_MEMORIZE_INTERVAL_TICKS = previousInterval;
    }
  });
});
