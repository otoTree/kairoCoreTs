# 异步脚本任务完整设计方案

## 背景与目标

当前项目已经具备两类相关能力：

1. `async-task` 可以基于 `delayMs`、`runAt`、`repeat` 调度一个未来执行的异步任务。
2. `kernel.processManager` 可以启动并追踪一个长时间运行的后台进程。

但现有能力仍有明显缺口：

- 调度能力目前触发的是 `delegateTask()`，而不是直接执行脚本。
- 长时间脚本虽然可以后台运行，但“脚本完成 = 任务完成”的语义还不完整。
- 脚本结束后虽然已经可以向 agent 发送简要消息，但缺少结构化汇报、历史记录、日志与产物管理。
- 对“立即执行、延时执行、定时执行、周期执行”的脚本任务缺少统一抽象。

本方案的目标是引入一套完整的“异步脚本任务（Async Script Task）”能力，使系统可以：

- 支持立即调用脚本。
- 支持未来指定时间调用脚本。
- 支持周期性重复调用脚本。
- 支持长时间运行脚本的生命周期跟踪。
- 支持脚本结束后自动向指定 agent 汇报。
- 支持可选的后续 agent 跟进处理。
- 支持重启恢复、状态持久化、输出摘要与日志落盘。

本方案不要求渐进式实现，而是描述一个完整的目标形态。

## 设计原则

### 1. 脚本完成即任务完成

系统需要把“脚本进程的生命周期”视为“任务生命周期”的主体，而不是把脚本执行当成某个子步骤。

### 2. 统一模型覆盖四种触发方式

同一套领域模型应同时支持：

- 立即执行
- 延时执行
- 指定时间执行
- 周期执行

不应为“立即执行”和“定时执行”维护两套并行系统。

### 3. 保持与现有架构一致

方案需要复用当前项目的既有基础设施：

- `AgentPlugin`：工具注册、消息汇报、可选任务委派
- `KernelPlugin`：`processManager`、系统工具基础设施
- `StateRepository`：状态持久化与恢复
- `globalBus`：事件发布与 agent 消息通道

### 4. 以任务为中心，而非单纯以进程为中心

进程是执行载体，但系统对上层暴露的核心对象应该是“脚本任务（ScriptTask）”，而不是裸 `processId`。

### 5. 面向长任务与生产使用场景

设计必须覆盖以下现实问题：

- 脚本可能运行很久
- stdout/stderr 可能很大
- 进程可能在系统重启时处于中间状态
- 周期任务可能在上一次尚未结束时再次触发
- agent 需要得到可消费、可继续编排的结构化结果

## 总体架构

建议在当前 `async-task` 域内新增“脚本任务”子域，而不是将逻辑全部混入现有 `AsyncTaskService`。

```text
┌─────────────────────────────────────────────────────────────┐
│                        AgentPlugin                           │
│  - registerSystemTool                                       │
│  - globalBus.publish                                        │
│  - delegateTask (optional follow-up)                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    ScriptTaskService                         │
│  - 任务创建 / 调度 / 执行 / 取消 / 查询                      │
│  - 状态机管理                                                │
│  - 重启恢复                                                  │
│  - processId / taskId / runId 关联                           │
└─────────────────────────────────────────────────────────────┘
               │                     │                    │
               ▼                     ▼                    ▼
┌────────────────────┐  ┌────────────────────────┐  ┌────────────────────┐
│ ScriptTaskReporter │  │ ScriptTaskLogBuffer    │  │ StateRepository     │
│ - 结构化汇报       │  │ - stdout/stderr 摘要   │  │ - 任务/运行落库     │
│ - agent 消息生成   │  │ - 日志落盘引用         │  │ - 恢复任务状态      │
└────────────────────┘  └────────────────────────┘  └────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Kernel ProcessManager                    │
│  - spawn / kill / getStatus                                  │
│  - output events / exit events                               │
└─────────────────────────────────────────────────────────────┘
```

## 核心能力范围

### 支持的触发方式

一套模型统一支持以下执行方式：

