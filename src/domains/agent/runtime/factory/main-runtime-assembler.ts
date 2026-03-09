import type { EventBus } from "../../../events";
import type { AgentMemory } from "../../memory";
import type { SystemTool } from "../../runtime";
import { AgentRuntime } from "../../runtime";
import { AgentRuntimeOptionsBuilder } from "./runtime-options-builder";
import { RuntimeMemoryResolver } from "./runtime-memory-resolver";

export interface MainRuntimeAssemblerDeps {
  globalBus: EventBus;
  runtimeOptionsBuilder: AgentRuntimeOptionsBuilder;
  memoryResolver: RuntimeMemoryResolver;
}

export class MainRuntimeAssembler {
  constructor(private readonly deps: MainRuntimeAssemblerDeps) {}

  create(id: string, systemTools: SystemTool[], memory?: AgentMemory): AgentRuntime {
    return new AgentRuntime(
      this.deps.runtimeOptionsBuilder.build({
        id,
        bus: this.deps.globalBus,
        memory: this.deps.memoryResolver.resolve(memory),
        systemTools,
      }),
    );
  }
}
