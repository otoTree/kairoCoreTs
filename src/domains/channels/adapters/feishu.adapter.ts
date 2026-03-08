import type { Context } from "hono";
import type { KairoEvent } from "../../events/types";
import type {
  ChannelAdapter,
  ChannelAgentToolRegistrar,
  ChannelPublishToAgent,
  ChannelRouteRegistrar,
} from "../types";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import { createDecipheriv, randomUUID } from "node:crypto";

type FeishuApiPayload = { code?: number; msg?: string; [key: string]: any };
type AgentAction = { type: string; content: string };
type FeishuRequestError = Error & { retryable?: boolean };
type FeishuReceiveIdType = "chat_id" | "user_id" | "email" | "open_id";
type FeishuMessageType =
  | "text"
  | "post"
  | "image"
  | "file"
  | "audio"
  | "media"
  | "sticker"
  | "interactive";

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly name = "feishu";
  private static readonly CONTEXT_MAX = 1000;
  private static readonly SUPPORTED_MESSAGE_EVENT_TYPES = new Set([
    "im.message.receive_v1",
    "im.message.group_at_msg.receive_v1",
    "message",
  ]);
  private static readonly SUPPORTED_ACCESS_EVENT_TYPES = new Set([
    "im.chat.access_event.bot_p2p_chat_entered_v1",
    "p2p_chat_create",
  ]);
  private static readonly SEND_RETRY_MAX = 4;
  private static readonly SEND_RETRY_BASE_DELAY_MS = 350;
  private static readonly SEND_MIN_INTERVAL_MS = 250;
  private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
  private publishToAgent?: ChannelPublishToAgent;
  private tenantAccessToken?: string;
  private tenantTokenExpireAt = 0;
  private tenantTokenPromise?: Promise<string>;
  private pendingChats = new Map<string, string>();
  private activeChatId?: string;
  private outboundSendQueue = new Map<string, Promise<void>>();
  private lastSendAt = 0;

  constructor(
    private readonly webhookPath: string,
    private readonly defaultAgentId: string,
    private readonly inboxDir: string,
    private readonly maxUploadBytes: number,
    private readonly appId?: string,
    private readonly appSecret?: string,
    private readonly verificationToken?: string,
    private readonly encryptKey?: string,
    private readonly fixedPrivateChatId?: string,
  ) {}

  static fromEnv(): FeishuChannelAdapter | null {
    const appId = process.env.KAIRO_FEISHU_APP_ID;
    const appSecret = process.env.KAIRO_FEISHU_APP_SECRET;
    const enabled = process.env.KAIRO_FEISHU_ENABLED === "true" || !!(appId && appSecret);
    if (!enabled) return null;

    const webhookPath = process.env.KAIRO_FEISHU_WEBHOOK_PATH || "/api/channels/feishu/webhook";
    const defaultAgentId = process.env.KAIRO_FEISHU_AGENT_ID || "default";
    const inboxDir = process.env.KAIRO_FEISHU_INBOX_DIR || join(process.cwd(), "workspace", "feishu-inbox");
    const maxUploadBytes = Number(process.env.KAIRO_FEISHU_MAX_UPLOAD_BYTES || 30 * 1024 * 1024);
    const verificationToken = process.env.KAIRO_FEISHU_VERIFICATION_TOKEN;
    const encryptKey = process.env.KAIRO_FEISHU_ENCRYPT_KEY;
    const fixedPrivateChatId = process.env.KAIRO_FEISHU_FIXED_CHAT_ID?.trim() || undefined;
    console.log("[Channel:feishu] Adapter enabled", {
      webhookPath,
      defaultAgentId,
      hasAppId: !!appId,
      hasAppSecret: !!appSecret,
      hasVerificationToken: !!verificationToken,
      hasEncryptKey: !!encryptKey,
      fixedPrivateChatId: fixedPrivateChatId || null,
      inboxDir,
      maxUploadBytes,
    });
    return new FeishuChannelAdapter(
      webhookPath,
      defaultAgentId,
      inboxDir,
      maxUploadBytes,
      appId,
      appSecret,
      verificationToken,
      encryptKey,
      fixedPrivateChatId,
    );
  }

  registerRoutes(registerPost: ChannelRouteRegistrar, publishToAgent: ChannelPublishToAgent): void {
    this.publishToAgent = publishToAgent;
    console.log("[Channel:feishu] Registering webhook route", { path: this.webhookPath });
    registerPost(this.webhookPath, async (c) => this.handleWebhook(c));
  }

  registerAgentTools(registerTool: ChannelAgentToolRegistrar): void {
    if (!this.appId || !this.appSecret) {
      console.warn("[Channel:feishu] Skip registering file tool: app credentials missing");
      return;
    }
    registerTool(
      {
        name: "kairo_feishu_send_file",
        description: "发送本地文件到飞书会话。默认使用当前会话上下文。",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "要发送的本地文件路径" },
          },
          required: ["filePath"],
        },
      },
      async (args: any, context: any) => {
        const rawFilePath = typeof args?.filePath === "string" ? args.filePath.trim() : "";
        if (!rawFilePath) {
          throw new Error("filePath is required");
        }
        if (typeof args?.chatId === "string" && args.chatId.trim()) {
          throw new Error("chatId is not allowed");
        }
        const filePath = rawFilePath.startsWith("/") ? rawFilePath : resolvePath(process.cwd(), rawFilePath);
        const chatId = this.resolveToolChatId(
          typeof context?.correlationId === "string" ? context.correlationId : undefined,
        );
        if (!chatId) {
          throw new Error("missing chat context");
        }
        await this.enqueueSendTask(chatId, async () => {
          await this.sendFileMessage(chatId, filePath);
        });
        if (typeof context?.correlationId === "string" && context.correlationId) {
          this.rememberContext(context.correlationId, chatId);
        }
        return { ok: true, chatId, filePath };
      },
    );
  }

  async handleEvent(event: KairoEvent): Promise<void> {
    const correlationId = event.correlationId;
    if (!correlationId) return;
    const mappedChatId = this.pendingChats.get(correlationId);
    const chatId = mappedChatId || this.activeChatId;
    if (!chatId) {
      console.warn("[Channel:feishu] Missing context for outbound event", {
        correlationId,
        eventType: event.type,
      });
      return;
    }
    if (!mappedChatId) {
      console.warn("[Channel:feishu] Using active chat fallback for outbound event", {
        correlationId,
        eventType: event.type,
        chatId,
      });
      this.pendingChats.set(correlationId, chatId);
    }
    if (event.source === "client:feishu") {
      return;
    }
    try {
      const actionContent = this.extractActionText(event);
      if (!this.shouldForwardEvent(event)) return;
      await this.enqueueSendTask(chatId, async () => {
        if (actionContent) {
          await this.sendMarkdownCardMessage(chatId, actionContent);
        } else {
          await this.sendEventMessage(chatId, event);
        }
        this.pendingChats.set(correlationId, chatId);
      });
    } catch (e) {
      console.error("[Channel:feishu] Failed to send event:", {
        correlationId,
        eventType: event.type,
        chatId,
        error: e,
      });
    }
  }

  private async handleWebhook(c: Context) {
    if (!this.publishToAgent) {
      return c.json({ code: 1, msg: "channel unavailable" }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: 1, msg: "invalid payload" }, 400);
    }

    if (body?.type === "url_verification" && body?.challenge) {
      if (this.verificationToken && body.token !== this.verificationToken) {
        return c.json({ code: 1, msg: "invalid token" }, 401);
      }
      return c.json({ challenge: body.challenge });
    }

    if (body?.encrypt) {
      try {
        body = this.decryptEncryptedBody(body.encrypt);
      } catch (e) {
        console.error("[Channel:feishu] Failed to decrypt payload", e);
        return c.json({ code: 1, msg: "invalid encrypted payload" }, 400);
      }
    }

    if (body?.type === "url_verification" && body?.challenge) {
      if (this.verificationToken && body.token !== this.verificationToken) {
        return c.json({ code: 1, msg: "invalid token" }, 401);
      }
      return c.json({ challenge: body.challenge });
    }

    const eventType = body?.header?.event_type || body?.event?.type;
    const isSchemaV2 = body?.schema === "2.0";
    const isLegacyEvent = body?.type === "event_callback" && typeof body?.event === "object";
    if (!isSchemaV2 && !isLegacyEvent) {
      console.log("[Channel:feishu] Ignored event", {
        schema: body?.schema,
        type: body?.type,
        eventType,
      });
      return c.json({ code: 0, msg: "ignored" });
    }

    const requestToken = body?.header?.token || body?.token;
    if (this.verificationToken && requestToken && requestToken !== this.verificationToken) {
      return c.json({ code: 1, msg: "invalid token" }, 401);
    }

    const event = body.event || {};
    const message = event.message || {};
    const sender = event.sender || {};
    const rawChatId = message.chat_id || event?.chat_id || event?.open_chat_id || event?.chat?.chat_id;
    const resolvedChatId = this.resolveChatId(rawChatId);
    const messageId = message.message_id;
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id;
    const senderName = sender.sender_id?.user_id || senderId;
    if (this.fixedPrivateChatId && rawChatId && rawChatId !== this.fixedPrivateChatId) {
      console.warn("[Channel:feishu] fixed chat id override is active", {
        rawChatId,
        fixedPrivateChatId: this.fixedPrivateChatId,
      });
    }

    console.log("[Channel:feishu] Webhook event received", {
      eventType,
      schema: body?.schema,
      type: body?.type,
      rawChatId: rawChatId || null,
      resolvedChatId: resolvedChatId || null,
      messageId: messageId || null,
      senderId: senderId || null,
      senderName: senderName || null,
    });

    if (FeishuChannelAdapter.SUPPORTED_ACCESS_EVENT_TYPES.has(eventType)) {
      await this.handleAccessEvent(body.event || {}, eventType);
      return c.json({ code: 0, msg: "ok" });
    }

    if (!FeishuChannelAdapter.SUPPORTED_MESSAGE_EVENT_TYPES.has(eventType)) {
      console.log("[Channel:feishu] Ignored event (unsupported type)", {
        schema: body?.schema,
        eventType,
        rawChatId: rawChatId || null,
        resolvedChatId: resolvedChatId || null,
        messageId: messageId || null,
        senderId: senderId || null,
      });
      return c.json({ code: 0, msg: "ignored" });
    }

    const senderType = sender.sender_type || sender.sender_id?.sender_type;
    if (senderType === "bot") {
      console.log("[Channel:feishu] Ignored event (bot sender)", {
        eventType,
        rawChatId: rawChatId || null,
        resolvedChatId: resolvedChatId || null,
        messageId: messageId || null,
        senderId: senderId || null,
      });
      return c.json({ code: 0, msg: "ignored bot message" });
    }

    const chatId = resolvedChatId;
    if (!chatId || !messageId) {
      console.warn("[Channel:feishu] Missing message metadata", {
        eventType,
        rawChatId: rawChatId || null,
        resolvedChatId: resolvedChatId || null,
        messageId: messageId || null,
        senderId: senderId || null,
      });
      return c.json({ code: 1, msg: "missing message metadata" }, 400);
    }

    const normalized = await this.normalizeMessage(event);
    const content = this.buildPrompt(event, normalized.text, normalized.attachments);

    const correlationId = await this.publishToAgent({
      channel: this.name,
      source: "client:feishu",
      targetAgentId: this.defaultAgentId,
      sessionId: chatId,
      messageId,
      senderId,
      senderName,
      text: content,
      attachments: normalized.attachments,
      metadata: {
        chatId,
        messageType: message.message_type,
      },
    });

    console.log("[Channel:feishu] Message published to agent", {
      correlationId,
      eventType,
      chatId,
      messageId,
    });
    this.rememberContext(correlationId, chatId);
    return c.json({ code: 0, msg: "ok" });
  }

  private async handleAccessEvent(event: any, eventType: string) {
    if (!this.publishToAgent) return;
    const chatId = this.resolveChatId(event?.chat?.chat_id || event?.chat_id || event?.open_chat_id);
    if (!chatId) {
      console.warn("[Channel:feishu] Access event missing chat id", { eventType });
      return;
    }
    const senderId = event?.operator_id?.open_id || event?.operator_id?.user_id || event?.operator_id?.union_id;
    const senderName = event?.operator_id?.user_id || senderId;
    const messageId = `access_${eventType}_${Date.now()}`;
    const contentLines = [
      "来自飞书机器人渠道的用户事件：",
      `事件类型: ${eventType}`,
      "用户进入了与机器人的私聊会话。",
      `会话: ${chatId}`,
    ];
    if (senderName) {
      contentLines.push(`发送者: ${senderName}`);
    }

    const correlationId = await this.publishToAgent({
      channel: this.name,
      source: "client:feishu",
      targetAgentId: this.defaultAgentId,
      sessionId: chatId,
      messageId,
      senderId,
      senderName,
      text: contentLines.join("\n"),
      metadata: {
        chatId,
        eventType,
        accessEvent: true,
      },
    });

    console.log("[Channel:feishu] Access event published to agent", {
      correlationId,
      eventType,
      chatId,
      messageId,
    });
    this.rememberContext(correlationId, chatId);
  }

  private decryptEncryptedBody(encrypt: string) {
    if (!this.encryptKey) {
      throw new Error("feishu encrypt key is not configured");
    }
    const aesKey = Buffer.from(`${this.encryptKey}=`, "base64");
    if (aesKey.length !== 32) {
      throw new Error("feishu encrypt key is invalid");
    }
    const iv = aesKey.subarray(0, 16);
    const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
    let decrypted = decipher.update(encrypt, "base64", "utf8");
    decrypted += decipher.final("utf8");
    const parsed = JSON.parse(decrypted);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("decrypted payload is not an object");
    }
    return parsed;
  }

  private async normalizeMessage(event: any): Promise<{ text: string; attachments: string[] }> {
    const message = event.message || {};
    const messageType = message.message_type;
    const messageId = message.message_id;
    const rawContent = message.content || "{}";
    const parsed = this.safeJsonParse(rawContent);
    const text = this.extractMessageText(messageType, parsed);
    const attachments: string[] = [];

    const resource = this.extractResourceSpec(messageType, parsed);
    if (resource && messageId) {
      try {
        const saved = await this.downloadResource(messageId, resource.key, resource.type, resource.name);
        attachments.push(saved);
      } catch (e) {
        console.error("[Channel:feishu] Failed to download resource:", e);
      }
    }

    return { text: text.trim(), attachments };
  }

  private extractMessageText(messageType: string, parsed: any): string {
    if (messageType === "post") {
      return this.extractPostText(parsed);
    }
    return typeof parsed?.text === "string" ? parsed.text : "";
  }

  private buildPrompt(event: any, text: string, attachments: string[]) {
    const sender = event.sender || {};
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || "unknown";
    const senderName = sender.sender_id?.user_id || senderId;
    const message = event.message || {};
    const lines: string[] = [
      "来自飞书机器人渠道的用户消息：",
      `发送者: ${senderName}`,
      `会话: ${message.chat_id || "unknown"}`,
      `消息类型: ${message.message_type || "unknown"}`,
    ];
    if (text) {
      lines.push("文本内容：");
      lines.push(text);
    }
    if (attachments.length > 0) {
      lines.push("附件文件路径：");
      for (const item of attachments) {
        lines.push(`- ${item}`);
      }
      lines.push("请在回答中直接基于这些本地文件路径处理文件。");
    }
    return lines.join("\n");
  }

  private extractPostText(parsed: any): string {
    const lines: string[] = [];
    if (!parsed || typeof parsed !== "object") return "";
    const locales = Object.values(parsed) as any[];
    for (const locale of locales) {
      const content = locale?.content;
      if (!Array.isArray(content)) continue;
      for (const row of content) {
        if (!Array.isArray(row)) continue;
        for (const part of row) {
          if (typeof part?.text === "string") lines.push(part.text);
        }
      }
    }
    return lines.join("\n");
  }

  private extractResourceSpec(messageType: string, content: any): { key: string; type: string; name: string } | null {
    if (messageType === "file" && typeof content?.file_key === "string") {
      return { key: content.file_key, type: "file", name: content.file_name || "file" };
    }
    if (messageType === "image" && typeof content?.image_key === "string") {
      return { key: content.image_key, type: "image", name: content.image_name || "image" };
    }
    if (messageType === "audio" && typeof content?.file_key === "string") {
      return { key: content.file_key, type: "audio", name: content.file_name || "audio" };
    }
    if (messageType === "media" && typeof content?.file_key === "string") {
      return { key: content.file_key, type: "media", name: content.file_name || "media" };
    }
    if (messageType === "video" && typeof content?.file_key === "string") {
      return { key: content.file_key, type: "video", name: content.file_name || "video" };
    }
    return null;
  }

  private rememberContext(correlationId: string, chatId: string) {
    if (this.pendingChats.size >= FeishuChannelAdapter.CONTEXT_MAX) {
      const first = this.pendingChats.keys().next().value;
      if (first) this.pendingChats.delete(first);
    }
    this.pendingChats.set(correlationId, chatId);
    this.activeChatId = chatId;
  }

  private async downloadResource(messageId: string, resourceKey: string, resourceType: string, fileName: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${encodeURIComponent(resourceType)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const safeName = this.safeFileName(fileName || `${resourceKey}.bin`);
    const targetDir = join(this.inboxDir, new Date().toISOString().slice(0, 10));
    await mkdir(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${messageId}-${safeName}`);
    await writeFile(targetPath, bytes);
    return targetPath;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (
      this.tenantAccessToken &&
      now < this.tenantTokenExpireAt - FeishuChannelAdapter.TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.tenantAccessToken;
    }
    if (this.tenantTokenPromise) {
      return this.tenantTokenPromise;
    }
    if (!this.appId || !this.appSecret) {
      throw new Error("feishu app credentials are not configured");
    }
    this.tenantTokenPromise = (async () => {
      const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      });
      const payload = await this.readJsonPayload(response);
      this.ensureFeishuSuccess("tenant token", response, payload);
      const token = payload.tenant_access_token;
      if (typeof token !== "string" || !token) {
        throw new Error("tenant token failed: invalid token");
      }
      this.tenantAccessToken = token;
      this.tenantTokenExpireAt = Date.now() + Number(payload.expire || 7200) * 1000;
      return token;
    })();
    try {
      return await this.tenantTokenPromise;
    } finally {
      this.tenantTokenPromise = undefined;
    }
  }

  private async sendEventMessage(chatId: string, event: KairoEvent) {
    const thoughtMessage = this.extractThoughtEventMessage(event);
    if (thoughtMessage) {
      await this.sendMarkdownCardMessage(chatId, this.wrapThoughtMessage(thoughtMessage));
      return;
    }
    const post = this.buildEventPost(event);
    await this.sendPostMessage(chatId, post.lines);
  }

  private buildEventPost(event: KairoEvent): {  lines: string[] } {
    const lines: string[] = [];
    const payloadLines = this.summarizeEventPayload(event);
    if (payloadLines.length > 0) {
      lines.push(...payloadLines);
    }
    return {
      lines,
    };
  }

  private summarizeEventPayload(event: KairoEvent): string[] {
    const data = event.data as any;
    if (event.type === "kairo.agent.thought") {
      const thought = this.extractThoughtOrMessageText(data?.thought) || (typeof data?.thought === "string" ? data.thought.trim() : "");
      if (!thought) return [];
      return ["思考", ...this.toReadableLines(thought, 1200).map((line) => `  ${line}`)];
    }
    if (event.type === "kairo.agent.action") {
      const action = this.getSayOrQueryAction(event);
      if (!action) return [];
      const lines = [`动作 · ${action.type}`];
      const extracted = this.extractThoughtOrMessageText(action.content);
      const displayText = extracted || action.content;
      lines.push("内容");
      lines.push(...this.toReadableLines(displayText, 1200).map((line) => `  ${line}`));
      return lines;
    }

    if (event.type.startsWith("kairo.agent.") && event.type.endsWith(".message")) {
      const text = typeof data?.content === "string" ? data.content : "";
      if (!text) return [];
      const extracted = this.extractThoughtOrMessageText(text);
      const displayText = extracted || text;
      return [...this.toReadableLines(displayText, 1200).map((line) => `  ${line}`)];
    }
    return [];
  }

  private shouldForwardEvent(event: KairoEvent): boolean {
    if (event.type === "kairo.agent.action") {
      if (this.getSayOrQueryAction(event)) return true;
      return !!this.extractActionText(event);
    }
    return event.type !== "kairo.intent.started" && event.type !== "kairo.intent.ended";
  }

  private extractActionText(event: KairoEvent): string {
    const action = this.getAction(event);
    if (!action) return "";
    if (action.type === "say" || action.type === "query") {
      const extracted = this.extractThoughtOrMessageText(action.content);
      return extracted || action.content.trim();
    }
    return this.extractThoughtText(action.content);
  }

  private getAction(event: KairoEvent): AgentAction | null {
    if (event.type !== "kairo.agent.action") return null;
    const action = (event.data as any)?.action;
    if (!action) return null;
    if (typeof action.type !== "string" || !action.type) return null;
    if (typeof action.content !== "string") return null;
    return { type: action.type, content: action.content };
  }

  private getSayOrQueryAction(event: KairoEvent): AgentAction | null {
    const action = this.getAction(event);
    if (!action) return null;
    if (action.type !== "say" && action.type !== "query") return null;
    return { type: action.type, content: action.content };
  }

  private extractThoughtText(input: string): string {
    const text = input.trim();
    if (!text) return "";
    const fromWhole = this.pickThought(this.safeJsonParse(text));
    if (fromWhole) return fromWhole;
    const fragments = text.match(/\{[\s\S]*?\}/g) || [];
    for (const fragment of fragments) {
      const extracted = this.pickThought(this.safeJsonParse(fragment));
      if (extracted) return extracted;
    }
    return "";
  }

  private extractThoughtOrMessageText(input: string): string {
    const text = input.trim();
    if (!text) return "";
    const fromWhole = this.pickThoughtOrMessage(this.safeJsonParse(text));
    if (fromWhole) return fromWhole;
    const fragments = text.match(/\{[\s\S]*?\}/g) || [];
    for (const fragment of fragments) {
      const extracted = this.pickThoughtOrMessage(this.safeJsonParse(fragment));
      if (extracted) return extracted;
    }
    return "";
  }

  private pickThoughtOrMessage(value: any): string {
    if (!value || typeof value !== "object") return "";
    if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
    if (typeof value.thought === "string" && value.thought.trim()) return value.thought.trim();
    return "";
  }

  private pickThought(value: any): string {
    if (!value || typeof value !== "object") return "";
    if (typeof value.thought === "string" && value.thought.trim()) return value.thought.trim();
    return "";
  }

  private toReadableLines(input: string, maxLength: number): string[] {
    const normalized = this.normalizeDisplayText(input);
    if (!normalized) return [];
    const lines: string[] = [];
    for (const block of normalized.split("\n")) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      if (trimmed.length <= maxLength) {
        lines.push(trimmed);
        continue;
      }
      for (let i = 0; i < trimmed.length; i += maxLength) {
        lines.push(trimmed.slice(i, i + maxLength));
      }
    }
    return lines;
  }

  private extractThoughtEventMessage(event: KairoEvent): string {
    if (event.type !== "kairo.agent.thought") return "";
    const rawThought = (event.data as any)?.thought;
    if (typeof rawThought === "string") {
      const extracted = this.extractThoughtOrMessageText(rawThought);
      return extracted || rawThought.trim();
    }
    return this.pickThought(rawThought);
  }

  private wrapMarkdownMessage(input: string): string {
    const normalized = this.normalizeDisplayText(input);
    if (!normalized) return "";
    return normalized;
  }

  private wrapThoughtMessage(input: string): string {
    const normalized = this.normalizeDisplayText(input);
    if (!normalized) return "";
    return `思考\n${normalized}`;
  }

  private normalizeDisplayText(input: string): string {
    return input
      .replace(/\r\n/g, "\n")
      .trim();
  }

  private getEventTitle(eventType: string): string {
    if (eventType === "kairo.agent.thought") return "思考";
    if (eventType.startsWith("kairo.agent.") && eventType.endsWith(".message")) return "💬 消息";
    return "📡 事件";
  }

  private formatEventTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  private formatId(value?: string): string {
    if (!value) return "-";
    if (value.length <= 8) return value;
    return `${value.slice(0, 8)}…`;
  }

  private safeStringify(value: unknown, maxLength: number): string {
    if (value == null) return "";
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    if (!rendered) return "";
    return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}...` : rendered;
  }

  private async sendPostMessage(chatId: string, lines: string[]) {
    const messageLines = lines.slice(0, 30);
    if (messageLines.length === 0) return;
    const markdown = [...messageLines].join("\n");
    await this.sendMarkdownCardMessage(chatId, markdown);
  }

  private async sendMarkdownCardMessage(chatId: string, content: string) {
    const markdown = this.wrapMarkdownMessage(content);
    if (!markdown) return;
    await this.sendMessage("chat_id", chatId, "interactive", {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: markdown,
          },
        },
      ],
    });
  }

  private async sendFileMessage(chatId: string, filePath: string) {
    const fileKey = await this.uploadFile(filePath);
    await this.sendMessage("chat_id", chatId, "file", { file_key: fileKey });
  }

  private async enqueueSendTask(chatId: string, task: () => Promise<void>) {
    const previous = this.outboundSendQueue.get(chatId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.outboundSendQueue.set(chatId, current);
    await current.finally(() => {
      const queue = this.outboundSendQueue.get(chatId);
      if (queue === current) {
        this.outboundSendQueue.delete(chatId);
      }
    });
  }

  private async waitSendWindow() {
    const elapsed = Date.now() - this.lastSendAt;
    const waitMs = FeishuChannelAdapter.SEND_MIN_INTERVAL_MS - elapsed;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    this.lastSendAt = Date.now();
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private createFeishuRequestError(action: string, response: Response, payload: FeishuApiPayload, retryable: boolean): FeishuRequestError {
    const code = typeof payload.code === "number" ? ` code=${payload.code}` : "";
    const message = payload.msg || response.statusText || "unknown error";
    const error = new Error(`${action} failed: ${response.status}${code} ${message}`) as FeishuRequestError;
    error.retryable = retryable;
    return error;
  }

  private shouldRetryFeishuRequest(response: Response, payload: FeishuApiPayload) {
    if (this.shouldInvalidateToken(response, payload)) return true;
    if (response.status >= 500 || response.status === 429) return true;
    const msg = String(payload.msg || "").toLowerCase();
    if (!msg) return false;
    return (
      msg.includes("token expired") ||
      msg.includes("token is expired") ||
      msg.includes("invalid tenant_access_token") ||
      msg.includes("invalid access token") ||
      msg.includes("unauthorized") ||
      msg.includes("rate limit") ||
      msg.includes("too many request") ||
      msg.includes("频率") ||
      msg.includes("稍后重试") ||
      msg.includes("timeout") ||
      msg.includes("temporarily")
    );
  }

  private shouldInvalidateToken(response: Response, payload: FeishuApiPayload) {
    if (response.status === 401 || response.status === 403) return true;
    const msg = String(payload.msg || "").toLowerCase();
    const code = typeof payload.code === "number" ? payload.code : Number.NaN;
    if ([99991661, 99991663, 99991668].includes(code)) return true;
    if (!msg) return false;
    return (
      (msg.includes("token") || msg.includes("授权")) &&
      (msg.includes("expire") || msg.includes("invalid") || msg.includes("unauthorized") || msg.includes("过期") || msg.includes("失效"))
    );
  }

  private clearTenantToken() {
    this.tenantAccessToken = undefined;
    this.tenantTokenExpireAt = 0;
    this.tenantTokenPromise = undefined;
  }

  private getRetryDelayMs(attempt: number) {
    const capped = Math.min(attempt, 6);
    return FeishuChannelAdapter.SEND_RETRY_BASE_DELAY_MS * (2 ** (capped - 1));
  }

  private isRetryableRuntimeError(error: unknown) {
    if (error && typeof error === "object" && "retryable" in error) {
      return (error as FeishuRequestError).retryable === true;
    }
    if (error instanceof TypeError) return true;
    if (error instanceof Error) {
      const text = error.message.toLowerCase();
      return text.includes("network") || text.includes("fetch") || text.includes("timeout");
    }
    return false;
  }

  private async sendMessage(
    receiveIdType: FeishuReceiveIdType,
    receiveIdInput: string,
    msgType: FeishuMessageType,
    content: Record<string, any> | string,
  ) {
    const receiveId = receiveIdInput.trim();
    if (!receiveId) {
      throw new Error("send message failed: receive id is empty");
    }
    const requestUuid = randomUUID();
    const messageContent = typeof content === "string" ? content : JSON.stringify(content);
    let lastError: unknown;
    for (let attempt = 1; attempt <= FeishuChannelAdapter.SEND_RETRY_MAX; attempt++) {
      try {
        await this.waitSendWindow();
        const token = await this.getTenantAccessToken();
        const response = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
          {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: msgType,
            content: messageContent,
            uuid: requestUuid,
          }),
          },
        );
        const payload = await this.readJsonPayload(response);
        if (response.ok && payload.code === 0) {
          return;
        }
        if (this.shouldInvalidateToken(response, payload)) {
          this.clearTenantToken();
        }
        throw this.createFeishuRequestError("send message", response, payload, this.shouldRetryFeishuRequest(response, payload));
      } catch (error) {
        lastError = error;
        if (attempt >= FeishuChannelAdapter.SEND_RETRY_MAX || !this.isRetryableRuntimeError(error)) {
          throw error;
        }
        console.warn("[Channel:feishu] Send message retrying", {
          attempt,
          maxRetry: FeishuChannelAdapter.SEND_RETRY_MAX,
          receiveIdType,
          receiveId,
          msgType,
          uuid: requestUuid,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(this.getRetryDelayMs(attempt));
      }
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("send message failed");
  }

  private async uploadFile(filePath: string): Promise<string> {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new Error(`not a file: ${filePath}`);
    }
    if (fileStats.size > this.maxUploadBytes) {
      throw new Error(`file too large: ${filePath}`);
    }
    const token = await this.getTenantAccessToken();
    const fileBytes = await readFile(filePath);
    const form = new FormData();
    form.append("file_type", "stream");
    form.append("file_name", basename(filePath));
    form.append("file", new Blob([fileBytes]), basename(filePath));

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = await this.readJsonPayload(response);
    const fileKey = payload?.data?.file_key;
    if (!fileKey) {
      this.ensureFeishuSuccess("upload file", response, payload);
      throw new Error(`upload file failed: ${response.status} ${payload.msg || response.statusText}`);
    }
    this.ensureFeishuSuccess("upload file", response, payload);
    return fileKey;
  }

  private async readJsonPayload(response: Response): Promise<FeishuApiPayload> {
    return (await response.json().catch(() => ({}))) as FeishuApiPayload;
  }

  private ensureFeishuSuccess(action: string, response: Response, payload: FeishuApiPayload) {
    if (!response.ok || payload.code !== 0) {
      throw new Error(`${action} failed: ${response.status} ${payload.msg || response.statusText}`);
    }
  }

  private safeJsonParse(input: string) {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }

  private safeFileName(name: string) {
    return name.replace(/[^\w.\-()\u4e00-\u9fa5]/g, "_").slice(0, 120);
  }

  private resolveChatId(eventChatId?: string): string {
    const fixedChatId = this.fixedPrivateChatId?.trim();
    if (fixedChatId) return fixedChatId;
    return eventChatId?.trim() || "";
  }

  private resolveToolChatId(correlationId?: string): string {
    const fixedChatId = this.fixedPrivateChatId?.trim();
    if (fixedChatId) return fixedChatId;
    if (correlationId) {
      const mapped = this.pendingChats.get(correlationId);
      if (mapped) return mapped;
    }
    return this.activeChatId || "";
  }
}
