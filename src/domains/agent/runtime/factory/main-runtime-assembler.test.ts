import { describe, expect, it } from "bun:test";
import { MainRuntimeAssembler } from "./main-runtime-assembler";
import { AgentRuntimeOptionsBuilder } from "./runtime-options-builder";
import { RuntimeMemoryResolver } from "./runtime-memory-resolver";

describe("MainRuntimeAssembler", () => {
  it("should create runtime with provided id", () => {
    const assembler = new MainRuntimeAssembler({
      globalBus: {} as any,
      runtimeOptionsBuilder: new AgentRuntimeOptionsBuilder({
        ai: {} as any,
        sharedMemory: {} as any,
      }),
      memoryResolver: new RuntimeMemoryResolver({}),
    });
    const runtime = assembler.create("default", []);
    expect(runtime.id).toBe("default");
  });
});
