# Task Agent 委派模式 - 完整方案

## 架构设计

### 核心思想

**主 Agent 保持响应性，长程任务委派给专门的 Task Agent 执行**

```
┌─────────────────────────────────────────────────────────────┐
│                         用户                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      主 Agent                                │
│  - 处理用户交互                                              │
│  - 创建长程任务                                              │
│  - 接收进度报告                                              │
│  - 始终保持响应                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 委派任务
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  TaskAgentManager                            │
│  - 创建 Task Agent                                           │
│  - 管理 Task Agent 生命周期                                  │
│  - 转发进度报告                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Task Agent 1, 2, 3...                      │
│  - 专注执行单个长程任务                                      │
│  - 定期报告进度                                              │
│  - 完成后自动销毁                                            │
└─────────────────────────────────────────────────────────────┘
```

## 完整流程

### 1. 用户发起长程任务

```
用户: "帮我生成100道算法题"
    │
    ▼
主 Agent 收到消息
    │
    ▼
主 Agent 判断这是长程任务
    │
    ▼
主 Agent 调用工具创建任务
{
  type: "tool_call",
  function: {
    name: "kairo_create_long_task",
    arguments: {
      description: "生成100道算法题",
      totalSteps: 100,
      checkpointInterval: 10
    }
  }
}
    │
    ▼
TaskOrchestrator 创建任务
    │
    ▼
发布 kairo.task.created 事件
    │
    ▼
TaskAgentManager 监听到事件
    │
    ▼
创建专门的 Task Agent
    │
    ▼
主 Agent 收到通知
{
  type: "say",
  content: "✅ 已创建 Task Agent，任务将在后台执行。你现在可以继续问我其他问题。"
}
```

### 2. Task Agent 执行任务

```
Task Agent 启动
    │
    ▼
收到任务提示词（包含完整上下文）
    │
    ▼
开始执行第 1 步
    │
    ▼
执行第 2 步
    │
    ▼
...
    │
    ▼
执行第 10 步
    │
    ▼
Task Agent 报告进度
{
  type: "say",
  content: "✅ 已完成第10题 (10/100)"
}
    │
    ▼
TaskAgentRuntimeAdapter 拦截 say 动作
    │
    ▼
提取进度信息: { current: 10, total: 100 }
    │
    ▼
发布 kairo.task.agent.progress 事件
    │
    ▼
TaskAgentManager 转发给主 Agent
    │
    ▼
主 Agent 收到进度通知（作为普通消息）
    │
    ▼
主 Agent 可以选择：
  - 忽略（继续处理其他请求）
  - 转发给用户
  - 记录到 memory
```

### 3. 用户在任务执行中插话

```
Task Agent 正在执行第 17 步
    │
    ├─ Task Agent 继续执行（不受影响）
    │   └─ 第 18 步
    │       └─ 第 19 步
    │           └─ ...
    │
    └─ 用户发送新消息: "今天天气怎么样？"
        │
        ▼
    主 Agent 收到消息（eventBuffer）
        │
        ▼
    主 Agent 立即响应
    {
      type: "tool_call",
      function: { name: "search_weather", ... }
    }
        │
        ▼
    主 Agent 回复用户
    {
      type: "say",
      content: "今天北京晴天，温度 15-25°C"
    }
        │
        ▼
    主 Agent 继续等待用户输入
    （Task Agent 仍在后台执行）
```

### 4. 任务完成

```
Task Agent 完成第 100 步
    │
    ▼
Task Agent 执行 finish 动作
{
  type: "finish",
  result: "已生成100道算法题，保存在 /app/algorithm_*.md"
}
    │
    ▼
TaskAgentRuntimeAdapter 拦截 finish 动作
    │
    ▼
发布 kairo.task.agent.completed 事件
    │
    ▼
TaskAgentManager 处理完成事件
    │
    ├─ 更新 TaskOrchestrator 状态
    │   └─ Task.status = COMPLETED
    │
    ├─ 通知主 Agent
    │   └─ 主 Agent 收到完成消息
    │       └─ 主 Agent 通知用户
    │
    └─ 停止并销毁 Task Agent
        └─ 释放资源
```

## 集成步骤

### 1. 在 agent.plugin.ts 中初始化

