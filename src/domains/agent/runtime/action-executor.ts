import type { AgentAction, ToolCallAction } from "./action-types";

export interface ActionExecutorState {
  shouldAutoContinue: boolean;
  autoContinueReason: string;
  autoContinueStreak: number;
  lastSayContent?: string;
}

export interface ActionExecutorInput {
  thought: string;
  action: AgentAction;
  correlationId?: string;
  causationId?: string;
  state: ActionExecutorState;
}

export interface ActionExecutorOutput {
  state: ActionExecutorState;
  actionResult: unknown;
}

export interface ActionExecutorDeps {
  agentId: string;
  maxPendingActions: number;
  pendingActions: Set<string>;
  pendingCorrelations: Map<string, string>;
  onActionResult?: (result: { action: AgentAction; result: unknown }) => void;
  publish: (payload: Record<string, unknown>) => Promise<string | undefined>;
  dispatchToolCall: (action: ToolCallAction, context: { agentId: string; correlationId?: string; causationId?: string }) => Promise<unknown>;
  log: (message: string, data?: unknown) => void;
}

export class ActionExecutor {
  constructor(private readonly deps: ActionExecutorDeps) {}

  async execute(input: ActionExecutorInput): Promise<ActionExecutorOutput> {
    const state: ActionExecutorState = { ...input.state };
    let actionResult = null;

    if (input.action.type === "say") {
      state.lastSayContent = typeof input.action.content === "string" ? input.action.content : undefined;
      const actionEventId = await this.deps.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.deps.agentId,
        data: { action: input.action },
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      this.deps.publish({
        type: "kairo.agent.progress",
        source: "agent:" + this.deps.agentId,
        data: { message: input.action.content },
        correlationId: input.correlationId,
        causationId: actionEventId,
      });

      actionResult = "Progress reported to user";
      const explicitContinue = input.action.continue === true;
      const explicitStop = input.action.continue === false || input.action.final === true;
      const continueKeywords = ["然后", "接下来", "之后", "完成后", "安装后", "执行", "将", "then", "next", "after", "will"];
      const inferredContinue = !explicitStop && input.action.continue === undefined && continueKeywords.some(keyword => input.thought.includes(keyword));
      const shouldContinue = explicitContinue || inferredContinue;

      if (shouldContinue) {
        state.autoContinueStreak += 1;
        state.shouldAutoContinue = true;
        state.autoContinueReason = typeof input.action.continueReason === "string" && input.action.continueReason.trim().length > 0
          ? input.action.continueReason
          : "auto_continue_after_say";
        this.deps.log("Say action detected follow-up intent, will auto-continue");
      } else {
        state.autoContinueStreak = 0;
        state.autoContinueReason = "auto_continue_after_say";
        this.deps.publish({
          type: "kairo.intent.ended",
          source: "agent:" + this.deps.agentId,
          data: { result: actionResult },
          correlationId: input.correlationId,
          causationId: actionEventId,
        });
      }
      return { state, actionResult };
    }

    if (input.action.type === "query") {
      state.autoContinueStreak = 0;
      const actionEventId = await this.deps.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.deps.agentId,
        data: { action: input.action },
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      actionResult = "Waiting for user input";
      this.deps.publish({
        type: "kairo.intent.ended",
        source: "agent:" + this.deps.agentId,
        data: { result: actionResult },
        correlationId: input.correlationId,
        causationId: actionEventId,
      });
      return { state, actionResult };
    }

    if (input.action.type === "finish") {
      state.autoContinueStreak = 0;
      const actionEventId = await this.deps.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.deps.agentId,
        data: { action: input.action },
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      actionResult = input.action.result ?? "Completed";
      this.deps.publish({
        type: "kairo.intent.ended",
        source: "agent:" + this.deps.agentId,
        data: { result: actionResult },
        correlationId: input.correlationId,
        causationId: actionEventId,
      });
      return { state, actionResult };
    }

    if (input.action.type === "render") {
      state.autoContinueStreak = 0;
      const actionEventId = await this.deps.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.deps.agentId,
        data: { action: input.action },
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      await this.deps.publish({
        type: "kairo.agent.render.commit",
        source: "agent:" + this.deps.agentId,
        data: {
          surfaceId: input.action.surfaceId || "default",
          tree: input.action.tree,
        },
        correlationId: input.correlationId,
        causationId: actionEventId,
      });
      actionResult = "UI Rendered";
      this.deps.publish({
        type: "kairo.intent.ended",
        source: "agent:" + this.deps.agentId,
        data: { result: actionResult },
        correlationId: input.correlationId,
        causationId: actionEventId,
      });
      return { state, actionResult };
    }

    if (input.action.type === "tool_call") {
      state.autoContinueStreak = 0;
      const toolAction = input.action as ToolCallAction;
      const toolName = toolAction.function?.name;
      if (typeof toolName !== "string" || toolName.length === 0) {
        const errorMsg = "Invalid tool_call action: missing function name";
        console.error("[AgentRuntime]", errorMsg, input.action);
        this.deps.publish({
          type: "kairo.tool.result",
          source: "system",
          data: { error: errorMsg },
          causationId: input.causationId,
          correlationId: input.correlationId,
        });
        this.deps.publish({
          type: "kairo.intent.ended",
          source: "agent:" + this.deps.agentId,
          data: { error: errorMsg },
          correlationId: input.correlationId,
          causationId: input.causationId,
        });
        return { state, actionResult };
      }

      const actionEventId = await this.deps.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.deps.agentId,
        data: { action: input.action },
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      if (actionEventId) {
        this.deps.pendingActions.add(actionEventId);
        if (input.correlationId) {
          this.deps.pendingCorrelations.set(actionEventId, input.correlationId);
        }
      }
      if (this.deps.pendingActions.size > this.deps.maxPendingActions) {
        const oldest = this.deps.pendingActions.values().next().value;
        if (oldest) {
          this.deps.pendingActions.delete(oldest);
          this.deps.pendingCorrelations.delete(oldest);
        }
      }

      try {
        actionResult = await this.deps.dispatchToolCall(toolAction, {
          agentId: this.deps.agentId,
          correlationId: input.correlationId,
          causationId: actionEventId,
        });
        if (this.deps.onActionResult) {
          this.deps.onActionResult({
            action: input.action,
            result: actionResult,
          });
        }
        this.deps.publish({
          type: "kairo.tool.result",
          source: "tool:" + toolName,
          data: { result: actionResult },
          causationId: actionEventId,
          correlationId: input.correlationId,
        });
        this.deps.publish({
          type: "kairo.intent.ended",
          source: "agent:" + this.deps.agentId,
          data: { result: actionResult },
          correlationId: input.correlationId,
          causationId: actionEventId,
        });
      } catch (error: unknown) {
        const errorMessage = this.getErrorMessage(error);
        actionResult = `Tool call failed: ${errorMessage}`;
        this.deps.publish({
          type: "kairo.tool.result",
          source: "tool:" + toolName,
          data: { error: errorMessage },
          causationId: actionEventId,
          correlationId: input.correlationId,
        });
        this.deps.publish({
          type: "kairo.intent.ended",
          source: "agent:" + this.deps.agentId,
          data: { error: errorMessage },
          correlationId: input.correlationId,
          causationId: actionEventId,
        });
      }
      return { state, actionResult };
    }

    state.autoContinueStreak = 0;
    actionResult = "No action needed";
    this.deps.publish({
      type: "kairo.intent.ended",
      source: "agent:" + this.deps.agentId,
      data: { result: actionResult },
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
    return { state, actionResult };
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return String(error);
  }
}
