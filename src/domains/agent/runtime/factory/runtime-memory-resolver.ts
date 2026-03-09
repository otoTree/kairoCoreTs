import type { MemoryStore } from "../../../memory/memory-store";
import { InMemoryAgentMemory, type AgentMemory } from "../../memory";

export interface RuntimeMemoryResolverOptions {
  memoryStore?: MemoryStore;
}

export class RuntimeMemoryResolver {
  constructor(private readonly options: RuntimeMemoryResolverOptions) {}

  resolve(memory?: AgentMemory): AgentMemory {
    const resolved = memory || new InMemoryAgentMemory();
    if (this.options.memoryStore && resolved instanceof InMemoryAgentMemory) {
      resolved.setLongTermMemory(this.options.memoryStore);
    }
    return resolved;
  }
}