```typescript
import { TaskOrchestrator } from "./agent/task-orchestrator";
import { TaskAgentManager } from "./agent/task-agent-manager";
import { TaskAgentRuntimeAdapter } from "./agent/task-agent-runtime-adapter";
import { CheckpointManager } from "./agent/checkpoint-manager";

export class AgentPlugin {
  private orchestrator!: TaskOrchestrator;
  private taskAgentManager!: TaskAgentManager;
  private checkpointManager!: CheckpointManager;

  async onLoad() {
    // 1. 初始化任务编排器
    this.orchestrator = new TaskOrchestrator(this.bus);

    // 2. 初始化检查点管理器
    this.checkpointManager = new CheckpointManager(
      this.orchestrator,
      this.bus,
      "./.kairo/checkpoints"
    );

    // 3. 初始化 Task Agent Manager
    this.taskAgentManager = new TaskAgentManager(
      this.bus,
      this.orchestrator,
      this.createTaskAgentRuntime.bind(this)
    );

    // 4. 注册工具
    this.registerTaskTools();

    // 5. 启动清理定时器
    setInterval(() => {
      this.orchestrator.cleanup();
      this.taskAgentManager.cleanup();
    }, 60 * 60 * 1000); // 每小时清理一次
  }

  /**
   * 创建 Task Agent Runtime
   */
  private async createTaskAgentRuntime(config: TaskAgentConfig): Promise<AgentRuntime> {
    // 创建独立的 memory 和 runtime
    const memory = new AgentMemory({
      maxTokens: 40000,
      compressionRatio: 0.5,
    });

    const runtime = new AgentRuntime({
      id: config.id,
      ai: this.ai,
      mcp: this.mcp,
      bus: this.bus,
      memory,
      sharedMemory: this.sharedMemory,
      vault: this.vault,
      systemTools: this.systemTools,
    });

    // 包装 runtime，添加自动进度报告
    new TaskAgentRuntimeAdapter(runtime, this.bus, config);

    return runtime;
  }

  /**
   * 注册任务相关工具
   */
  private registerTaskTools() {
    // 工具1：创建长程任务
    this.mainRuntime.registerSystemTool(
      {
        name: "kairo_create_long_task",
        description: "创建一个长程任务，由专门的 Task Agent 在后台执行",
        inputSchema: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "任务描述",
            },
            totalSteps: {
              type: "number",
              description: "总步骤数",
            },
            context: {
              type: "object",
              description: "任务上下文（可选）",
            },
            checkpointInterval: {
              type: "number",
              description: "检查点间隔（默认10）",
              default: 10,
            },
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
            ...args.context,
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
          message: `长程任务已创建，Task Agent 将在后台执行`,
        };
      }
    );

    // 工具2：查询任务状态
    this.mainRuntime.registerSystemTool(
      {
        name: "kairo_query_task_status",
        description: "查询长程任务的执行状态",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "任务ID（可选，不提供则查询所有活跃任务）",
            },
          },
        },
      },
      async (args, context) => {
        if (args.taskId) {
          const task = this.orchestrator.getTask(args.taskId);
          return task || { error: "Task not found" };
        } else {
          const activeTasks = this.orchestrator.getActiveTasks(context.agentId);
          return {
            activeTasks: activeTasks.map(t => ({
              id: t.id,
              description: t.description,
              status: t.status,
              progress: t.progress,
            })),
          };
        }
      }
    );

    // 工具3：取消任务
    this.mainRuntime.registerSystemTool(
      {
        name: "kairo_cancel_task",
        description: "取消正在执行的长程任务",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "任务ID",
            },
            reason: {
              type: "string",
              description: "取消原因（可选）",
            },
          },
          required: ["taskId"],
        },
      },
      async (args, context) => {
        this.orchestrator.cancelTask(args.taskId, args.reason);
        return { message: `任务 ${args.taskId} 已取消` };
      }
    );
  }
}
```

### 2. 在主 Agent 的 system prompt 中添加指引

```typescript
const systemPrompt = `
你是 Kairo，一个智能助手。

【长程任务处理】
当用户要求执行多步骤任务（如生成100道题、批量处理文件等）时：
1. 使用 kairo_create_long_task 工具创建任务
2. 告知用户任务已在后台执行
3. 你可以继续处理用户的其他请求
4. Task Agent 会定期报告进度，你可以转发给用户

【示例】
用户: "帮我生成100道算法题"
你的响应:
{
  thought: "这是一个长程任务，应该委派给 Task Agent",
  action: {
    type: "tool_call",
    function: {
      name: "kairo_create_long_task",
      arguments: {
        description: "生成100道算法题",
        totalSteps: 100,
        context: { outputDir: "/app" },
        checkpointInterval: 10
      }
    }
  }
}

