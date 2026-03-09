import { describe, expect, it } from "bun:test";
import { EventFilter } from "./runtime/event-filter";

describe("EventFilter", () => {
  it("should reject unrelated tool results", () => {
    const pendingActions = new Set<string>(["a1"]);
    const pendingCorrelations = new Map<string, string>([["a1", "c1"]]);
    const filter = new EventFilter({
      agentId: "default",
      pendingActions,
      pendingCorrelations,
    });
    const accepted = filter.accept({
      id: "e1",
      type: "kairo.tool.result",
      source: "tool:test",
      data: { result: "ok" },
      time: new Date().toISOString(),
      causationId: "other",
    } as any);
    expect(accepted).toBe(false);
    expect(pendingActions.has("a1")).toBe(true);
  });

  it("should accept and consume matched tool result", () => {
    const pendingActions = new Set<string>(["a1"]);
    const pendingCorrelations = new Map<string, string>([["a1", "c1"]]);
    const filter = new EventFilter({
      agentId: "default",
      pendingActions,
      pendingCorrelations,
    });
    const accepted = filter.accept({
      id: "e2",
      type: "kairo.tool.result",
      source: "tool:test",
      data: { result: "ok" },
      time: new Date().toISOString(),
      causationId: "a1",
    } as any);
    expect(accepted).toBe(true);
    expect(pendingActions.has("a1")).toBe(false);
    expect(pendingCorrelations.has("a1")).toBe(false);
  });
});
