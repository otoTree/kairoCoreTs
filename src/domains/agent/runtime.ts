import type { AIPlugin } from "../ai/ai.plugin";
import type { MCPPlugin } from "../mcp/mcp.plugin";
import type { AgentMemory } from "./memory";
import type { SharedMemory } from "./shared-memory";
import type { EventBus, KairoEvent, CancelEventData } from "../events";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";
import { randomUUID } from "crypto";
import { ResponseParser } from "./runtime/response-parser";
import { ActionExecutor } from "./runtime/action-executor";
import { ToolDispatcher } from "./runtime/tool-dispatcher";
import { ObservationMapper } from "./runtime/observation-mapper";
import { RuntimeEventLoop } from "./runtime/runtime-event-loop";
import { EventFilter } from "./runtime/event-filter";
import { CancelHandler } from "./runtime/cancel-handler";
import type { AgentAction } from "./runtime/action-types";
import { SayLoopGuard } from "./runtime/say-loop-guard";
import { buildTickContext } from "./runtime/tick-context-builder";
import type {
  AgentCapabilityDefinition,
  AgentRuntimeOptions,
  SystemTool,
  SystemToolContext,
  VaultResolver,
} from "./runtime/runtime-types";

export type {
  AgentCapabilityDefinition,
  AgentRuntimeOptions,
  SystemTool,
  SystemToolContext,
  VaultResolver,
} from "./runtime/runtime-types";

export class AgentRuntime {
  public readonly id: string;
  private ai: AIPlugin;
  private mcp?: MCPPlugin;
  private bus: EventBus;
  private memory: AgentMemory;
  private sharedMemory?: SharedMemory;
  private vault?: VaultResolver;
  private onAction?: (action: AgentAction) => void;
  private onLog?: (log: unknown) => void;
  private onActionResult?: (result: { action: AgentAction; result: unknown }) => void;
  private systemTools: Map<string, SystemTool> = new Map();
  private logger: Logger;
  private currentTraceContext?: { traceId: string; spanId: string };
  
  private tickCount: number = 0;
  private running: boolean = false;
  private unsubscribe?: () => void;
  
  private tickHistory: number[] = [];
  // Agent 能力声明
  private capabilities: AgentCapabilityDefinition[] = [];

  // 限制 pendingActions 和 eventBuffer 的最大容量，防止内存泄漏
  private static readonly MAX_PENDING_ACTIONS = 100;
  private static readonly MAX_EVENT_BUFFER = 500;

  // Track pending actions for result correlation
  private pendingActions: Set<string> = new Set();
  // actionEventId → correlationId 映射，用于取消语义
  private pendingCorrelations = new Map<string, string>();

  // 自动继续标志：用于 say 动作后自动触发下一个 Tick
  private shouldAutoContinue: boolean = false;
  private autoContinueReason: string = "auto_continue_after_say";
  private autoContinueStreak: number = 0;
  private lastSayContent?: string;
  private static readonly MAX_REPEATED_SAY_COUNT = 2;
  private static readonly MAX_FALLBACK_SAY_CHARS = 3000000;
  private static readonly DEFAULT_CONTEXT_TOKENS = 40000;
  private static readonly CONTEXT_COMPRESSION_RATIO = 0.8;
  private static readonly CHARS_PER_TOKEN = 2.5;
  private static readonly DEFAULT_MEMORIZE_INTERVAL_TICKS = 5;
  private maxTokens?: number;
  private compressionThresholdChars: number;
  private memorizeIntervalTicks: number;
  private readonly responseParser: ResponseParser;
  private readonly actionExecutor: ActionExecutor;
  private readonly toolDispatcher: ToolDispatcher;
  private readonly observationMapper: ObservationMapper;
  private readonly eventLoop: RuntimeEventLoop;
  private readonly eventFilter: EventFilter;
  private readonly cancelHandler: CancelHandler;
  private readonly sayLoopGuard: SayLoopGuard;

