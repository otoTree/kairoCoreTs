import { describe, expect, it } from "bun:test";
import { InMemoryGlobalBus, RingBufferEventStore } from "../events";
import { TaskOrchestrator } from "./task-orchestrator";
import { ReviewAgent } from "./review-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ReviewAgent", () => {
  it("should reject finish without artifact evidence when last say expects artifact", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const reviewAgent = new ReviewAgent(bus, orchestrator);

    const result = await bus.request<
      { scope: string; agentId: string; claimText: string; lastSayContent: string },
      { ok: boolean; reasons: string[] }
    >("kairo.review.request", {
      scope: "agent-finish",
      agentId: "default",
      claimText: "任务完成",
      lastSayContent: "已生成代码文件并保存到 /tmp/output.ts",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("artifact_evidence_missing");
    expect(result.reasons).toContain("expected_path_not_confirmed");
    reviewAgent.stop();
  });

  it("should pass finish when claim confirms expected file path", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const reviewAgent = new ReviewAgent(bus, orchestrator);
    const dir = await mkdtemp(join(tmpdir(), "kairo-review-"));
    const outputPath = join(dir, "output.ts");
    await writeFile(outputPath, "export const ok = true;\n", "utf8");

    const result = await bus.request<
      { scope: string; agentId: string; claimText: string; lastSayContent: string },
      { ok: boolean; reasons: string[] }
    >("kairo.review.request", {
      scope: "agent-finish",
      agentId: "default",
      claimText: `已生成并保存到 ${outputPath}`,
      lastSayContent: `请生成代码文件并保存到 ${outputPath}`,
    });

    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
    reviewAgent.stop();
  });

  it("should reject finish when expected artifact cannot be verified", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const reviewAgent = new ReviewAgent(bus, orchestrator);
    const missingPath = join(tmpdir(), `kairo-review-missing-${Date.now()}.ts`);

    const result = await bus.request<
      { scope: string; agentId: string; claimText: string; lastSayContent: string },
      { ok: boolean; reasons: string[] }
    >("kairo.review.request", {
      scope: "agent-finish",
      agentId: "default",
      claimText: `已生成并保存到 ${missingPath}`,
      lastSayContent: `请生成代码文件并保存到 ${missingPath}`,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("expected_artifact_unverified");
    reviewAgent.stop();
  });

  it("should pass finish without artifact expectation", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const reviewAgent = new ReviewAgent(bus, orchestrator);

    const result = await bus.request<
      { scope: string; agentId: string; claimText: string; lastSayContent: string },
      { ok: boolean; reasons: string[] }
    >("kairo.review.request", {
      scope: "agent-finish",
      agentId: "default",
      claimText: "已完成",
      lastSayContent: "我继续处理中",
    });

    expect(result.ok).toBe(true);
    reviewAgent.stop();
  });

  it("should publish review events from agent actions and notify main agent", async () => {
    const bus = new InMemoryGlobalBus(new RingBufferEventStore());
    const orchestrator = new TaskOrchestrator(bus);
    const reviewAgent = new ReviewAgent(bus, orchestrator);
    let requested: any;
    const failedEvents: any[] = [];
    const mainMessages: any[] = [];
    bus.subscribe("kairo.review.requested", event => {
      requested = event.data;
    });
    bus.subscribe("kairo.review.failed", event => {
      failedEvents.push(event);
    });
    bus.subscribe("kairo.agent.default.message", event => {
      mainMessages.push((event.data as any)?.content);
    });

    await bus.publish({
      type: "kairo.agent.action",
      source: "agent:default",
      data: { action: { type: "say", content: "请生成并保存到 /tmp/not-exist-review.ts" } },
    });
    await bus.publish({
      type: "kairo.agent.action",
      source: "agent:default",
      data: { action: { type: "finish", result: "已保存到 /tmp/not-exist-review.ts" } },
    });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(requested).toBeDefined();
    expect(requested.lastSayContent).toBe("请生成并保存到 /tmp/not-exist-review.ts");
    expect(failedEvents.length).toBeGreaterThan(0);
    expect(mainMessages.some(msg => String(msg).includes("Review 未通过"))).toBe(true);
    reviewAgent.stop();
  });
});
