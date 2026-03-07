# 长程任务事件驱动解决方案

## 问题分析

根据日志分析，当前系统在处理长程任务时存在以下问题：

1. **重复 say 循环检测过于激进**：`MAX_REPEATED_SAY_COUNT = 2` 导致长程任务被误判为循环而中断
2. **自动继续机制不稳定**：依赖关键词推断，容易被 tool_call 打断
3. **缺乏任务状态管理**：每个 tick 独立，没有跨 tick 的任务上下文
4. **无法从中断恢复**：系统崩溃或重启后，长程任务无法恢复

## 解决方案架构

### 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                        EventBus                              │
│  (kairo.task.*, kairo.agent.*, kairo.intent.*)             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   TaskOrchestrator                           │
│  - 任务生命周期管理 (PENDING → RUNNING → COMPLETED)         │
│  - 自动继续决策                                              │
│  - 任务上下文维护                                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  CheckpointManager                           │
│  - 定期保存检查点                                            │
│  - 崩溃恢复                                                  │
│  - 进度持久化                                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentRuntime                              │
│  - 集成任务上下文到 system prompt                           │
│  - 基于任务状态决定是否自动继续                             │
│  - 更新任务进度                                              │
└─────────────────────────────────────────────────────────────┘
```

### 事件流

```
用户发起长程任务
    │
    ▼
创建 Task (type: LONG, autoResume: true)
    │
    ▼
发布 kairo.task.created
    │
    ▼
AgentRuntime 接收任务，注入上下文到 prompt
    │
    ▼
Agent 执行 say 动作报告进度
    │
    ▼
发布 kairo.agent.progress
    │
    ▼
TaskOrchestrator 更新进度
    │
    ▼
CheckpointManager 保存检查点 (每 N 步)
    │
    ▼
检查 task.config.autoResume → 自动继续
    │
    ▼
发布 kairo.agent.internal.continue
    │
    ▼
触发下一个 tick，循环继续...
```

## 集成步骤

### 1. 修改 agent.plugin.ts

```typescript
import { TaskOrchestrator } from "./agent/task-orchestrator";
import { CheckpointManager } from "./agent/checkpoint-manager";

export class AgentPlugin {
  private orchestrator: TaskOrchestrator;
  private checkpointManager: CheckpointManager;

  async onLoad() {
    // 初始化任务编排器
    this.orchestrator = new TaskOrchestrator(this.bus);

    // 初始化检查点管理器
    this.checkpointManager = new CheckpointManager(
      this.orchestrator,
      this.bus,
      "./.kairo/checkpoints"
    );

    // 启动时恢复未完成的任务
    await this.recoverTasks();

    // 注册任务创建工具
    this.registerTaskTools();
  }

  private async recoverTasks() {
    const checkpoints = await this.checkpointManager.listCheckpoints();
    for (const checkpoint of checkpoints) {
      const task = this.orchestrator.getTask(checkpoint.taskId);
      if (task && task.status === "running") {
        await this.checkpointManager.restoreTask(checkpoint.taskId);
      }
    }
  }