  constructor(options: AgentRuntimeOptions) {
    this.id = options.id || "default";
    this.ai = options.ai;
    this.maxTokens = options.maxTokens && options.maxTokens > 0 ? Math.floor(options.maxTokens) : undefined;
    this.mcp = options.mcp;
    this.bus = options.bus;
    this.memory = options.memory;
    this.sharedMemory = options.sharedMemory;
    this.vault = options.vault;
    this.onAction = options.onAction;
    this.onLog = options.onLog;
    this.onActionResult = options.onActionResult;
    this.logger = rootLogger.child({ component: `AgentRuntime:${this.id}` });
    this.observationMapper = new ObservationMapper(this.id);
    this.eventFilter = new EventFilter({
      agentId: this.id,
      pendingActions: this.pendingActions,
      pendingCorrelations: this.pendingCorrelations,
    });
    this.cancelHandler = new CancelHandler({
      agentId: this.id,
      pendingActions: this.pendingActions,
      pendingCorrelations: this.pendingCorrelations,
      log: (message) => this.log(message),
      publish: this.publish.bind(this),
    });
    this.toolDispatcher = new ToolDispatcher({
      mcp: this.mcp,
      vault: this.vault,
      systemTools: this.systemTools,
      log: this.log.bind(this),
      getTraceContext: () => this.currentTraceContext,
    });
    this.responseParser = new ResponseParser();
    this.sayLoopGuard = new SayLoopGuard(AgentRuntime.MAX_REPEATED_SAY_COUNT);
    this.actionExecutor = new ActionExecutor({
      agentId: this.id,
      maxPendingActions: AgentRuntime.MAX_PENDING_ACTIONS,
      pendingActions: this.pendingActions,
      pendingCorrelations: this.pendingCorrelations,
      onActionResult: (result) => this.onActionResult?.(result),
      publish: this.publish.bind(this),
      dispatchToolCall: this.toolDispatcher.dispatch.bind(this.toolDispatcher),
      log: this.log.bind(this),
    });
    this.eventLoop = new RuntimeEventLoop({
      maxEventBuffer: AgentRuntime.MAX_EVENT_BUFFER,
      isRunning: () => this.running,
      onTick: this.tick.bind(this),
      onError: (error) => {
        console.error("[AgentRuntime] Tick error:", error);
      },
      setTraceContext: (context) => {
        this.currentTraceContext = context;
      },
      createTraceContext: (trigger) => ({
        traceId: trigger?.traceId || randomUUID(),
        spanId: randomUUID(),
      }),
      consumeAutoContinueReason: () => this.consumeAutoContinueReason(),
      publishAutoContinue: (reason) => {
        this.publish({
          type: "kairo.agent.internal.continue",
          source: "agent:" + this.id,
          data: { reason },
        });
      },
      log: this.log.bind(this),
    });
    
    if (options.systemTools) {
        options.systemTools.forEach(t => {
            this.registerSystemTool(t.definition, t.handler);
        });
    }
    this.capabilities = options.capabilities || [];
    this.compressionThresholdChars = this.resolveCompressionThresholdChars();
    this.memorizeIntervalTicks = this.resolveMemorizeIntervalTicks();
  }

  private resolveCompressionThresholdChars(): number {
    const contextTokens = this.maxTokens || AgentRuntime.DEFAULT_CONTEXT_TOKENS;
    return Math.max(
      1,
      Math.floor(contextTokens * AgentRuntime.CONTEXT_COMPRESSION_RATIO * AgentRuntime.CHARS_PER_TOKEN),
    );
  }

  private resolveMemorizeIntervalTicks(): number {
    const raw = process.env.KAIRO_MEMORY_MEMORIZE_INTERVAL_TICKS;
    if (!raw) {
      return AgentRuntime.DEFAULT_MEMORIZE_INTERVAL_TICKS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return AgentRuntime.DEFAULT_MEMORIZE_INTERVAL_TICKS;
    }
    return parsed;
  }

  registerSystemTool(
    definition: unknown,
    handler: (args: Record<string, unknown>, context: SystemToolContext) => Promise<unknown>,
  ) {
    const typedDefinition = definition as SystemTool["definition"];
    this.systemTools.set(typedDefinition.name, { definition: typedDefinition, handler });
  }

