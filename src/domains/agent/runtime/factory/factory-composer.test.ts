import { describe, expect, it } from "bun:test";
import { composeRuntimeFactory } from "./factory-composer";

describe("composeRuntimeFactory", () => {
  it("should compose main and task runtime assemblers", () => {
    const composed = composeRuntimeFactory({
      ai: {} as any,
      globalBus: {} as any,
      sharedMemory: {} as any,
    });

    expect(composed.mainRuntimeAssembler).toBeDefined();
    expect(composed.taskRuntimeAssembler).toBeDefined();
  });
});
