import type { AIPlugin } from "../ai/ai.plugin";
import type { MCPPlugin } from "../mcp/mcp.plugin";
import type { Observation } from "./observation-bus"; // Still need type for memory compat
import type { AgentMemory } from "./memory";
import type { SharedMemory } from "./shared-memory";
import type { EventBus, KairoEvent, CancelEventData } from "../events";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { rootLogger } from "../observability/logger";
import type { Logger } from "../observability/types";
import { randomUUID } from "crypto";

export interface SystemToolContext {
  agentId: string;
  traceId?: string;
  spanId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface SystemTool {
  definition: Tool;
  handler: (args: any, context: SystemToolContext) => Promise<any>;
}

export interface VaultResolver {
  resolve(handleId: string): string | undefined;
}

export interface AgentRuntimeOptions {
  id?: string;
  ai: AIPlugin;
  maxTokens?: number;
  mcp?: MCPPlugin;
  bus: EventBus;
  memory: AgentMemory;
  sharedMemory?: SharedMemory;
  vault?: VaultResolver;
  onAction?: (action: any) => void;
  onLog?: (log: any) => void;
  onActionResult?: (result: any) => void;
  systemTools?: SystemTool[];
  capabilities?: { name: string; description: string; inputSchema?: any }[];
}

export class AgentRuntime {
  public readonly id: string;
  private ai: AIPlugin;
  private mcp?: MCPPlugin;
  private bus: EventBus;
  private memory: AgentMemory;
  private sharedMemory?: SharedMemory;
  private vault?: VaultResolver;
  private onAction?: (action: any) => void;
  private onLog?: (log: any) => void;
  private onActionResult?: (result: any) => void;
  private systemTools: Map<string, SystemTool> = new Map();
  private logger: Logger;
  private currentTraceContext?: { traceId: string; spanId: string };
  
  private tickCount: number = 0;
  private running: boolean = false;
  private unsubscribe?: () => void;
  
  private isTicking: boolean = false;
  private hasPendingUpdate: boolean = false;
  private tickHistory: number[] = [];
  private tickLock: Promise<void> = Promise.resolve();
  // Agent 能力声明
  private capabilities: { name: string; description: string; inputSchema?: any }[] = [];

  // 限制 pendingActions 和 eventBuffer 的最大容量，防止内存泄漏
  private static readonly MAX_PENDING_ACTIONS = 100;
  private static readonly MAX_EVENT_BUFFER = 500;

  // Track pending actions for result correlation
  private pendingActions: Set<string> = new Set();
  // actionEventId → correlationId 映射，用于取消语义
  private pendingCorrelations = new Map<string, string>();

  // Internal event buffer to replace legacy adapter
  private eventBuffer: KairoEvent[] = [];

  // 自动继续标志：用于 say 动作后自动触发下一个 Tick
  private shouldAutoContinue: boolean = false;
  private autoContinueReason: string = "auto_continue_after_say";
  private autoContinueStreak: number = 0;
  private lastSaySignature: string | null = null;
  private lastSayContent?: string;
  private repeatedSayCount: number = 0;
  private static readonly MAX_REPEATED_SAY_COUNT = 2;
  private static readonly MAX_FALLBACK_SAY_CHARS = 3000000;
  private static readonly DEFAULT_CONTEXT_TOKENS = 40000;
  private static readonly CONTEXT_COMPRESSION_RATIO = 0.8;
  private static readonly CHARS_PER_TOKEN = 2.5;
  private static readonly DEFAULT_MEMORIZE_INTERVAL_TICKS = 5;
  private maxTokens?: number;
  private compressionThresholdChars: number;
  private memorizeIntervalTicks: number;

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

  registerSystemTool(definition: Tool, handler: (args: any, context: SystemToolContext) => Promise<any>) {
    this.systemTools.set(definition.name, { definition, handler });
  }