  private log(message: string, data?: unknown) {
    const logger = this.currentTraceContext ? this.logger.withContext(this.currentTraceContext) : this.logger;
    logger.info(message, this.asLogObject(data));
    
    if (this.onLog) {
      this.onLog({
        type: 'debug',
        message: message,
        data: data,
        ts: Date.now(),
        ...this.currentTraceContext
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.tickHistory = [];
    this.log(`Starting event-driven agent loop...`);
    
    // Subscribe to standard Kairo events
    // We listen to user messages and tool results (and legacy events for compat)
    // Note: 'kairo.legacy.*' includes 'user_message', 'system_event', etc.
    // 'kairo.tool.result' is the new standard
    // 'kairo.agent.action' is emitted by us, so we ignore it (or use it for history?)
    // For now, we subscribe to everything relevant and filter in the handler
    
    const unsubs: (() => void)[] = [];
    
    // Subscribe to legacy events (compatibility)
    // We moved legacy handling to AgentPlugin (Orchestrator) to prevent broadcast storm
    // unsubs.push(this.bus.subscribe("kairo.legacy.*", this.handleEvent.bind(this)));
    
    // Subscribe to tool results (standard)
    unsubs.push(this.bus.subscribe("kairo.tool.result", this.handleEvent.bind(this)));

    // Subscribe to global user messages (Runtime filters by targetAgentId internally)
    unsubs.push(this.bus.subscribe("kairo.user.message", this.handleEvent.bind(this)));

    // Subscribe to direct agent messages (Router handles user.message -> agent.ID.message)
    unsubs.push(this.bus.subscribe(`kairo.agent.${this.id}.message`, this.handleEvent.bind(this)));

    // Subscribe to system events
    unsubs.push(this.bus.subscribe("kairo.system.>", this.handleEvent.bind(this)));

    // 订阅内部继续事件（使用通配符匹配）
    unsubs.push(this.bus.subscribe("kairo.agent.internal.>", this.handleEvent.bind(this)));

    // 订阅取消事件
    unsubs.push(this.bus.subscribe("kairo.cancel", this.handleCancel.bind(this)));

    // 订阅任务委派事件
    unsubs.push(this.bus.subscribe(`kairo.agent.${this.id}.task`, this.handleTaskEvent.bind(this)));

    this.unsubscribe = () => {
      unsubs.forEach(u => u());
    };

    // 广播能力声明
    if (this.capabilities.length > 0) {
      for (const cap of this.capabilities) {
        this.publish({
          type: "kairo.agent.capability",
          source: `agent:${this.id}`,
          data: {
            agentId: this.id,
            name: cap.name,
            description: cap.description,
            inputSchema: cap.inputSchema,
            registeredAt: Date.now(),
          },
        });
      }
    }

    // Initial check (if any events were persisted/replayed?)
    // Usually we wait for events.
  }

  stop() {
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.log("Stopped.");
  }

  private handleEvent(event: KairoEvent) {
    if (!this.running) return;
    if (!this.eventFilter.accept(event)) return;
    this.eventLoop.enqueue(event);
  }

  /**
   * 处理取消事件：终止匹配 correlationId 的待处理动作
   */
  private handleCancel(event: KairoEvent) {
    if (!this.running) return;
    this.cancelHandler.handle(event);
  }

  /**
   * 处理任务委派事件：将任务转为 Agent 可理解的消息
   */
  private handleTaskEvent(event: KairoEvent) {
    if (!this.running) return;
    const taskData = (event.data as Record<string, unknown>) || {};

    this.eventLoop.enqueue({
      ...event,
      type: `kairo.agent.${this.id}.message`,
      data: {
        content: `[委派任务] 来自 Agent ${String(taskData.parentId || "")}:\n任务: ${String(taskData.description || "")}\n输入: ${JSON.stringify(taskData.input || {})}\n请完成此任务并回复结果。`,
        taskId: taskData.taskId,
        parentId: taskData.parentId,
      },
    });
  }

  private async tick(events: KairoEvent[]) {
    this.tickCount++;
    this.tickHistory.push(Date.now());
    const tickContext = await buildTickContext({
      events,
      ai: this.ai,
      mcp: this.mcp,
      memory: this.memory,
      observationMapper: event => this.observationMapper.map(event),
      systemTools: this.systemTools,
      sharedMemory: this.sharedMemory,
      compressionThresholdChars: this.compressionThresholdChars,
      agentId: this.id,
    });
    if (!tickContext) {
      return;
    }
    const { observations, systemPrompt, userPrompt, correlationId, causationId } = tickContext;

    this.log(`Tick #${this.tickCount} processing...`);
    this.log(`Input Prompt:`, { system: systemPrompt, user: userPrompt });

    try {
      const response = await this.ai.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        this.maxTokens ? { maxTokens: this.maxTokens } : undefined,
      );

      if (response.usage) {
        this.log(`Token Usage: Input=${response.usage.input}, Output=${response.usage.output}`, response.usage);
      }
      
      this.log(`Raw Output:`, response.content);

      const { thought, action: parsedAction } = this.responseParser.parse(response.content);
      let action = parsedAction;
      if (this.sayLoopGuard.shouldConvertToNoop(action)) {
        const repeatedContent = action.type === "say" ? action.content : undefined;
        this.log("Detected repeated say loop, converting action to noop.", { content: repeatedContent });
        action = { type: "noop" };
      }
      
      this.log(`Thought: ${thought}`);
      this.log(`Action:`, action);
      if (this.onAction) {
        this.onAction(action);
      }

      // Publish Thought Event (Intent Started)
      this.publish({
          type: "kairo.agent.thought",
          source: "agent:" + this.id,
          data: { thought },
          correlationId,
          causationId
      });

      // PLAN: Intent Started
      this.publish({
          type: "kairo.intent.started",
          source: "agent:" + this.id,
          data: { intent: thought },
          correlationId,
          causationId
      });

      const execution = await this.actionExecutor.execute({
        thought,
        action,
        correlationId,
        causationId,
        state: {
          shouldAutoContinue: this.shouldAutoContinue,
          autoContinueReason: this.autoContinueReason,
          autoContinueStreak: this.autoContinueStreak,
          lastSayContent: this.lastSayContent,
        },
      });
      this.shouldAutoContinue = execution.state.shouldAutoContinue;
      this.autoContinueReason = execution.state.autoContinueReason;
      this.autoContinueStreak = execution.state.autoContinueStreak;
      this.lastSayContent = execution.state.lastSayContent;
      const actionResult = execution.actionResult;

      // Update Memory
      const memorySnapshot = {
        observation: JSON.stringify(observations),
        thought,
        action: JSON.stringify(action),
        actionResult: action.type === 'tool_call' ? undefined : (actionResult ? (typeof actionResult === 'string' ? actionResult : JSON.stringify(actionResult)) : undefined),
      };
      this.memory.update(memorySnapshot);
      await this.memorizeByTick(memorySnapshot);


    } catch (error) {
      console.error("[AgentRuntime] Error in tick:", error);
      const msg = this.describeRuntimeError(error);
      await this.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.id,
        data: { action: { type: "say", content: msg } },
        correlationId,
        causationId
      });
    }
  }

