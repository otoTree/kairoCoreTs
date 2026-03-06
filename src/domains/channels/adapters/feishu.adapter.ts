import type { Context } from "hono";
import type { KairoEvent } from "../../events/types";
import type { ChannelAdapter, ChannelPublishToAgent, ChannelRouteRegistrar } from "../types";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createDecipheriv } from "node:crypto";

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly name = "feishu";
  private static readonly CONTEXT_TTL_MS = 15 * 60 * 1000;
  private static readonly CONTEXT_MAX = 1000;
  private publishToAgent?: ChannelPublishToAgent;
  private tenantAccessToken?: string;
  private tenantTokenExpireAt = 0;
  private pendingChats = new Map<string, { chatId: string; updatedAt: number }>();

  constructor(
    private readonly webhookPath: string,
    private readonly defaultAgentId: string,
    private readonly inboxDir: string,
    private readonly maxUploadBytes: number,
    private readonly appId?: string,
    private readonly appSecret?: string,
    private readonly verificationToken?: string,
    private readonly encryptKey?: string,
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
    console.log("[Channel:feishu] Adapter enabled", {
      webhookPath,
      defaultAgentId,
      hasAppId: !!appId,
      hasAppSecret: !!appSecret,
      hasVerificationToken: !!verificationToken,
      hasEncryptKey: !!encryptKey,
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
    );
  }

  registerRoutes(registerPost: ChannelRouteRegistrar, publishToAgent: ChannelPublishToAgent): void {
    this.publishToAgent = publishToAgent;
    console.log("[Channel:feishu] Registering webhook route", { path: this.webhookPath });
    registerPost(this.webhookPath, async (c) => this.handleWebhook(c));
  }

  async handleAgentAction(event: KairoEvent): Promise<void> {
    const correlationId = event.correlationId;
    if (!correlationId) return;
    this.cleanupContexts();
    const context = this.pendingChats.get(correlationId);
    if (!context) return;
    const action = (event.data as any)?.action;
    if (!action || (action.type !== "say" && action.type !== "query")) {
      console.log("[Channel:feishu] Skip non-text action", {
        correlationId,
        actionType: action?.type,
      });
      return;
    }
    const content = typeof action.content === "string" ? action.content.trim() : "";
    if (!content) {
      console.log("[Channel:feishu] Skip empty action content", { correlationId });
      return;
    }

    try {
      await this.sendTextMessage(context.chatId, content);
      const filePaths = await this.collectExistingPaths(content);
      for (const filePath of filePaths) {
        await this.sendFileMessage(context.chatId, filePath);
      }
      this.pendingChats.set(correlationId, { chatId: context.chatId, updatedAt: Date.now() });
    } catch (e) {
      console.error("[Channel:feishu] Failed to send response:", {
        correlationId,
        chatId: context.chatId,
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

    const eventType = body?.header?.event_type;
    const supportedEventTypes = new Set(["im.message.receive_v1", "im.message.group_at_msg.receive_v1"]);
    if (body?.schema !== "2.0" || !supportedEventTypes.has(eventType)) {
      console.log("[Channel:feishu] Ignored event", {
        schema: body?.schema,
        eventType,
      });
      return c.json({ code: 0, msg: "ignored" });
    }

    if (this.verificationToken && body?.header?.token && body.header.token !== this.verificationToken) {
      return c.json({ code: 1, msg: "invalid token" }, 401);
    }

    const event = body.event || {};
    const message = event.message || {};
    const sender = event.sender || {};
    const senderType = sender.sender_type || sender.sender_id?.sender_type;
    if (senderType === "bot") {
      return c.json({ code: 0, msg: "ignored bot message" });
    }

    const chatId = message.chat_id;
    const messageId = message.message_id;
    if (!chatId || !messageId) {
      return c.json({ code: 1, msg: "missing message metadata" }, 400);
    }

    const normalized = await this.normalizeMessage(event);
    const content = this.buildPrompt(event, normalized.text, normalized.attachments);
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id;
    const senderName = sender.sender_id?.user_id || senderId;

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
    let text = "";
    const attachments: string[] = [];

    if (messageType === "text") {
      text = typeof parsed?.text === "string" ? parsed.text : "";
    } else if (messageType === "post") {
      text = this.extractPostText(parsed);
    } else {
      text = typeof parsed?.text === "string" ? parsed.text : "";
    }

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
    this.cleanupContexts();
    if (this.pendingChats.size >= FeishuChannelAdapter.CONTEXT_MAX) {
      const first = this.pendingChats.keys().next().value;
      if (first) this.pendingChats.delete(first);
    }
    this.pendingChats.set(correlationId, { chatId, updatedAt: Date.now() });
  }

  private cleanupContexts() {
    const now = Date.now();
    for (const [key, value] of this.pendingChats.entries()) {
      if (now - value.updatedAt > FeishuChannelAdapter.CONTEXT_TTL_MS) {
        this.pendingChats.delete(key);
      }
    }
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
    if (this.tenantAccessToken && now < this.tenantTokenExpireAt - 60_000) {
      return this.tenantAccessToken;
    }
    if (!this.appId || !this.appSecret) {
      throw new Error("feishu app credentials are not configured");
    }
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`tenant token failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`tenant token failed: ${payload.msg || "unknown error"}`);
    }
    const token = payload.tenant_access_token as string;
    this.tenantAccessToken = token;
    this.tenantTokenExpireAt = Date.now() + Number(payload.expire || 7200) * 1000;
    return token;
  }

  private async sendTextMessage(chatId: string, text: string) {
    await this.sendMessage(chatId, "text", { text });
  }

  private async sendFileMessage(chatId: string, filePath: string) {
    const fileKey = await this.uploadFile(filePath);
    await this.sendMessage(chatId, "file", { file_key: fileKey });
  }

  private async sendMessage(chatId: string, msgType: "text" | "file", content: Record<string, any>) {
    const token = await this.getTenantAccessToken();
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 0) {
      throw new Error(`send message failed: ${response.status} ${payload.msg || response.statusText}`);
    }
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
    const payload = await response.json().catch(() => ({}));
    const fileKey = payload?.data?.file_key;
    if (!response.ok || payload.code !== 0 || !fileKey) {
      throw new Error(`upload file failed: ${response.status} ${payload.msg || response.statusText}`);
    }
    return fileKey;
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

  private async collectExistingPaths(content: string): Promise<string[]> {
    const matches = new Set<string>();
    const pathRegex = /(?:^|\s)(\/[^\s"'`]+|\.\.?\/[^\s"'`]+)/g;
    let found: RegExpExecArray | null = null;
    while ((found = pathRegex.exec(content)) !== null) {
      const raw = (found[1] || "").trim();
      if (!raw) continue;
      const cleaned = raw.replace(/[),.;:!?]+$/, "");
      const absolute = cleaned.startsWith("/") ? cleaned : resolve(process.cwd(), cleaned);
      matches.add(absolute);
    }

    const existing: string[] = [];
    for (const filePath of matches) {
      try {
        const fileStats = await stat(filePath);
        if (fileStats.isFile()) existing.push(filePath);
      } catch {}
    }
    return existing;
  }
}