然后:
{
  thought: "任务已创建，告知用户",
  action: {
    type: "say",
    content: "✅ 我已经创建了一个 Task Agent 来生成100道算法题，它会在后台执行。我会定期向你报告进度。你现在可以继续问我其他问题。"
  }
}
`;
```

### 3. 处理进度报告（可选）

主 Agent 可以选择如何处理 Task Agent 的进度报告：

```typescript
// 在 runtime.ts 的 tick 方法中
private async tick(events: KairoEvent[]) {
  const observations = this.mapEventsToObservations(events);

  // 检测 Task Agent 进度报告
  const progressReports = observations.filter(o =>
    o.type === "system_event" &&
    o.content?.includes("[Task Agent 进度]")
  );

  if (progressReports.length > 0) {
    // 策略1：自动转发给用户（推荐）
    for (const report of progressReports) {
      this.publish({
        type: "kairo.agent.action",
        source: "agent:" + this.id,
        data: {
          action: {
            type: "say",
            content: report.content
          }
        }
      });
    }

    // 策略2：记录到 memory，不打扰用户
    // await this.memory.memorize(progressReports.map(r => r.content).join("\n"));

    // 策略3：让 Agent 决定是否转发
    // （在 system prompt 中包含进度报告，Agent 自己判断）
  }

  // 继续正常处理...
}
```

## 使用示例

### 场景1：生成100道算法题

```typescript
// 用户输入
"帮我生成100道算法题，涵盖数组、链表、树、图等主题"

// 主 Agent 响应
{
  thought: "这是一个长程任务，需要创建 Task Agent",
  action: {
    type: "tool_call",
    function: {
      name: "kairo_create_long_task",
      arguments: {
        description: "生成100道算法题，涵盖数组、链表、树、图等主题",
        totalSteps: 100,
        context: {
          topics: ["数组", "链表", "树", "图"],
          outputDir: "/app",
          filePrefix: "algorithm_"
        },
        checkpointInterval: 10
      }
    }
  }
}

// Task Agent 在后台执行
// 主 Agent 告知用户
{
  type: "say",
  content: "✅ 已创建 Task Agent 开始生成算法题，预计需要一些时间。我会每完成10题向你报告一次进度。你现在可以继续问我其他问题。"
}

// 10秒后，Task Agent 报告进度
"[Task Agent 进度] ✅ 已完成第10题 (10/100)"

// 主 Agent 转发给用户
{
  type: "say",
  content: "[后台任务进度] 算法题生成进度：10/100"
}

// 用户此时可以插话
"等等，先帮我查一下今天天气"

// 主 Agent 立即响应
{
  type: "tool_call",
  function: { name: "search_weather", ... }
}

// Task Agent 继续在后台执行，不受影响
```

### 场景2：批量处理文件

```typescript
// 用户输入
"帮我把 /data 目录下的所有图片转换成 webp 格式"

// 主 Agent 先扫描文件
{
  type: "tool_call",
  function: {
    name: "kairo_terminal_exec",
    arguments: {
      command: "find /data -type f \\( -name '*.jpg' -o -name '*.png' \\) | wc -l"
    }
  }
}

// 假设有 500 个文件
// 主 Agent 创建长程任务
{
  type: "tool_call",
  function: {
    name: "kairo_create_long_task",
    arguments: {
      description: "批量转换500个图片为 webp 格式",
      totalSteps: 500,
      context: {
        sourceDir: "/data",
        targetFormat: "webp"
      },
      checkpointInterval: 50
    }
  }
}

// Task Agent 执行转换
// 每转换 50 个文件报告一次进度
```

## 优势总结

1. **主 Agent 始终响应**：不会被长程任务阻塞
2. **并行执行**：可以同时运行多个长程任务
3. **资源隔离**：每个 Task Agent 有独立的 memory 和 context
4. **自动进度报告**：无需手动编写进度跟踪代码
5. **崩溃恢复**：结合 CheckpointManager，任务可恢复
6. **清晰的职责分离**：主 Agent 负责交互，Task Agent 负责执行

## 性能考虑

- **内存占用**：每个 Task Agent 约占用 50-100MB 内存
- **并发限制**：建议同时运行的 Task Agent 不超过 5 个
- **进度报告频率**：默认 5 秒一次，可根据任务类型调整
- **自动清理**：完成的 Task Agent 会在 1 小时后自动清理
