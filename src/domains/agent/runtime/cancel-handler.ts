import type { CancelEventData, KairoEvent } from "../../events";

export interface CancelHandlerDeps {
  agentId: string;
  pendingActions: Set<string>;
  pendingCorrelations: Map<string, string>;
  log: (message: string) => void;
  publish: (payload: any) => Promise<string | undefined>;
}

export class CancelHandler {
  constructor(private readonly deps: CancelHandlerDeps) {}

  handle(event: KairoEvent) {
    const data = event.data as CancelEventData;
    if (!data?.targetCorrelationId) return;

    for (const [actionId, correlationId] of this.deps.pendingCorrelations) {
      if (correlationId === data.targetCorrelationId) {
        this.deps.pendingActions.delete(actionId);
        this.deps.pendingCorrelations.delete(actionId);
        this.deps.log(`取消动作 ${actionId}，原因: ${data.reason || "用户取消"}`);
        this.deps.publish({
          type: "kairo.intent.cancelled",
          source: "agent:" + this.deps.agentId,
          data: { actionId, reason: data.reason },
          correlationId: data.targetCorrelationId,
          causationId: event.id,
        });
        break;
      }
    }
  }
}
