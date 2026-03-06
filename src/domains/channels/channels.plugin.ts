import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import { ServerPlugin } from "../server/server.plugin";
import { AgentPlugin } from "../agent/agent.plugin";
import type { ChannelAdapter, ChannelInboundPublishInput } from "./types";
import { FeishuChannelAdapter } from "./adapters/feishu.adapter";

export class ChannelsPlugin implements Plugin {
  readonly name = "channels";
  private app?: Application;
  private server?: ServerPlugin;
  private agent?: AgentPlugin;
  private adapters: ChannelAdapter[] = [];
  private eventUnsub?: () => void;
  private routesRegistered = false;

  constructor() {
    this.adapters = this.createAdapters();
  }

  setup(app: Application) {
    this.app = app;
    app.registerService("channels", this);
    this.bindServerAndRegisterRoutes();
  }

  start() {
    if (!this.app) return;
    this.bindServerAndRegisterRoutes();
    this.bindAgent();
    if (!this.agent || this.eventUnsub) return;
    this.eventUnsub = this.agent.globalBus.subscribe("kairo.>", (event) => {
      for (const adapter of this.adapters) {
        if (!adapter.handleEvent) continue;
        void Promise.resolve(adapter.handleEvent(event)).catch((error) => {
          console.error(`[Channels] Adapter ${adapter.name} handleEvent failed`, error);
        });
      }
    });
  }

  stop() {
    if (this.eventUnsub) {
      this.eventUnsub();
      this.eventUnsub = undefined;
    }
  }

  private bindServerAndRegisterRoutes() {
    if (!this.app) return;
    if (!this.server) {
      try {
        this.server = this.app.getService<ServerPlugin>("server");
      } catch (e) {
        return;
      }
    }
    if (this.routesRegistered || !this.server) return;

    for (const adapter of this.adapters) {
      adapter.registerRoutes(
        (path, handler) => this.server!.registerPost(path, handler),
        this.publishChannelMessage.bind(this),
      );
    }
    this.routesRegistered = true;
  }

  private bindAgent() {
    if (!this.app || this.agent) return;
    try {
      this.agent = this.app.getService<AgentPlugin>("agent");
    } catch (e) {
      return;
    }
  }

  private createAdapters(): ChannelAdapter[] {
    const adapters: ChannelAdapter[] = [];
    const feishu = FeishuChannelAdapter.fromEnv();
    if (feishu) adapters.push(feishu);
    return adapters;
  }

  private async publishChannelMessage(input: ChannelInboundPublishInput): Promise<string> {
    this.bindAgent();
    if (!this.agent) {
      throw new Error("agent unavailable");
    }
    return this.agent.globalBus.publish({
      type: `kairo.agent.${input.targetAgentId}.message`,
      source: input.source,
      data: {
        content: input.text,
        channel: input.channel,
        sessionId: input.sessionId,
        messageId: input.messageId,
        senderId: input.senderId,
        senderName: input.senderName,
        attachments: input.attachments,
        metadata: input.metadata,
      },
    });
  }
}