1. **立即执行**
   - 不传 `delayMs`
   - 不传 `runAt`
   - 不传 `repeat`
   - 创建后立刻启动脚本

2. **延时执行**
   - 传 `delayMs`

3. **指定时间执行**
   - 传 `runAt`

4. **周期执行**
   - 传 `repeat`
   - 首次执行可以是立即、延时或指定时间

### 支持的执行形态

1. **文件脚本**
   - 例如 `python scripts/report.py`
   - 例如 `bash scripts/sync.sh`

2. **命令行任务**
   - 例如 `/bin/sh -c "some command"`

3. **临时脚本**
   - 可支持内联脚本文本
   - 但推荐生产环境优先使用文件模式，便于审计与复现

### 支持的结束语义

1. 脚本自然结束并退出码为 `0`
   - 任务完成，状态为 `succeeded`

2. 脚本结束但退出码非 `0`
   - 任务完成，状态为 `failed`

3. 脚本被用户或系统中止
   - 任务完成，状态为 `cancelled`

4. 周期任务的一次运行结束
   - 当前运行完成
   - 主任务进入下一轮 `scheduled`

## 领域模型

### ScriptTask

`ScriptTask` 表示一个脚本任务定义，关注“这个任务是什么、如何触发、向谁汇报”。

建议字段：

```ts
type ScriptTaskStatus =
  | "scheduled"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

interface ScriptTask {
  taskId: string;
  ownerAgentId: string;
  reportToAgentId: string;
  description: string;

  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;

  inlineScript?: string;
  shell?: string;

  createdAt: number;
  scheduledAt?: number;
  startedAt?: number;
  endedAt?: number;
  nextExecuteAt?: number;

  repeat?: {
    intervalMs?: number;
    cron?: string;
  };

  status: ScriptTaskStatus;
  runCount: number;

  lastRunId?: string;
  lastProcessId?: string;
  lastExitCode?: number;
  lastError?: string;

  executionPolicy?: {
    allowConcurrentRuns?: boolean;
    overlapStrategy?: "skip" | "queue_one" | "parallel";
    timeoutMs?: number;
  };

  reportPolicy?: {
    onSuccess?: boolean;
    onFailure?: boolean;
    includeOutputSummary?: boolean;
    includeLogPaths?: boolean;
    triggerFollowupAgentTask?: boolean;
    followupDescriptionTemplate?: string;
  };

  artifacts?: {
    outputPaths?: string[];
    metadata?: Record<string, unknown>;
  };
}
```

### ScriptTaskRun

`ScriptTaskRun` 表示某个脚本任务的一次实际执行，关注“这次跑得怎么样”。

```ts
type ScriptTaskRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

interface ScriptTaskRun {
  runId: string;
  taskId: string;
  processId: string;

  startedAt: number;
  endedAt?: number;
  durationMs?: number;

  status: ScriptTaskRunStatus;
  exitCode?: number;
  error?: string;

  stdoutTail?: string;
  stderrTail?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;

  summary?: string;
}
```

### ProcessBinding

为便于恢复与回调，建议持久化 `processId -> taskId/runId` 绑定关系：

```ts
interface ScriptTaskProcessBinding {
  processId: string;
  taskId: string;
  runId: string;
  ownerAgentId: string;
}
```

## 状态机设计

### 单次任务

```text
created -> scheduled -> starting -> running -> succeeded
                                      └──────> failed
                                      └──────> cancelled
```

### 立即执行任务

```text
created -> starting -> running -> succeeded|failed|cancelled
```

### 周期任务

推荐把“任务定义状态”和“最近一次执行状态”解耦：

- 任务定义状态：
  - `scheduled`
  - `active`
  - `cancelled`
- 最近运行状态：
  - `starting`
  - `running`
  - `succeeded`
  - `failed`
  - `cancelled`

如果实现上希望保持简单，也可以延续当前 `async-task` 风格：

- 执行前：`scheduled`
- 执行中：`starting` / `running`
- 执行结束：
  - 若是周期任务，则重新回到 `scheduled`
  - 并更新 `nextExecuteAt`

## 工具接口设计

### 1. `kairo_async_script_run`

