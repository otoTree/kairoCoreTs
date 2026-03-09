import type { EventBus } from "../../../events";
import type { SystemTool } from "../../runtime";
import { AgentRuntime } from "../../runtime";
import { type TaskAgentConfig, TaskAgentRuntimeAdapter } from "../../task";
import { AgentRuntimeOptionsBuilder } from "./runtime-options-builder";
import { RuntimeMemoryResolver } from "./runtime-memory-resolver";

export interface TaskRuntimeAssemblerDeps {
  globalBus: EventBus;
  runtimeOptionsBuilder: AgentRuntimeOptionsBuilder;
  memoryResolver: RuntimeMemoryResolver;
}

export class TaskRuntimeAssembler {
  constructor(private readonly deps: TaskRuntimeAssemblerDeps) {}

  create(config: TaskAgentConfig, systemTools: SystemTool[]): AgentRuntime {
    const bus = config.bus || this.deps.globalBus;
    const runtime = new AgentRuntime(
      this.deps.runtimeOptionsBuilder.build({
        id: config.id,
        bus,
        memory: this.deps.memoryResolver.resolve(),
        systemTools,
      }),
    );
    new TaskAgentRuntimeAdapter(runtime, bus, config);
    return runtime;
  }
}