  private log(message: string, data?: any) {
    const logger = this.currentTraceContext ? this.logger.withContext(this.currentTraceContext) : this.logger;
    logger.info(message, data);
    
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
    
    // Filter out our own emissions if necessary to avoid loops
    // (though 'tool.result' comes from tools, and 'legacy' comes from outside usually)

    // Filter tool results: Only accept if we caused it
    if (event.type === "kairo.tool.result") {
        if (!event.causationId || !this.pendingActions.has(event.causationId)) {
            // Not for us
            return;
        }
        // It is for us, consume it and remove from pending
        this.pendingActions.delete(event.causationId);
        this.pendingCorrelations.delete(event.causationId);
    }

    // Filter user messages if targeted
    if (event.type === "kairo.user.message") {
        const target = (event.data as any).targetAgentId;
        if (target && target !== this.id) {
            return;
        }
    }
    
    this.eventBuffer.push(event);
    // 防止 eventBuffer 无限增长
    if (this.eventBuffer.length > AgentRuntime.MAX_EVENT_BUFFER) {
      this.eventBuffer = this.eventBuffer.slice(-AgentRuntime.MAX_EVENT_BUFFER);
    }
    this.onObservation();
  }

  /**
   * 处理取消事件：终止匹配 correlationId 的待处理动作
   */
  private handleCancel(event: KairoEvent) {
    if (!this.running) return;
    const data = event.data as CancelEventData;
    if (!data?.targetCorrelationId) return;

    // 查找匹配的 pendingAction
    for (const [actionId, corrId] of this.pendingCorrelations) {
      if (corrId === data.targetCorrelationId) {
        this.pendingActions.delete(actionId);
        this.pendingCorrelations.delete(actionId);

        this.log(`取消动作 ${actionId}，原因: ${data.reason || '用户取消'}`);

        // 发布取消完成事件
        this.publish({
          type: "kairo.intent.cancelled",
          source: "agent:" + this.id,
          data: { actionId, reason: data.reason },
          correlationId: data.targetCorrelationId,
          causationId: event.id,
        });
        break;
      }
    }
  }

  /**
   * 处理任务委派事件：将任务转为 Agent 可理解的消息
   */
  private handleTaskEvent(event: KairoEvent) {
    if (!this.running) return;
    const taskData = event.data as any;

    this.eventBuffer.push({
      ...event,
      type: `kairo.agent.${this.id}.message`,
      data: {
        content: `[委派任务] 来自 Agent ${taskData.parentId}:\n任务: ${taskData.description}\n输入: ${JSON.stringify(taskData.input || {})}\n请完成此任务并回复结果。`,
        taskId: taskData.taskId,
        parentId: taskData.parentId,
      },
    });
    if (this.eventBuffer.length > AgentRuntime.MAX_EVENT_BUFFER) {
      this.eventBuffer = this.eventBuffer.slice(-AgentRuntime.MAX_EVENT_BUFFER);
    }
    this.onObservation();
  }

  private onObservation() {
    if (!this.running) return;

    // 使用 Promise 链作为互斥锁，防止并发 tick
    this.tickLock = this.tickLock.then(() => this.processTick());
  }

  private async processTick() {
    if (!this.running) return;

    this.isTicking = true;
    this.hasPendingUpdate = false;

    try {
      // Drain buffer immediately to capture current state
      const eventsToProcess = [...this.eventBuffer];
      this.eventBuffer = [];

      if (eventsToProcess.length > 0) {
        // Trace Setup
        const trigger = eventsToProcess[eventsToProcess.length - 1];
        this.currentTraceContext = {
            traceId: trigger?.traceId || randomUUID(),
            spanId: randomUUID(),
        };

        try {
            await this.tick(eventsToProcess);
        } finally {
            this.currentTraceContext = undefined;
        }
      }
    } catch (error) {
      console.error("[AgentRuntime] Tick error:", error);
    } finally {
      this.isTicking = false;

      // 检查是否需要自动继续
      if (this.shouldAutoContinue) {
        this.shouldAutoContinue = false; // 重置标志
        const continueReason = this.autoContinueReason;
        this.autoContinueReason = "auto_continue_after_say";
        this.log(`Auto-continuing after say action...`);

        // 使用 setTimeout 避免同步递归，让事件循环有机会处理其他事件
        setTimeout(() => {
          if (this.running) {
            // 发布内部继续事件，触发下一个 Tick
            this.publish({
              type: "kairo.agent.internal.continue",
              source: "agent:" + this.id,
              data: { reason: continueReason }
            });
          }
        }, 0);
      }
    }
  }

