import type { AIPlugin } from "../../../ai/ai.plugin";
import type { EventBus } from "../../../events";
import type { MemoryStore } from "../../../memory/memory-store";
import type { MCPPlugin } from "../../../mcp/mcp.plugin";
import type { Vault } from "../../../vault/vault";
import type { SharedMemory } from "../../shared-memory";
import type { RuntimeBuilderCallbacks } from "./runtime-options-builder";
import { AgentRuntimeOptionsBuilder } from "./runtime-options-builder";
import { RuntimeMemoryResolver } from "./runtime-memory-resolver";
import { MainRuntimeAssembler } from "./main-runtime-assembler";
import { TaskRuntimeAssembler } from "./task-runtime-assembler";

export interface RuntimeFactoryComposerInput {
  ai: AIPlugin;
  maxTokens?: number;
  mcp?: MCPPlugin;
  globalBus: EventBus;
  sharedMemory: SharedMemory;
  vault?: Vault;
  memoryStore?: MemoryStore;
  callbacks?: RuntimeBuilderCallbacks;
}

export interface RuntimeFactoryComposerOutput {
  mainRuntimeAssembler: MainRuntimeAssembler;
  taskRuntimeAssembler: TaskRuntimeAssembler;
}

export function composeRuntimeFactory(input: RuntimeFactoryComposerInput): RuntimeFactoryComposerOutput {
  const memoryResolver = new RuntimeMemoryResolver({
    memoryStore: input.memoryStore,
  });
  const runtimeOptionsBuilder = new AgentRuntimeOptionsBuilder({
    ai: input.ai,
    maxTokens: input.maxTokens,
    mcp: input.mcp,
    sharedMemory: input.sharedMemory,
    vault: input.vault,
    callbacks: input.callbacks,
  });
  return {
    mainRuntimeAssembler: new MainRuntimeAssembler({
      globalBus: input.globalBus,
      runtimeOptionsBuilder,
      memoryResolver,
    }),
    taskRuntimeAssembler: new TaskRuntimeAssembler({
      globalBus: input.globalBus,
      runtimeOptionsBuilder,
      memoryResolver,
    }),
  };
}
