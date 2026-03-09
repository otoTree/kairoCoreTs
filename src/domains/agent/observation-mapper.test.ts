import { describe, expect, it } from "bun:test";
import { ObservationMapper } from "./runtime/observation-mapper";

describe("ObservationMapper", () => {
  const mapper = new ObservationMapper("default");

  it("should map user message event", () => {
    const observation = mapper.map({
      id: "e1",
      type: "kairo.agent.default.message",
      source: "user",
      data: { content: "hello" },
      time: new Date().toISOString(),
    } as any);
    expect(observation?.type).toBe("user_message");
  });

  it("should map tool result event", () => {
    const observation = mapper.map({
      id: "e2",
      type: "kairo.tool.result",
      source: "tool:test_tool",
      data: { result: "ok" },
      time: new Date().toISOString(),
    } as any);
    expect(observation?.type).toBe("action_result");
    expect((observation as any)?.action?.function?.name).toBe("test_tool");
  });

  it("should map system continue event", () => {
    const observation = mapper.map({
      id: "e3",
      type: "kairo.agent.internal.continue",
      source: "agent:default",
      data: { reason: "auto_continue_after_say" },
      time: new Date().toISOString(),
    } as any);
    expect(observation?.type).toBe("system_event");
  });
});