  private async tick(events: KairoEvent[]) {
    this.tickCount++;
    this.tickHistory.push(Date.now());
    
    // Convert events to Observations for internal logic/memory
    // This is the "Adapter" logic moved inside
    const observations: Observation[] = events.map(e => this.mapEventToObservation(e)).filter((o): o is Observation => o !== null);
    
    if (observations.length === 0) {
        return; // Nothing actionable
    }

    let context = this.memory.getContext();

    if (context.length > this.compressionThresholdChars) {
      console.log(`[AgentRuntime] Context length ${context.length} > ${this.compressionThresholdChars}. Triggering compression...`);
      await this.memory.compress(this.ai);
      context = this.memory.getContext(); // Refresh context
    }

    // MCP Routing
    let toolsContext = "";
    const availableTools: Tool[] = [];

    // Add System Tools
    if (this.systemTools.size > 0) {
        availableTools.push(...Array.from(this.systemTools.values()).map(t => t.definition));
    }

    if (this.mcp) {
        const lastObservation = observations.length > 0 ? JSON.stringify(observations[observations.length - 1]) : context.slice(-500);
        try {
            const mcpTools = await this.mcp.getRelevantTools(lastObservation);
            if (mcpTools.length > 0) {
                availableTools.push(...mcpTools);
            }
        } catch (e) {
            console.warn("[AgentRuntime] Failed to route tools:", e);
        }
    }

    if (availableTools.length > 0) {
        toolsContext = `\n可用工具 (Available Tools):\n${JSON.stringify(availableTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), null, 2)}`;
    }

    // Construct Prompt
    // RECALL: Query memory before planning
    const recentContext = observations.map(o => JSON.stringify(o)).join(" ").slice(-500);
    const recalledMemories = await this.memory.recall(recentContext);
    const memoryContext = recalledMemories.length > 0 ? `\n【Recalled Memories】\n${recalledMemories.join('\n')}` : "";

    const systemPrompt = await this.getSystemPrompt(context, toolsContext, memoryContext);
    const userPrompt = this.composeUserPrompt(observations);
    
    // Determine context for tracing
    const triggerEvent = events[events.length - 1];
    const causationId = triggerEvent?.id;
    const correlationId = triggerEvent?.correlationId || causationId;

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

      const { thought, action: parsedAction } = this.parseResponse(response.content);
      let action = parsedAction;
      if (this.shouldConvertRepeatedSayToNoop(action)) {
        this.log("Detected repeated say loop, converting action to noop.", { content: action.content });
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

      let actionResult = null;
      let actionEventId: string | undefined;

      if (action.type === 'say') {
          this.lastSayContent = typeof action.content === "string" ? action.content : undefined;
          // ACT: Publish Action Event (as progress, not completion)
          actionEventId = await this.publish({
              type: "kairo.agent.action",
              source: "agent:" + this.id,
              data: { action },
              correlationId,
              causationId
          });

          // 发布进度事件，而不是 intent.ended
          this.publish({
              type: "kairo.agent.progress",
              source: "agent:" + this.id,
              data: { message: action.content },
              correlationId,
              causationId: actionEventId
          });

          actionResult = "Progress reported to user";

          const explicitContinue = action.continue === true;
          const explicitStop = action.continue === false || action.final === true;

          // 向后兼容：未显式声明 continue 时，仍支持基于 thought 关键词推断
          const continueKeywords = ['然后', '接下来', '之后', '完成后', '安装后', '执行', '将', 'then', 'next', 'after', 'will'];
          const inferredContinue = !explicitStop && action.continue === undefined && continueKeywords.some(keyword => thought.includes(keyword));
          const shouldContinue = explicitContinue || inferredContinue;

          if (shouldContinue) {
              this.autoContinueStreak += 1;
              // 设置自动继续标志
              this.shouldAutoContinue = true;
              this.autoContinueReason = typeof action.continueReason === "string" && action.continueReason.trim().length > 0
                ? action.continueReason
                : "auto_continue_after_say";
              this.log(`Say action detected follow-up intent, will auto-continue`);
          } else {
              this.autoContinueStreak = 0;
              this.autoContinueReason = "auto_continue_after_say";
              // 没有后续意图，正常结束
              this.publish({
                  type: "kairo.intent.ended",
                  source: "agent:" + this.id,
                  data: { result: actionResult },
                  correlationId,
                  causationId: actionEventId
              });
          }

      } else if (action.type === 'query') {
          this.autoContinueStreak = 0;
          // query 需要等待用户输入，正常结束 intent
          actionEventId = await this.publish({
              type: "kairo.agent.action",
              source: "agent:" + this.id,
              data: { action },
              correlationId,
              causationId
          });
          actionResult = "Waiting for user input";

          // MEMORIZE: Intent Ended (Waiting for user)
          this.publish({
              type: "kairo.intent.ended",
              source: "agent:" + this.id,
              data: { result: actionResult },
              correlationId,
              causationId: actionEventId
          });

      } else if (action.type === 'finish') {
          this.autoContinueStreak = 0;
          actionEventId = await this.publish({
              type: "kairo.agent.action",
              source: "agent:" + this.id,
              data: { action },
              correlationId,
              causationId
          });
          actionResult = action.result ?? "Completed";
          this.publish({
              type: "kairo.intent.ended",
              source: "agent:" + this.id,
              data: { result: actionResult },
              correlationId,
              causationId: actionEventId
          });

      } else if (action.type === 'render') {
          this.autoContinueStreak = 0;
          // ACT: Publish Action Event
          actionEventId = await this.publish({
              type: "kairo.agent.action",
              source: "agent:" + this.id,
              data: { action },
              correlationId,
              causationId
          });
          
          // Publish Render Commit
          await this.publish({
            type: "kairo.agent.render.commit",
            source: "agent:" + this.id,
            data: {
              surfaceId: action.surfaceId || "default",
              tree: action.tree
            },
            correlationId,
            causationId: actionEventId
          });

          actionResult = "UI Rendered";
          
          // MEMORIZE: Intent Ended (Immediate)
          this.publish({
              type: "kairo.intent.ended",
              source: "agent:" + this.id,
              data: { result: actionResult },
              correlationId,
              causationId: actionEventId
          });

      } else if (action.type === 'tool_call') {
          this.autoContinueStreak = 0;
          // Validate action structure
          if (!action.function || !action.function.name) {
              const errorMsg = "Invalid tool_call action: missing function name";
              console.error("[AgentRuntime]", errorMsg, action);
              
              this.publish({
                 type: "kairo.tool.result",
                 source: "system", 
                 data: { error: errorMsg },
                 causationId: actionEventId || causationId,
                 correlationId
              });

              // Intent Ended with Error
              this.publish({
                  type: "kairo.intent.ended",
                  source: "agent:" + this.id,
                  data: { error: errorMsg },
                  correlationId,
                  causationId
              });
              
          } else {
              // ACT: Publish Action Event
              actionEventId = await this.publish({
                  type: "kairo.agent.action",
                  source: "agent:" + this.id,
                  data: { action },
                  correlationId,
                  causationId
              });
              
              this.pendingActions.add(actionEventId);
              // 记录 actionId → correlationId 映射，用于取消语义
              if (correlationId) {
                this.pendingCorrelations.set(actionEventId, correlationId);
              }
              // 限制 pendingActions 大小，清理最早的条目
              if (this.pendingActions.size > AgentRuntime.MAX_PENDING_ACTIONS) {
                const oldest = this.pendingActions.values().next().value;
                if (oldest) {
                  this.pendingActions.delete(oldest);
                  this.pendingCorrelations.delete(oldest);
                }
              }

              try {
                 actionResult = await this.dispatchToolCall(action, { agentId: this.id, correlationId, causationId: actionEventId });
                 if (this.onActionResult) {
                     this.onActionResult({
                         action,
                         result: actionResult
                     });
                 }
                 
                 // Publish standardized result event
                 this.publish({
                     type: "kairo.tool.result",
                     source: "tool:" + action.function.name,
                     data: { result: actionResult },
                     causationId: actionEventId,
                     correlationId
                 });

                 // MEMORIZE: Intent Ended (Success)
                 this.publish({
                     type: "kairo.intent.ended",
                     source: "agent:" + this.id,
                     data: { result: actionResult },
                     correlationId,
                     causationId: actionEventId
                 });

              } catch (e: any) {
                 actionResult = `Tool call failed: ${e.message}`;

                 this.publish({
                     type: "kairo.tool.result",
                     source: "tool:" + action.function.name,
                     data: { error: e.message },
                     causationId: actionEventId,
                     correlationId
                 });

                 // MEMORIZE: Intent Ended (Failure)
                 this.publish({
                     type: "kairo.intent.ended",
                     source: "agent:" + this.id,
                     data: { error: e.message },
                     correlationId,
                     causationId: actionEventId
                 });
              }
          }
      } else {
        this.autoContinueStreak = 0;
        actionResult = "No action needed";
        this.publish({
            type: "kairo.intent.ended",
            source: "agent:" + this.id,
            data: { result: actionResult },
            correlationId,
            causationId
        });
      }

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

  private mapEventToObservation(event: KairoEvent): Observation | null {
    // 1. Legacy events
    if (event.type.startsWith("kairo.legacy.")) {
      return event.data as Observation;
    }

    // 2. Standard User Message (or targeted)
    if (event.type === "kairo.user.message" || event.type === `kairo.agent.${this.id}.message`) {
        return {
            type: "user_message",
            text: (event.data as any).content,
            ts: new Date(event.time).getTime()
        };
    }
    
    // 3. Standard Tool Results
    if (event.type === "kairo.tool.result") {
      // Need to reconstruct context? 
      // The memory expects "action_result".
      // We might need to map it back to what Memory expects.
      return {
        type: "action_result",
        action: { type: "tool_call", function: { name: event.source.replace("tool:", "") } }, // Approximate
        result: (event.data as any).result || (event.data as any).error,
        ts: new Date(event.time).getTime()
      };
    }

    // 4. System Events
    if (event.type === "kairo.agent.internal.continue") {
      return {
        type: "system_event",
        name: event.type,
        payload: event.data,
        ts: new Date(event.time).getTime()
      };
    }

    if (event.type.startsWith("kairo.system.")) {
      return {
        type: "system_event",
        name: event.type,
        payload: event.data,
        ts: new Date(event.time).getTime()
      };
    }

    return null;
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
  
  // Helper methods (getSystemPrompt, composeUserPrompt, parseResponse, dispatchToolCall)
  
  private async getSystemPrompt(context: string, toolsContext: string, memoryContext: string): Promise<string> {
      let facts = "";
      if (this.sharedMemory) {
          const allFacts = await this.sharedMemory.getFacts();
          if (allFacts.length > 0) {
              facts = `\n【Shared Knowledge】\n${allFacts.map(f => `- ${f}`).join('\n')}`;
          }
      }
      const projectRoot = process.env.KAIRO_PROJECT_ROOT || process.cwd();
      const workspaceDir = process.env.KAIRO_WORKSPACE_DIR || projectRoot;
      const skillsDir = process.env.KAIRO_SKILLS_DIR || `${projectRoot}/skills`;
      const mcpDir = process.env.KAIRO_MCP_DIR || `${projectRoot}/mcp`;

      const validActionTypes = ["say", "query", "render", "finish", "noop"];
      if (toolsContext && toolsContext.trim().length > 0) {
          validActionTypes.push("tool_call");
      }
      const hasCreateLongTaskTool = this.systemTools.has("kairo_create_long_task");
      const hasQueryTaskTool = this.systemTools.has("kairo_query_task_status");
      const hasCancelTaskTool = this.systemTools.has("kairo_cancel_task");
      const hasFeishuSendFileTool = this.systemTools.has("kairo_feishu_send_file");
      const longTaskGuidance = hasCreateLongTaskTool ? `

【Long-Running Task Delegation】
- As the main agent, you should stay responsive and delegate long-running multi-step work to Task Agent.
- If the user request is clearly long-running (e.g. generating 100 items, batch processing many files), call tool "kairo_create_long_task" first instead of executing all steps yourself.
- After delegation, use "say" to clearly inform the user the task is running in background and they can continue asking other questions.
- If user asks for progress and tool "${hasQueryTaskTool ? "kairo_query_task_status" : "kairo_create_long_task"}" is available, query task status and report concise progress.
- If user asks to stop background task and tool "${hasCancelTaskTool ? "kairo_cancel_task" : "kairo_create_long_task"}" is available, cancel it and confirm.
- You must actively inspect Task Agent outputs and progress artifacts by yourself.
- If you detect abnormal states (e.g. repeated same outputs, no real progress across multiple reports, obvious loop or persistent execution errors), proactively stop that Task Agent via tool "${hasCancelTaskTool ? "kairo_cancel_task" : "kairo_create_long_task"}" with a clear reason, without waiting for user instruction.
- After proactive stopping, immediately explain to the user why it was stopped and what you will do next.
- Do not pretend delegation happened. Use actual tool calls.
` : "";
      const channelFileGuidance = hasFeishuSendFileTool ? `

【Channel File Delivery】
- If you need to send a local file back to user in Feishu, call tool "kairo_feishu_send_file".
- Do not assume channel adapters will auto-detect file paths from normal text output.
- Prefer absolute local file paths when calling "kairo_feishu_send_file".
` : "";

      return `You are Kairo (Agent ${this.id}), an autonomous AI agent running on the user's local machine.
Your goal is to assist the user with their tasks efficiently and safely.

【Environment】
- OS: ${process.platform}
- CWD: ${process.cwd()}
- ProjectRoot: ${projectRoot}
- Workspace: ${workspaceDir}
- SkillsDir: ${skillsDir}
- MCPDir: ${mcpDir}
- Date: ${new Date().toISOString()}

${facts}
${memoryContext}

【Capabilities】
- You can execute shell commands.
- You can read/write files.
- You can use provided tools.
- You can extend your capabilities by equipping Skills. Use \`kairo_search_skills\` to find skills and \`kairo_equip_skill\` to load them.
- You can render native UI components using the 'render' action.
  Supported Components:
  - Containers: "Column" (vertical stack), "Row" (horizontal stack). Props: none.
  - Basic: "Text" (props: text), "Button" (props: label, signals: clicked).
  - Input: "TextInput" (props: placeholder, value, signals: textChanged).

【Language Policy】
You MUST respond in the same language as the user's input.
- If the user speaks Chinese, you speak Chinese.
- If the user speaks English, you speak English.
- This applies specifically to the 'content' field in 'say' and 'query' actions.

【Memory & Context】
${context}
${toolsContext}
${facts}
${longTaskGuidance}
${channelFileGuidance}

【Response Format】
You must respond with a JSON object strictly. Do not include markdown code blocks (like \`\`\`json).

【Action Selection Rules】
- Never repeat the same "say" content in consecutive turns.
- If there is no new progress, no new result, and no concrete next action, use "noop".
- After a "say" with continue intent, your next action should be concrete progress (tool_call/render/finish). If you cannot progress, use "noop".
- Use "say" only when you have new information for the user.
- For any file-writing task, do not attempt to write a long file in one shot.
- Always write files in multiple chunks across multiple tool calls when content is long.
- Start with initial content and then append remaining chunks step by step.
- For file paths and cwd, use absolute paths under Workspace unless user specifies otherwise.
- Directory responsibilities:
  - SkillsDir stores skill definitions and related skill resources.
  - MCPDir stores local MCP server configurations and MCP assets.
  - Workspace is the primary working area for reading/writing files, commands, and outputs.

Valid "action.type" values:
${validActionTypes.map(t => `- "${t}"`).join('\n')}

Format:
{
  "thought": "Your reasoning process here...",
  "action": {
    "type": "one of [${validActionTypes.join(', ')}]",
    ...
  }
}

Examples:

To speak to the user:
{
  "thought": "reasoning...",
  "action": { "type": "say", "content": "message to user", "continue": true }
}

To ask the user a question:
{
  "thought": "reasoning...",
  "action": { "type": "query", "content": "question to user" }
}

To explicitly finish current intent:
{
  "thought": "reasoning...",
  "action": { "type": "finish", "result": "task completed" }
}

To render a UI:
{
  "thought": "reasoning...",
  "action": {
    "type": "render",
    "surfaceId": "default",
    "tree": {
      "type": "Column",
      "children": [
        { "type": "Text", "props": { "text": "Hello" } },
        { "type": "Button", "props": { "label": "Click Me" }, "signals": { "clicked": "slot_id" } }
      ]
    }
  }
}${toolsContext && toolsContext.trim().length > 0 ? `

To use a tool:
{
  "thought": "reasoning...",
  "action": {
    "type": "tool_call",
    "function": {
      "name": "tool_name",
      "arguments": { ... }
    }
  }
}` : ''}

Or if no action is needed (waiting for user):
{
  "thought": "...",
  "action": { "type": "noop" }
}
`;
  }

  private composeUserPrompt(observations: Observation[]): string {
    if (observations.length === 0) return "No new observations.";
    
    return observations.map(obs => {
      if (obs.type === 'user_message') return `User: ${obs.text}`;
      if (obs.type === 'system_event') return `System Event: ${obs.name} ${JSON.stringify(obs.payload)}`;
      if (obs.type === 'action_result') return `Action Result: ${JSON.stringify(obs.result)}`;
      return JSON.stringify(obs);
    }).join("\n");
  }

  private parseResponse(content: string): { thought: string; action: any } {
    const normalizedContent = this.normalizeModelOutput(content);
    const directParsed = this.tryParseJson(normalizedContent);
    if (directParsed) {
      return this.normalizeParsedResponse(directParsed);
    }

    for (const candidate of this.extractJsonCandidates(normalizedContent)) {
      const parsed = this.tryParseJson(candidate);
      if (parsed) {
        return this.normalizeParsedResponse(parsed);
      }
    }

    const recoveredParsed = this.tryRecoverTruncatedJson(normalizedContent);
    if (recoveredParsed) {
      return this.normalizeParsedResponse(recoveredParsed);
    }

    console.error("Failed to parse response:", content);
    const fallbackContent = normalizedContent.trim();
    if (fallbackContent.length > 0) {
      return {
        thought: "Model returned non-JSON response, auto-correcting",
        action: this.createAutoCorrectionSayAction("response_parse_failed"),
      };
    }

    return {
      thought: "Failed to parse response, auto-correcting",
      action: this.createAutoCorrectionSayAction("response_parse_failed"),
    };
  }

  private normalizeModelOutput(content: string): string {
    return content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
  }

  private tryParseJson(content: string): any | null {
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private tryRecoverTruncatedJson(content: string): any | null {
    const firstBraceIndex = content.indexOf("{");
    if (firstBraceIndex < 0) return null;
    const candidate = content.slice(firstBraceIndex).trim();
    if (!candidate) return null;
    const repaired = this.repairPossiblyTruncatedJson(candidate);
    if (!repaired) return null;
    return this.tryParseJson(repaired);
  }

  private repairPossiblyTruncatedJson(content: string): string | null {
    let inString = false;
    let escaped = false;
    const stack: string[] = [];
    let output = "";

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      output += char;

      if (char === "\\" && inString) {
        escaped = !escaped;
        continue;
      }

      if (char === "\"" && !escaped) {
        inString = !inString;
      }
      escaped = false;

      if (inString) continue;

      if (char === "{") {
        stack.push("}");
        continue;
      }

      if (char === "[") {
        stack.push("]");
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = stack[stack.length - 1];
        if (expected !== char) {
          return null;
        }
        stack.pop();
      }
    }

    if (inString) {
      if (escaped) output += "\\";
      output += "\"";
    }

    while (stack.length > 0) {
      output += stack.pop();
    }

    return output;
  }

  private normalizeParsedResponse(parsed: any): { thought: string; action: any } {
    const hasThought = typeof parsed?.thought === "string" && parsed.thought.trim().length > 0;
    const thought = hasThought ? parsed.thought : "No thought provided";
    const action = typeof parsed?.action === "object" && parsed.action !== null
      ? parsed.action
      : { type: "noop" };
    if (!hasThought && action.type === "noop") {
      return {
        thought: "Missing thought in model response, auto-correcting",
        action: this.createAutoCorrectionSayAction("missing_thought"),
      };
    }
    return { thought, action };
  }

  private createAutoCorrectionSayAction(reason: string) {
    return {
      type: "say",
      content: "响应格式错误，正在自动纠正并重试。",
      continue: true,
      continueReason: reason,
    };
  }

  private extractJsonCandidates(content: string): string[] {
    const candidates: string[] = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (char === "\\" && inString) {
        escaped = !escaped;
        continue;
      }
      if (char === "\"" && !escaped) {
        inString = !inString;
      }
      escaped = false;
      if (inString) continue;
      if (char === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(content.slice(start, i + 1));
          start = -1;
        }
      }
    }

    return candidates.sort((a, b) => this.scoreJsonCandidate(b) - this.scoreJsonCandidate(a) || b.length - a.length);
  }

  private scoreJsonCandidate(candidate: string): number {
    let score = 0;
    if (candidate.includes("\"action\"")) score += 2;
    if (candidate.includes("\"thought\"")) score += 1;
    return score;
  }

  private shouldConvertRepeatedSayToNoop(action: any): boolean {
    if (!action || action.type !== "say") {
      this.lastSaySignature = null;
      this.repeatedSayCount = 0;
      return false;
    }

    const signature = this.normalizeSayContent(action.content);
    if (!signature) {
      this.lastSaySignature = null;
      this.repeatedSayCount = 0;
      return false;
    }

    if (this.lastSaySignature === signature) {
      this.repeatedSayCount += 1;
    } else {
      this.lastSaySignature = signature;
      this.repeatedSayCount = 1;
    }

    return this.repeatedSayCount >= AgentRuntime.MAX_REPEATED_SAY_COUNT;
  }

  private normalizeSayContent(content: unknown): string {
    if (typeof content !== "string") return "";
    return content.replace(/\s+/g, " ").trim();
  }

  private describeRuntimeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.includes("OPENAI_API_KEY missing") || raw.includes("401")) {
      return "LLM 未配置或密钥无效。请设置 OPENAI_API_KEY（或切换可用模型）后重试。";
    }
    return "Agent 暂时不可用，已记录错误日志。请稍后重试。";
  }

