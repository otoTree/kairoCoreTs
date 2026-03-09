import type { KairoEvent } from "../../events";
import type { Observation } from "../observation-bus";

export class ObservationMapper {
  constructor(private readonly agentId: string) {}

  map(event: KairoEvent): Observation | null {
    if (event.type.startsWith("kairo.legacy.")) {
      return event.data as Observation;
    }

    if (event.type === "kairo.user.message" || event.type === `kairo.agent.${this.agentId}.message`) {
      return {
        type: "user_message",
        text: (event.data as any).content,
        ts: new Date(event.time).getTime(),
      };
    }

    if (event.type === "kairo.tool.result") {
      return {
        type: "action_result",
        action: { type: "tool_call", function: { name: event.source.replace("tool:", "") } },
        result: (event.data as any).result || (event.data as any).error,
        ts: new Date(event.time).getTime(),
      };
    }

    if (event.type === "kairo.agent.internal.continue" || event.type.startsWith("kairo.system.")) {
      return {
        type: "system_event",
        name: event.type,
        payload: event.data,
        ts: new Date(event.time).getTime(),
      };
    }

    return null;
  }
}
