import { describe, expect, it, mock } from "bun:test";
import { CancelHandler } from "./runtime/cancel-handler";

describe("CancelHandler", () => {
  it("should cancel matched pending action and publish event", () => {
    const pendingActions = new Set<string>(["a1"]);
    const pendingCorrelations = new Map<string, string>([["a1", "corr-1"]]);
    const publish = mock(async () => "evt-1");
    const handler = new CancelHandler({
      agentId: "default",
      pendingActions,
      pendingCorrelations,
      log: () => {},
      publish,
    });
    handler.handle({
      id: "cancel-1",
      type: "kairo.cancel",
      source: "user",
      data: { targetCorrelationId: "corr-1", reason: "stop" },
      time: new Date().toISOString(),
    } as any);

    expect(pendingActions.has("a1")).toBe(false);
    expect(pendingCorrelations.has("a1")).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
