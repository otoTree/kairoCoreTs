import type { Context } from "hono";
import type { KairoEvent } from "../events/types";

export type ChannelInboundPublishInput = {
  channel: string;
  source: string;
  targetAgentId: string;
  sessionId: string;
  messageId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
};

export type ChannelPublishToAgent = (input: ChannelInboundPublishInput) => Promise<string>;
export type ChannelRouteRegistrar = (path: string, handler: (c: Context) => Response | Promise<Response>) => void;

export interface ChannelAdapter {
  readonly name: string;
  registerRoutes(registerPost: ChannelRouteRegistrar, publishToAgent: ChannelPublishToAgent): void;
  handleAgentAction?(event: KairoEvent): Promise<void> | void;
}
