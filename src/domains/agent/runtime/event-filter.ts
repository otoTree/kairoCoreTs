import type { KairoEvent } from "../../events";

export interface EventFilterDeps {
  agentId: string;
  pendingActions: Set<string>;
  pendingCorrelations: Map<string, string>;
}

export class EventFilter {
  constructor(private readonly deps: EventFilterDeps) {}

  accept(event: KairoEvent): boolean {
    if (event.type === "kairo.tool.result") {
      if (!event.causationId || !this.deps.pendingActions.has(event.causationId)) {
        return false;
      }
      this.deps.pendingActions.delete(event.causationId);
      this.deps.pendingCorrelations.delete(event.causationId);
    }

    if (event.type === "kairo.user.message") {
      const target = (event.data as any).targetAgentId;
      if (target && target !== this.deps.agentId) {
        return false;
      }
    }

    return true;
  }
}
