import type { EventBus, KairoEvent } from "../../events";

export async function bridgeLegacyEventToDefaultAgent(globalBus: EventBus, event: KairoEvent) {
  const type = event.type.replace("kairo.legacy.", "");
  if (type === "user_message") {
    await globalBus.publish({
      type: "kairo.agent.default.message",
      source: "orchestrator",
      data: { content: (event.data as { text?: string }).text },
    });
    return;
  }
  if (type === "system_event") {
    const payload = event.data as { name?: string; payload?: unknown };
    await globalBus.publish({
      type: "kairo.agent.default.message",
      source: "orchestrator",
      data: { content: `[System Event] ${payload.name}: ${JSON.stringify(payload.payload)}` },
    });
  }
}
