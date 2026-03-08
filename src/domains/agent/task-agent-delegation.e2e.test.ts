import { beforeEach, describe, expect, it, mock } from "bun:test";
import { InMemoryGlobalBus, RingBufferEventStore } from "../events";
import { TaskOrchestrator, TaskStatus, TaskType } from "./task-orchestrator";
import { TaskAgentManager, type TaskAgentConfig } from "./task-agent-manager";
import { TaskAgentRuntimeAdapter } from "./task-agent-runtime-adapter";
import { AgentRuntime } from "./runtime";
import { InMemoryAgentMemory } from "./memory";
import { ReviewAgent } from "./review-agent";
import type { AIPlugin } from "../ai/ai.plugin";
import type { AIProvider } from "../ai/types";

const mockChat = mock(async () => ({
  content: JSON.stringify({ thought: "noop", action: { type: "noop" } }),
  usage: { input: 0, output: 0, total: 0 },
}));

const mockAI: AIPlugin = {
  name: "ai",
  setup: () => {},
  start: async () => {},
  registerProvider: () => {},
  getProvider: () => ({} as AIProvider),
  chat: mockChat as any,
} as unknown as AIPlugin;

describe("Task Agent delegation e2e", () => {
  beforeEach(() => {
    (mockChat as any).mockReset?.();
  });

  it("should delegate long task to task agent and complete with progress", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const mainAgentMessages: string[] = [];
    const leakedEvents: string[] = [];

    bus.subscribe("kairo.agent.default.message", event => {
      const content = (event.data as any)?.content;
      if (typeof content === "string") {
        mainAgentMessages.push(content);
      }
    });
    bus.subscribe("kairo.agent.thought", event => {
      leakedEvents.push(event.type);
    });

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "先汇报一次进度，然后继续",
        action: { type: "say", content: "✅ 已完成第 1 步 (1/1)", continue: true },
      }),
      usage: { input: 0, output: 0, total: 0 },
    });
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "任务完成",
        action: { type: "finish", result: "done" },
      }),
      usage: { input: 0, output: 0, total: 0 },
    });

    const manager = new TaskAgentManager(
      bus,
      orchestrator,
      async (config: TaskAgentConfig) => {
        const runtime = new AgentRuntime({
          id: config.id,
          ai: mockAI,
          bus: config.bus!,
          memory: new InMemoryAgentMemory(),
        });
        new TaskAgentRuntimeAdapter(runtime, config.bus!, config);
        return runtime;
      },
    );

    const task = orchestrator.createTask({
      type: TaskType.LONG,
      description: "生成测试数据",
      agentId: "default",
      context: { totalSteps: 1 },
      config: { autoResume: true, checkpointInterval: 1 },
    });
    orchestrator.startTask(task.id);

    await new Promise(resolve => setTimeout(resolve, 220));

    const updated = orchestrator.getTask(task.id);
    expect(updated?.status).toBe(TaskStatus.COMPLETED);
    expect(updated?.progress?.current).toBe(1);
    expect(updated?.progress?.total).toBe(1);
    expect(mainAgentMessages.some(m => m.includes("Task Agent 进度"))).toBe(true);
    expect(mainAgentMessages.some(m => m.includes("已完成任务"))).toBe(true);
    expect(manager.getActiveTaskAgents().length).toBe(0);
    expect(leakedEvents).toHaveLength(0);
  });

  it("should notify main agent when task agent returns noop action", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const mainAgentMessages: string[] = [];

    bus.subscribe("kairo.agent.default.message", event => {
      const content = (event.data as any)?.content;
      if (typeof content === "string") {
        mainAgentMessages.push(content);
      }
    });

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "当前没有可执行动作",
        action: { type: "noop" },
      }),
      usage: { input: 0, output: 0, total: 0 },
    });

    const manager = new TaskAgentManager(
      bus,
      orchestrator,
      async (config: TaskAgentConfig) => {
        const runtime = new AgentRuntime({
          id: config.id,
          ai: mockAI,
          bus: config.bus!,
          memory: new InMemoryAgentMemory(),
        });
        new TaskAgentRuntimeAdapter(runtime, config.bus!, config);
        return runtime;
      },
    );

    const task = orchestrator.createTask({
      type: TaskType.LONG,
      description: "等待外部事件触发",
      agentId: "default",
      context: { totalSteps: 5 },
      config: { autoResume: true, checkpointInterval: 1 },
    });
    orchestrator.startTask(task.id);

    await new Promise(resolve => setTimeout(resolve, 180));

    const updated = orchestrator.getTask(task.id);
    expect(updated?.status).toBe(TaskStatus.RUNNING);
    expect(mainAgentMessages.some(m => m.includes("Task Agent 状态"))).toBe(true);
    expect(mainAgentMessages.some(m => m.includes("无可执行动作"))).toBe(true);
    expect(manager.getActiveTaskAgents().length).toBe(1);
  });

  it("should fail task completion when review rejects incomplete progress", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const mainAgentMessages: string[] = [];
    const reviewAgent = new ReviewAgent(bus, orchestrator);

    bus.subscribe("kairo.agent.default.message", event => {
      const content = (event.data as any)?.content;
      if (typeof content === "string") {
        mainAgentMessages.push(content);
      }
    });

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        thought: "任务完成",
        action: { type: "finish", result: "done" },
      }),
      usage: { input: 0, output: 0, total: 0 },
    });

    const manager = new TaskAgentManager(
      bus,
      orchestrator,
      async (config: TaskAgentConfig) => {
        const runtime = new AgentRuntime({
          id: config.id,
          ai: mockAI,
          bus: config.bus!,
          memory: new InMemoryAgentMemory(),
        });
        new TaskAgentRuntimeAdapter(runtime, config.bus!, config);
        return runtime;
      },
      { reviewEnabled: true, reviewTimeoutMs: 200 },
    );

    const task = orchestrator.createTask({
      type: TaskType.LONG,
      description: "需要进度闭环",
      agentId: "default",
      context: { totalSteps: 2 },
      config: { autoResume: true, checkpointInterval: 1 },
    });
    orchestrator.startTask(task.id);

    await new Promise(resolve => setTimeout(resolve, 260));

    const updated = orchestrator.getTask(task.id);
    expect(updated?.status).toBe(TaskStatus.FAILED);
    expect(mainAgentMessages.some(m => m.includes("Review 未通过"))).toBe(true);
    expect(manager.getActiveTaskAgents().length).toBe(0);
    reviewAgent.stop();
  });
});