  private async publish(payload: any) {
    return this.bus.publish({
        ...payload,
        ...this.currentTraceContext
    });
  }

  private async dispatchToolCall(action: any, context: SystemToolContext): Promise<any> {
    if (this.currentTraceContext) {
        context.traceId = this.currentTraceContext.traceId;
        context.spanId = randomUUID(); // New span for tool call
    }

    const { name, arguments: args } = action.function;
    this.log(`Executing tool: ${name}`, args);
    
    // Resolve handles in args
    const resolvedArgs = this.resolveHandles(args);
    
    // Check System Tools first
    if (this.systemTools.has(name)) {
        try {
            return await this.systemTools.get(name)!.handler(resolvedArgs, context);
        } catch (e: any) {
             throw new Error(`System tool execution failed: ${e.message}`);
        }
    }

    if (!this.mcp) throw new Error("MCP not enabled and tool not found in system tools");
    
    return await this.mcp.callTool(name, resolvedArgs);
  }

  private resolveHandles(args: any): any {
    if (!this.vault) return args;

    const resolve = (obj: any): any => {
        if (typeof obj === 'string') {
            if (obj.startsWith('vault:')) {
                const val = this.vault!.resolve(obj);
                if (val !== undefined) return val;
            }
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(resolve);
        }
        if (typeof obj === 'object' && obj !== null) {
            const newObj: any = {};
            for (const key in obj) {
                newObj[key] = resolve(obj[key]);
            }
            return newObj;
        }
        return obj;
    };
    
    // Simple deep clone by JSON parse/stringify if needed, but the recursive function handles structure.
    // However, we should be careful not to mutate the original args if they are reused (which they shouldn't be).
    // Let's just clone first to be safe.
    const clone = JSON.parse(JSON.stringify(args));
    return resolve(clone);
  }
}
