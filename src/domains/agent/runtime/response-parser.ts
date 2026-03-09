import type { AgentAction, SayAction } from "./action-types";

export interface ParsedModelResponse {
  thought: string;
  action: AgentAction;
}

export class ResponseParser {
  parse(content: string): ParsedModelResponse {
    const normalizedContent = this.normalizeModelOutput(content);
    const directParsed = this.tryParseJson(normalizedContent);
    if (directParsed) {
      return this.normalizeParsedResponse(directParsed);
    }

    for (const candidate of this.extractJsonCandidates(normalizedContent)) {
      const parsed = this.tryParseJson(candidate);
      if (parsed) {
        return this.normalizeParsedResponse(parsed);
      }
    }

    const recoveredParsed = this.tryRecoverTruncatedJson(normalizedContent);
    if (recoveredParsed) {
      return this.normalizeParsedResponse(recoveredParsed);
    }

    console.error("Failed to parse response:", content);
    const fallbackContent = normalizedContent.trim();
    if (fallbackContent.length > 0) {
      return {
        thought: "Model returned non-JSON response, auto-correcting",
        action: this.createAutoCorrectionSayAction("response_parse_failed"),
      };
    }

    return {
      thought: "Failed to parse response, auto-correcting",
      action: this.createAutoCorrectionSayAction("response_parse_failed"),
    };
  }

  private normalizeModelOutput(content: string): string {
    return content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
  }

  private tryParseJson(content: string): unknown | null {
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private tryRecoverTruncatedJson(content: string): unknown | null {
    const firstBraceIndex = content.indexOf("{");
    if (firstBraceIndex < 0) return null;
    const candidate = content.slice(firstBraceIndex).trim();
    if (!candidate) return null;
    const repaired = this.repairPossiblyTruncatedJson(candidate);
    if (!repaired) return null;
    return this.tryParseJson(repaired);
  }

  private repairPossiblyTruncatedJson(content: string): string | null {
    let inString = false;
    let escaped = false;
    const stack: string[] = [];
    let output = "";

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      output += char;

      if (char === "\\" && inString) {
        escaped = !escaped;
        continue;
      }

      if (char === "\"" && !escaped) {
        inString = !inString;
      }
      escaped = false;

      if (inString) continue;

      if (char === "{") {
        stack.push("}");
        continue;
      }

      if (char === "[") {
        stack.push("]");
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = stack[stack.length - 1];
        if (expected !== char) {
          return null;
        }
        stack.pop();
      }
    }

    if (inString) {
      if (escaped) output += "\\";
      output += "\"";
    }

    while (stack.length > 0) {
      output += stack.pop();
    }

    return output;
  }

  private normalizeParsedResponse(parsed: unknown): ParsedModelResponse {
    const record = this.toRecord(parsed);
    const thoughtRaw = record?.thought;
    const hasThought = typeof thoughtRaw === "string" && thoughtRaw.trim().length > 0;
    const thought = hasThought && typeof thoughtRaw === "string" ? thoughtRaw : "No thought provided";
    const action = this.normalizeAction(record?.action);
    if (!hasThought && action.type === "noop") {
      return {
        thought: "Missing thought in model response, auto-correcting",
        action: this.createAutoCorrectionSayAction("missing_thought"),
      };
    }
    return { thought, action };
  }

  private createAutoCorrectionSayAction(reason: string): SayAction {
    return {
      type: "say",
      content: "响应格式错误，正在自动纠正并重试。",
      continue: true,
      continueReason: reason,
    };
  }

  private normalizeAction(action: unknown): AgentAction {
    const record = this.toRecord(action);
    if (!record) {
      return { type: "noop" };
    }
    const type = record.type;
    if (typeof type !== "string" || type.length === 0) {
      return { type: "noop" };
    }
    return record as AgentAction;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private extractJsonCandidates(content: string): string[] {
    const candidates: string[] = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (char === "\\" && inString) {
        escaped = !escaped;
        continue;
      }
      if (char === "\"" && !escaped) {
        inString = !inString;
      }
      escaped = false;
      if (inString) continue;
      if (char === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(content.slice(start, i + 1));
          start = -1;
        }
      }
    }

    return candidates.sort((a, b) => this.scoreJsonCandidate(b) - this.scoreJsonCandidate(a) || b.length - a.length);
  }

  private scoreJsonCandidate(candidate: string): number {
    let score = 0;
    if (candidate.includes("\"action\"")) score += 2;
    if (candidate.includes("\"thought\"")) score += 1;
    return score;
  }
}
