import { randomUUID } from "crypto";
import type { MCPPlugin } from "../../mcp/mcp.plugin";
import type { SystemTool, SystemToolContext, VaultResolver } from "../runtime";
import type { ToolCallAction } from "./action-types";

export interface ToolDispatcherDeps {
  mcp?: MCPPlugin;
  vault?: VaultResolver;
  systemTools: Map<string, SystemTool>;
  log: (message: string, data?: unknown) => void;
  getTraceContext: () => { traceId: string; spanId: string } | undefined;
}

export class ToolDispatcher {
  constructor(private readonly deps: ToolDispatcherDeps) {}

  async dispatch(action: ToolCallAction, context: SystemToolContext): Promise<unknown> {
    const traceContext = this.deps.getTraceContext();
    if (traceContext) {
      context.traceId = traceContext.traceId;
      context.spanId = randomUUID();
    }

    const name = action.function?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Tool call missing function name");
    }
    const args = action.function?.arguments;
    this.deps.log(`Executing tool: ${name}`, args);
    const resolvedArgs = this.resolveHandles(args);
    const systemArgs = this.toArgsRecord(resolvedArgs);

    if (this.deps.systemTools.has(name)) {
      try {
        return await this.deps.systemTools.get(name)!.handler(systemArgs, context);
      } catch (error: unknown) {
        throw new Error(`System tool execution failed: ${this.getErrorMessage(error)}`);
      }
    }

    if (!this.deps.mcp) throw new Error("MCP not enabled and tool not found in system tools");
    return await this.deps.mcp.callTool(name, resolvedArgs);
  }

  private resolveHandles(args: unknown): unknown {
    if (!this.deps.vault) return args;

    const resolve = (obj: unknown): unknown => {
      if (typeof obj === "string") {
        if (obj.startsWith("vault:")) {
          const val = this.deps.vault!.resolve(obj);
          if (val !== undefined) return val;
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(resolve);
      }
      if (typeof obj === "object" && obj !== null) {
        const newObj: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          newObj[key] = resolve(value);
        }
        return newObj;
      }
      return obj;
    };

    const clone = JSON.parse(JSON.stringify(args)) as unknown;
    return resolve(clone);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return String(error);
  }

  private toArgsRecord(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }
}