立即运行一个脚本任务，也允许携带调度参数，使其兼容未来扩展。

#### 输入

```json
{
  "description": "生成日报",
  "command": "python3",
  "args": ["scripts/daily_report.py"],
  "cwd": "/workspace/project",
  "env": {"MODE": "prod"},
  "reportToAgentId": "default",
  "reportPolicy": {
    "onSuccess": true,
    "onFailure": true,
    "includeOutputSummary": true,
    "triggerFollowupAgentTask": false
  },
  "artifacts": {
    "outputPaths": ["deliverables/daily-report.json"]
  }
}
```

#### 输出

```json
{
  "taskId": "script_task_xxx",
  "runId": "script_run_xxx",
  "processId": "script_proc_xxx",
  "status": "running",
  "startedAt": "2026-03-13T10:00:00.000Z"
}
```

### 2. `kairo_async_script_schedule`

创建一个未来执行或周期执行的脚本任务。

#### 输入

```json
{
  "description": "每小时同步数据",
  "command": "bash",
  "args": ["scripts/sync.sh"],
  "cwd": "/workspace/project",
  "delayMs": 60000,
  "repeat": {
    "intervalMs": 3600000
  },
  "reportToAgentId": "default",
  "executionPolicy": {
    "overlapStrategy": "skip"
  }
}
```

#### 输出

```json
{
  "taskId": "script_task_xxx",
  "status": "scheduled",
  "executeAt": "2026-03-13T10:01:00.000Z",
  "waitMs": 60000
}
```

### 3. `kairo_async_script_status`

查询单个脚本任务状态。

#### 输出建议包含

- `task`
- `latestRun`
- `runtime`
- `nextExecuteAt`

### 4. `kairo_async_script_list`

列出当前 agent 可见的脚本任务。

#### 输出建议包含

- `scheduled`
- `running`
- `recentCompleted`

### 5. `kairo_async_script_runs`

查询某个任务的历史执行记录。

### 6. `kairo_async_script_cancel`

取消尚未开始的任务，或取消周期调度。

#### 可选参数

- `killRunning`: 是否同时中止当前正在运行的进程

### 7. `kairo_async_script_kill`

中止当前运行中的一次脚本执行。

### 8. `kairo_async_script_rerun`

立即重新执行某个脚本任务，但不改原有调度定义。

## 统一参数语义

同一个脚本任务接口通过以下规则决定触发方式：

1. 未提供 `delayMs`、`runAt`、`repeat`
   - 立即执行

2. 提供 `delayMs`
   - 延时执行

3. 提供 `runAt`
   - 指定时间执行

4. 提供 `repeat`
   - 周期执行
   - 首次执行时间由“立即 / delayMs / runAt”决定

这能保证“立即调用脚本”是方案的原生能力，而不是附加补丁。

## 执行流程

### 创建任务

1. 校验参数
2. 标准化脚本定义与触发参数
3. 生成 `taskId`
4. 写入 `ScriptTask`
5. 如果是未来执行：
   - 计算 `nextExecuteAt`
   - 注册定时器
6. 如果是立即执行：
   - 直接进入启动流程
7. 发布 `kairo.async.script.created`

### 启动执行

1. 根据 `taskId` 读取任务
2. 检查当前状态与并发策略
3. 生成 `runId` 与 `processId`
4. 构建最终命令
5. 调用 `kernel.processManager.spawn()`
6. 创建 `ScriptTaskRun`
7. 更新 `ScriptTask`：
   - `status = running`
   - `lastRunId`
   - `lastProcessId`
   - `startedAt`
8. 发布 `kairo.async.script.started`

### 输出采集

1. 监听 `processManager` 的输出事件
2. 将 stdout/stderr 写入日志文件
3. 仅在内存中保留尾部摘要（tail）
4. 定期或结束时写回 `ScriptTaskRun`

### 结束处理

1. 接收到 `processManager` 退出事件
2. 通过 `processId` 找到 `taskId/runId`
3. 更新 `ScriptTaskRun`
4. 更新 `ScriptTask`
5. 生成结构化报告
6. 向 `reportToAgentId` 发送汇报
7. 若配置 `triggerFollowupAgentTask`：
   - 调用 `agent.delegateTask()` 创建后续任务
