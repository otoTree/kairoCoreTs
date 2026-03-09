import type { AgentAction } from "./action-types";

export class SayLoopGuard {
  private lastSaySignature: string | null = null;
  private repeatedSayCount = 0;

  constructor(private readonly maxRepeatedSayCount: number) {}

  shouldConvertToNoop(action: AgentAction): boolean {
    if (action.type !== "say") {
      this.reset();
      return false;
    }
    const signature = this.normalizeSayContent(action.content);
    if (!signature) {
      this.reset();
      return false;
    }
    if (this.lastSaySignature === signature) {
      this.repeatedSayCount += 1;
    } else {
      this.lastSaySignature = signature;
      this.repeatedSayCount = 1;
    }
    return this.repeatedSayCount >= this.maxRepeatedSayCount;
  }

  private normalizeSayContent(content: unknown): string {
    if (typeof content !== "string") {
      return "";
    }
    return content.replace(/\s+/g, " ").trim();
  }

  private reset() {
    this.lastSaySignature = null;
    this.repeatedSayCount = 0;
  }
}