  private async memorizeByTick(snapshot: { observation: string; thought: string; action: string; actionResult?: string }) {
    if (this.tickCount % this.memorizeIntervalTicks !== 0) {
      return;
    }
    try {
      await this.memory.memorize(this.formatMemorizeContent(snapshot));
    } catch (error) {
      console.warn("[AgentRuntime] Failed to persist long-term memory:", error);
    }
  }

  private formatMemorizeContent(snapshot: { observation: string; thought: string; action: string; actionResult?: string }): string {
    return `Observation: ${snapshot.observation}\nThought: ${snapshot.thought}\nAction: ${snapshot.action}${snapshot.actionResult ? `\nResult: ${snapshot.actionResult}` : ""}`;
  }
  
  private consumeAutoContinueReason(): string | null {
    if (!this.shouldAutoContinue) {
      return null;
    }
    this.shouldAutoContinue = false;
    const reason = this.autoContinueReason;
    this.autoContinueReason = "auto_continue_after_say";
    return reason;
  }

  private describeRuntimeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.includes("OPENAI_API_KEY missing") || raw.includes("401")) {
      return "LLM 未配置或密钥无效。请设置 OPENAI_API_KEY（或切换可用模型）后重试。";
    }
    return "Agent 暂时不可用，已记录错误日志。请稍后重试。";
  }

  private async publish(payload: Record<string, unknown>) {
    const eventPayload = payload as Omit<KairoEvent<unknown>, "id" | "time" | "specversion">;
    return this.bus.publish({
      ...eventPayload,
      ...this.currentTraceContext,
    });
  }

  private asLogObject(data: unknown): object | undefined {
    if (data === undefined) {
      return undefined;
    }
    if (typeof data === "object" && data !== null) {
      return data;
    }
    return { data };
  }
}