8. 如果是周期任务：
   - 计算下一次 `nextExecuteAt`
   - 根据策略重新调度
9. 发布 `kairo.async.script.completed`

## 汇报机制设计

### 汇报目标

每个脚本任务都需要明确 `reportToAgentId`。

- 默认可以取 `ownerAgentId`
- 也可以显式指定另一个 agent

### 汇报内容结构

建议同时发送两类信息：

1. **领域事件**
2. **agent 消息**

#### 领域事件

事件类型：`kairo.async.script.completed`

建议数据结构：

```ts
{
  taskId: string;
  runId: string;
  processId: string;
  ownerAgentId: string;
  reportToAgentId: string;
  description: string;
  status: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  command: string;
  args?: string[];
  cwd?: string;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  artifacts?: {
    outputPaths?: string[];
    metadata?: Record<string, unknown>;
  };
  nextExecuteAt?: number;
}
```

#### Agent 消息

建议发送到：

```text
kairo.agent.${reportToAgentId}.message
```

建议 `data` 包含两部分：

```ts
{
  content: string;
  structured: {
    kind: "script_task_report";
    taskId: string;
    runId: string;
    processId: string;
    status: string;
    exitCode?: number;
    durationMs: number;
    command: string;
    cwd?: string;
    stdoutTail?: string;
    stderrTail?: string;
    stdoutLogPath?: string;
    stderrLogPath?: string;
    artifacts?: {
      outputPaths?: string[];
      metadata?: Record<string, unknown>;
    };
    nextExecuteAt?: number;
  }
}
```

### 自然语言汇报模板

#### 成功

```text
[脚本任务完成] 任务 ${taskId} 执行成功，exitCode=0，耗时 ${duration}。
脚本：${command}
产物：${artifacts}
请检查结果并决定下一步动作。
```

#### 失败

```text
[脚本任务失败] 任务 ${taskId} 执行失败，exitCode=${exitCode}，耗时 ${duration}。
stderr 摘要：${stderrTail}
请检查错误原因并决定是否重试。
```

## 后续 agent 跟进机制

通知 agent 只是第一层能力，完整方案建议支持“汇报完成后自动触发后续 agent 子任务”。

### 适用场景

- 脚本完成后需要总结结果
- 脚本失败后需要自动诊断
- 脚本产出文件后需要读取并继续分析
- 脚本只是更大编排链中的一步

### 设计方式

当 `reportPolicy.triggerFollowupAgentTask = true` 时：

1. 发送汇报消息
2. 再调用 `agent.delegateTask()`
3. 创建一个新的子任务，描述可由模板生成

示例 follow-up 描述：

```text
脚本任务“${description}”已结束，状态为 ${status}。
请根据 stdout/stderr 摘要、日志路径和产物路径检查执行结果，并生成结论。
```

## 输出与日志策略

### 问题

长脚本可能输出大量日志，不能把全部 stdout/stderr 保留在内存中。

### 策略

1. stdout/stderr 实时写入日志文件
2. 内存中仅保留最后 N KB 或最后 N 行
3. 结束汇报时只发送摘要与文件路径

### 建议日志路径

```text
data/async-task/logs/<taskId>/<runId>.stdout.log
data/async-task/logs/<taskId>/<runId>.stderr.log
```

### 汇报中保留的信息

- `stdoutTail`
- `stderrTail`
- `stdoutLogPath`
- `stderrLogPath`

## 并发与重叠执行策略

周期任务必须明确处理“上一次还没结束，下一次触发已到”的情况。

### 建议策略

1. `skip`
   - 如果当前仍在运行，跳过本次触发
   - 推荐作为默认值

2. `queue_one`
   - 若有一次触发被错过，则在当前运行结束后补跑一次

3. `parallel`
   - 允许同一任务并发运行多个实例

### 默认推荐

`skip`

理由：

- 最适合长时间脚本
- 最不容易造成资源放大
- 避免重复写入、重复同步、重复生成产物

