import type { AgentMemory } from "./memory";
import { AgentRuntime, type SystemTool } from "./runtime";
import type { TaskAgentConfig } from "./task";
import { TaskRuntimeAssembler } from "./runtime/factory/task-runtime-assembler";
import { MainRuntimeAssembler } from "./runtime/factory/main-runtime-assembler";
import { composeRuntimeFactory, type RuntimeFactoryComposerInput } from "./runtime/factory/factory-composer";

export type AgentRuntimeFactoryOptions = RuntimeFactoryComposerInput;

export class AgentRuntimeFactory {
  private readonly mainRuntimeAssembler: MainRuntimeAssembler;
  private readonly taskRuntimeAssembler: TaskRuntimeAssembler;

  constructor(options: AgentRuntimeFactoryOptions) {
    const composed = composeRuntimeFactory(options);
    this.mainRuntimeAssembler = composed.mainRuntimeAssembler;
    this.taskRuntimeAssembler = composed.taskRuntimeAssembler;
  }

  spawnAgent(
    agents: Map<string, AgentRuntime>,
    id: string,
    systemTools: SystemTool[],
    memory?: AgentMemory,
  ): AgentRuntime {
    const existing = agents.get(id);
    if (existing) {
      return existing;
    }

    const runtime = this.mainRuntimeAssembler.create(id, systemTools, memory);
    agents.set(id, runtime);
    runtime.start();
    return runtime;
  }

  createTaskAgentRuntime(config: TaskAgentConfig, systemTools: SystemTool[]): AgentRuntime {
    return this.taskRuntimeAssembler.create(config, systemTools);
  }
}
