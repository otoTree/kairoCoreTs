/**
 * Agent 能力声明与注册表
 * 管理所有 Agent 的能力信息，支持按任务描述查找最匹配的 Agent
 */

export interface AgentCapability {
  agentId: string;
  name: string;
  description: string;
  inputSchema?: any;
  registeredAt: number;
}

export class CapabilityRegistry {
  private capabilities = new Map<string, AgentCapability[]>();

  register(capability: AgentCapability): void {
    const existing = this.capabilities.get(capability.agentId) || [];
    const idx = existing.findIndex(c => c.name === capability.name);
    if (idx >= 0) {
      existing[idx] = capability;
    } else {
      existing.push(capability);
    }
    this.capabilities.set(capability.agentId, existing);
  }

  unregister(agentId: string): void {
    this.capabilities.delete(agentId);
  }

  findBestAgent(taskDescription: string): AgentCapability | undefined {
    const lower = taskDescription.toLowerCase();
    let bestMatch: AgentCapability | undefined;
    let bestScore = 0;

    for (const caps of this.capabilities.values()) {
      for (const cap of caps) {
        let score = 0;
        if (lower.includes(cap.name.toLowerCase())) score += 10;
        const descWords = cap.description.toLowerCase().split(/\s+/);
        for (const word of descWords) {
          if (word.length > 2 && lower.includes(word)) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = cap;
        }
      }
    }

    return bestMatch;
  }

  getCapabilities(agentId: string): AgentCapability[] {
    return this.capabilities.get(agentId) || [];
  }

  getAllCapabilities(): AgentCapability[] {
    return Array.from(this.capabilities.values()).flat();
  }
}
