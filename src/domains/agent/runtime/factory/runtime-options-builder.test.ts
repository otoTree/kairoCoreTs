import { describe, expect, it } from "bun:test";
import { AgentRuntimeOptionsBuilder } from "./runtime-options-builder";

describe("AgentRuntimeOptionsBuilder", () => {
  it("should build runtime options with base and input values", () => {
    const onAction = () => {};
    const onLog = () => {};
    const onActionResult = () => {};
    const builder = new AgentRuntimeOptionsBuilder({
      ai: {} as any,
      maxTokens: 512,
      mcp: {} as any,
      sharedMemory: {} as any,
      vault: {} as any,
      callbacks: { onAction, onLog, onActionResult },
    });

    const options = builder.build({
      id: "default",
      bus: {} as any,
      memory: {} as any,
      systemTools: [{ definition: { name: "t", description: "", inputSchema: {} } as any, handler: async () => ({}) }],
    });

    expect(options.id).toBe("default");
    expect(options.maxTokens).toBe(512);
    expect(options.onAction).toBe(onAction);
    expect(options.onLog).toBe(onLog);
    expect(options.onActionResult).toBe(onActionResult);
    expect(options.systemTools?.length).toBe(1);
  });
});
