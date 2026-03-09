import type { AIPlugin } from "../../ai/ai.plugin";
import type { EventBus, KairoEvent } from "../../events";
import type { AgentMemory } from "../memory";

export interface AgentRouterOptions {
  ai: AIPlugin;
  bus: EventBus;
  memory: AgentMemory;
  hasAgent: (id: string) => boolean;
  spawnAgent: (id: string) => void;
  hasDefaultAgent: () => boolean;
}

export class AgentRouter {
  constructor(private readonly options: AgentRouterOptions) {}

  async handleUserMessage(event: KairoEvent) {
    const payload = (event.data || {}) as { content?: string; targetAgentId?: string };
    const content = payload.content;
    const target = payload.targetAgentId;
    if (typeof content !== "string") {
      return;
    }

    if (target) {
      if (!this.options.hasAgent(target)) {
        this.options.spawnAgent(target);
      }
      await this.options.bus.publish({
        type: `kairo.agent.${target}.message`,
        source: "orchestrator",
        data: { content },
      });
      return;
    }

    if (!this.options.hasDefaultAgent()) {
      return;
    }

    try {
      const context = this.options.memory.getContext();
      const recentContext = context.slice(-1000);
      const prompt = `You are a Router.
Current Conversation Context:
${recentContext}

New User Message: "${content}"

Is this message relevant to the current conversation?
Or is it a completely new, unrelated topic?
If it is unrelated, we should spawn a new agent.

Reply JSON: { "relevant": boolean }`;

      const response = await this.options.ai.chat([{ role: "user", content: prompt }]);
      let relevant = true;
      try {
        const json = JSON.parse(response.content.replace(/```json/g, "").replace(/```/g, "").trim()) as {
          relevant?: boolean;
        };
        relevant = json.relevant !== false;
      } catch (error) {
        console.warn("[Orchestrator] Failed to parse routing decision, defaulting to relevant.", error);
      }

      if (relevant) {
        await this.options.bus.publish({
          type: "kairo.agent.default.message",
          source: "orchestrator",
          data: { content },
        });
        return;
      }

      const newId = crypto.randomUUID();
      console.log(`[Orchestrator] Spawning new agent ${newId} for unrelated task.`);
      this.options.spawnAgent(newId);
      await this.options.bus.publish({
        type: `kairo.agent.${newId}.message`,
        source: "orchestrator",
        data: { content },
      });
    } catch (error) {
      console.error("[Orchestrator] Routing error:", error);
      await this.options.bus.publish({
        type: "kairo.agent.default.message",
        source: "orchestrator",
        data: { content },
      });
    }
  }
}
