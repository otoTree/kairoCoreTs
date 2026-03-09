import { describe, expect, it } from "bun:test";
import { RuntimeMemoryResolver } from "./runtime-memory-resolver";

describe("RuntimeMemoryResolver", () => {
  it("should attach memoryStore to default in-memory memory", async () => {
    const resolver = new RuntimeMemoryResolver({
      memoryStore: {
        recall: async () => ["remembered"],
        memorize: async () => {},
      } as any,
    });
    const memory = resolver.resolve();
    const recalled = await memory.recall("query");
    expect(recalled).toEqual(["remembered"]);
  });

  it("should keep provided custom memory unchanged", async () => {
    const customMemory = {
      getContext: () => "",
      update: () => {},
      compress: async () => {},
      recall: async () => ["custom"],
      memorize: async () => {},
    };
    const resolver = new RuntimeMemoryResolver({
      memoryStore: {
        recall: async () => ["store"],
        memorize: async () => {},
      } as any,
    });
    const memory = resolver.resolve(customMemory as any);
    const recalled = await memory.recall("query");
    expect(recalled).toEqual(["custom"]);
  });
});