  private registerTaskTools() {
    // 注册创建长程任务的工具
    this.runtime.registerSystemTool(
      {
        name: "kairo_create_long_task",
        description: "创建一个长程任务，支持自动继续和检查点恢复",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            totalSteps: { type: "number" },
            checkpointInterval: { type: "number", default: 10 },
          },
          required: ["description", "totalSteps"],
        },
      },
      async (args, context) => {
        const task = this.orchestrator.createTask({
          type: TaskType.LONG,
          description: args.description,
          agentId: context.agentId,
          context: {
            totalSteps: args.totalSteps,
            currentStep: 0,
          },
          config: {
            autoResume: true,
            checkpointInterval: args.checkpointInterval || 10,
          },
          correlationId: context.correlationId,
        });

        this.orchestrator.startTask(task.id);

        return {
          taskId: task.id,
          message: `长程任务已创建: ${task.description}`,
        };
      }
    );
  }
}
```

### 2. 修改 runtime.ts

在 `processTick` 方法的 finally 块中，替换现有的自动继续逻辑：

```typescript
finally {
  this.isTicking = false;

  // 检查是否有活跃的长程任务需要自动继续
  const shouldContinue = this.orchestrator?.shouldAutoContinue(this.id);

  if (shouldContinue || this.shouldAutoContinue) {
    this.shouldAutoContinue = false;
    this.log(`Auto-continuing...`);

    setTimeout(() => {
      if (this.running) {
        this.publish({
          type: "kairo.agent.internal.continue",
          source: "agent:" + this.id,
          data: { reason: "auto_continue" }
        });
      }
    }, 0);
  }
}
```

在 `tick` 方法中，增强 system prompt：

```typescript
private async tick(events: KairoEvent[]) {
  // ... 现有代码 ...

  // 获取活跃任务
  const activeTasks = this.orchestrator?.getActiveTasks(this.id) || [];
  const currentTask = activeTasks[0];

  // 构建任务上下文
  let taskContext = "";
  if (currentTask) {
    taskContext = `

【当前任务】
- 任务ID: ${currentTask.id}
- 描述: ${currentTask.description}
- 类型: ${currentTask.type} (长程任务，支持自动继续)
- 进度: ${currentTask.progress?.current || 0}/${currentTask.progress?.total || "?"}
${currentTask.context ? `- 上下文: ${JSON.stringify(currentTask.context)}` : ""}

【任务指引】
- 这是一个长程任务，请持续推进直到完成
- 使用 say 动作报告进度，系统会自动继续下一步
- 不需要在 thought 中包含"然后"、"接下来"等关键词
- 任务完成后使用 finish 动作结束
- 进度会自动保存检查点，系统崩溃后可恢复
`;
  }

  const systemPrompt = await this.getSystemPrompt(context, toolsContext, memoryContext, taskContext);

  // ... 继续现有代码 ...
}
```

在 action 处理后更新任务进度：

```typescript
if (action.type === 'say' && currentTask) {
  // 提取进度信息
  const progressMatch = action.content.match(/(\d+)\/(\d+)/);
  if (progressMatch) {
    this.orchestrator.updateProgress(currentTask.id, {
      current: parseInt(progressMatch[1]),
      total: parseInt(progressMatch[2]),
      message: action.content,
    });
  }
}

if (action.type === 'finish' && currentTask) {
  this.orchestrator.completeTask(currentTask.id, actionResult);
}
```

### 3. 使用示例

用户可以通过以下方式创建长程任务：

```typescript
// 方式1：通过工具调用
await agent.callTool("kairo_create_long_task", {
  description: "生成100道算法题",
  totalSteps: 100,
  checkpointInterval: 10,
});

// 方式2：在 prompt 中声明
// System Prompt 中添加：
// "如果用户要求执行多步骤任务（如生成100道题），请使用 kairo_create_long_task 工具创建长程任务"
```

Agent 在执行时：

```typescript
// Agent 的 thought 和 action
{
  thought: "用户要求生成100道算法题，这是一个长程任务。当前已完成第17题，继续生成第18题。",
  action: {
    type: "say",
    content: "✅ 已完成第17题：二叉树的最大深度 (17/100)"
    // 不需要设置 continue: true，系统会自动继续
  }
}
```

## 优势

1. **显式任务管理**：长程任务有明确的生命周期和状态
2. **可靠的自动继续**：基于任务类型而非关键词推断
3. **崩溃恢复**：检查点机制确保任务可恢复
4. **进度可视化**：任务进度通过事件发布，可被 UI 订阅
5. **灵活配置**：每个任务可独立配置自动恢复、检查点间隔等
6. **向后兼容**：不影响现有的短任务和交互式任务

## 测试场景

1. **正常执行**：创建100步任务，验证自动继续
2. **中断恢复**：执行到50步时杀死进程，重启后恢复
3. **用户干预**：任务执行中用户发送新消息，任务暂停
4. **并发任务**：同一 agent 处理多个长程任务
5. **检查点清理**：任务完成后检查点自动删除

## 后续优化

1. **任务优先级**：支持多任务调度
2. **任务依赖**：支持任务间的依赖关系
3. **分布式任务**：支持跨 agent 的任务协作
4. **任务监控**：提供任务执行的可观测性
5. **智能暂停**：根据系统负载自动暂停/恢复任务
