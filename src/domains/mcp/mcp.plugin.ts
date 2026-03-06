import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import { MCPRegistry } from "./registry";
import { FullMCPRouter } from "./router";
import type { MCPServerConfig, MCPRouter, MCPTool } from "./types";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { scanLocalMcpServers } from "./utils/loader";
import path from "path";

export class MCPPlugin implements Plugin {
  readonly name = "mcp";
  
  private registry: MCPRegistry;
  private router: MCPRouter;
  private configs: MCPServerConfig[] = [];
  private configFingerprint = "";

  constructor(configs: MCPServerConfig[] = [], private mcpDir?: string) {
    this.configs = configs;
    this.registry = new MCPRegistry(configs);
    this.router = new FullMCPRouter(); 
    this.configFingerprint = this.buildFingerprint(configs);
  }

  setRouter(router: MCPRouter) {
    this.router = router;
  }

  async addServer(config: MCPServerConfig) {
    this.configs = this.mergeConfig(config);
    await this.rebuildRegistry(this.configs);
  }

  setup(app: Application) {
    console.log("[MCP] Setting up MCP domain...");
    app.registerService("mcp", this);
  }

  async start() {
    console.log("[MCP] Starting MCP domain...");
    if (this.mcpDir) {
      await this.refreshServersFromDisk(true);
      return;
    }
    await this.rebuildRegistry(this.configs);
  }

  async stop() {
    console.log("[MCP] Stopping MCP domain...");
    await this.registry.disconnectAll();
  }

  async getRelevantTools(query: string = ""): Promise<MCPTool[]> {
    await this.refreshServersFromDisk();
    const serverNames = await this.router.route(query, this.configs);
    const tools: MCPTool[] = [];
    
    for (const name of serverNames) {
      const serverTools = this.registry.getTools(name);
      tools.push(...serverTools);
    }
    
    return tools;
  }

  async callTool(name: string, args: any) {
    await this.refreshServersFromDisk();
    const allTools = this.registry.getAllTools();
    const tool = allTools.find(t => t.name === name);
    
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }

    const client = this.registry.getClient(tool.serverId);
    if (!client) {
      throw new Error(`Client for server ${tool.serverId} not found`);
    }

    console.log(`[MCP] Calling tool ${name} on server ${tool.serverId}`);
    const result = await client.request(
      {
          method: "tools/call",
          params: {
              name: name,
              arguments: args
          }
      },
      CallToolResultSchema
    );

    return result;
  }

  async refreshServersFromDisk(force: boolean = false): Promise<boolean> {
    if (!this.mcpDir) return false;

    const baseDir = path.dirname(this.mcpDir);
    const mcpDirName = path.basename(this.mcpDir);
    const scanned = await scanLocalMcpServers(baseDir, mcpDirName);
    const nextFingerprint = this.buildFingerprint(scanned);

    if (!force && nextFingerprint === this.configFingerprint) {
      return false;
    }

    this.configs = scanned;
    this.configFingerprint = nextFingerprint;
    await this.rebuildRegistry(scanned);
    console.log(`[MCP] Reloaded ${scanned.length} servers from ${this.mcpDir}`);
    return true;
  }

  private buildFingerprint(configs: MCPServerConfig[]): string {
    const sorted = [...configs]
      .map((config) => ({
        name: config.name,
        command: config.command,
        args: config.args || [],
        env: config.env || {},
        disabled: Boolean(config.disabled),
        description: config.description || "",
        keywords: config.keywords || [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify(sorted);
  }

  private mergeConfig(config: MCPServerConfig): MCPServerConfig[] {
    const filtered = this.configs.filter((item) => item.name !== config.name);
    return [...filtered, config];
  }

  private async rebuildRegistry(configs: MCPServerConfig[]) {
    await this.registry.disconnectAll();
    this.registry = new MCPRegistry(configs);
    await this.registry.connectAll();
    this.configFingerprint = this.buildFingerprint(configs);
  }
}