## 权限模型

### 角色定义

1. `ownerAgentId`
   - 创建任务的人
   - 具有取消、终止、重跑、查看完整状态的权限

2. `reportToAgentId`
   - 接收汇报的人
   - 可以只具有只读权限

### 规则建议

- `ownerAgentId` 拥有完全控制权
- `reportToAgentId` 至少可以查看摘要状态
- 若两者相同，则逻辑最简单
- 若不同，需要在工具层面定义最小权限集

## 持久化设计

短中期建议继续使用 `StateRepository`。

### Key 设计

```text
async-task:script:task:<taskId>
async-task:script:run:<runId>
async-task:script:binding:<processId>
```

### 落库内容

1. `task`
   - 脚本任务定义与当前聚合状态

2. `run`
   - 每一次执行实例的结果

3. `binding`
   - 进程与任务/运行关系，用于退出事件回查

## 恢复策略

### 服务启动时恢复

1. 读取全部 `task`
2. 读取全部 `run`
3. 读取全部 `binding`
4. 重建内存索引

### 对不同状态的处理

#### `scheduled`

- 重新注册定时器

#### `running` / `starting`

- 调 `processManager.getStatus(processId)`
- 若仍在运行：恢复为 `running`
- 若已退出：补写最终结果
- 若状态未知：标为 `failed`，原因写入 `lastError`

### 对错过的周期执行点的建议

默认不补跑系统离线期间错过的历史周期，只计算未来下一次执行时间。

原因：

- 避免系统恢复时一次性补跑大量脚本
- 避免重复执行带来副作用
- 与长任务场景更契合

## 与现有系统的关系

### 保留现有能力

1. `kairo_async_schedule`
   - 继续用于未来派发 agent 子任务

2. `kairo_async_process_start`
   - 继续用于立即启动后台进程

### 新能力定位

新的“脚本任务”能力不替代上述底层工具，而是在其之上增加一层更完整的任务语义。

### 内部复用点

- 调度时间解析：复用 `normalizeRepeat()` / `resolveNextRun()`
- 后台进程启动：复用 `kernel.processManager.spawn()`
- 汇报通道：复用 `agent.globalBus.publish()`
- 后续任务跟进：复用 `agent.delegateTask()`

## 推荐代码组织

建议拆分为独立文件，避免 `async-task.service.ts` 继续膨胀。

### 推荐文件

- `src/domains/async-task/script-task.types.ts`
- `src/domains/async-task/script-task.service.ts`
- `src/domains/async-task/script-task-reporter.ts`
- `src/domains/async-task/script-task-log-buffer.ts`
- `src/domains/async-task/script-task.plugin.ts`

如果希望入口保持单一，也可以由现有 `AsyncTaskPlugin` 统一启动 `ScriptTaskService`。

## 为什么这个方案适合当前项目

### 1. 兼容现有插件化架构

不需要修改 `Application` 或插件系统设计，只需在 `async-task` 域内增加更高层能力。

### 2. 复用已有内核能力

无需重新实现进程管理、状态存储、事件发布。

### 3. 满足长任务场景

特别适合以下需求：

- 定时执行 shell/python/node 脚本
- 执行时间很长
- 执行结束后需要汇报给 agent
- 汇报后还可能继续做后处理

### 4. 兼容立即执行需求

“立即调用脚本”不是额外补丁，而是该设计的一等能力。

## 最终结论

本方案建议在现有 `async-task` 领域中新增一套以 `ScriptTask` 为核心的完整能力层：

- 用统一模型覆盖立即、延时、定时、周期四种触发方式
- 用 `processManager` 负责真正的脚本执行
- 用 `ScriptTaskRun` 记录每次运行
- 用结构化汇报把“脚本完成”转化为“任务完成并通知 agent”
- 用日志与产物机制支撑长时间脚本的可观测性
- 用恢复与并发策略保证系统在重启和周期调度下行为可预期

这套设计能够直接满足“脚本执行结束时向 agent 汇报”的核心诉求，并为后续扩展自动 follow-up、任务审计、运行历史分析提供稳定基础。
