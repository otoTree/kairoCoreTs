# Kairo Agent 架构分析

## 文档目的

本文基于当前代码实现，对 Kairo Core 中 `src/domains/agent` 的设计进行系统性梳理，重点回答以下问题：

1. 这个项目的 Agent 到底是如何组织的。
2. 单个 Agent Runtime 的执行链路是什么。
3. 主 Agent、Task Agent、Review Agent、Collaboration 分别承担什么职责。
4. 这一套设计的优点、边界与潜在演进方向是什么。

本文偏向架构分析与实现理解，不是 API 手册。

---

## 一、总体判断

Kairo 的 Agent 设计并不是“一个包着 LLM 的工具调用器”，而是一个 **事件驱动的多 Agent Runtime 内核**。

从结构上看，它由四层组成：

1. **Agent 域装配层**：`AgentPlugin`
2. **单 Agent Runtime 层**：`AgentRuntime`
3. **多 Agent 扩展层**：`routing / task / review / collaboration`
4. **工具与上下文接入层**：memory、MCP、vault、system tools、event bus

如果用一句话概括：

> `AgentPlugin` 负责管理一个 agent 生态；`AgentRuntime` 负责运行单个 agent 的推理循环；task/review/collaboration 负责把单 agent 扩展成可治理、可委派、可协作的系统。

---

## 二、目录结构与模块边界

`src/domains/agent/` 当前可以按职责划分为以下几块：

### 2.1 域装配与导出

- `agent.plugin.ts`
- `agent-runtime-factory.ts`
- `bootstrap/`
- `index.ts`

职责：

- 统一初始化 agent 域
- 解析依赖
- 创建默认 agent 与 task 子系统
- 对外暴露 agent 相关能力

### 2.2 单 Agent Runtime 核心

- `runtime.ts`
- `runtime/response-parser.ts`
- `runtime/action-executor.ts`
- `runtime/tool-dispatcher.ts`
- `runtime/observation-mapper.ts`
- `runtime/runtime-event-loop.ts`
- `runtime/event-filter.ts`
- `runtime/cancel-handler.ts`
- `runtime/say-loop-guard.ts`
- `runtime/tick-context-builder.ts`
- `runtime/prompt/*`

职责：

- 订阅事件
- 过滤并缓冲事件
- 构造本轮上下文
- 调用 AI
- 解析模型输出
- 执行动作
- 将动作结果重新事件化

### 2.3 路由层

- `routing/agent-router.ts`
- `routing/legacy-event-bridge.ts`

职责：

- 把入口消息路由到具体 agent
- 兼容 legacy 事件形态

### 2.4 多 Agent 与任务系统

- `task/task-orchestrator.ts`
- `task/task-agent-manager.ts`
- `task/task-agent-runtime-adapter.ts`
- `task/task-agent-prompt.ts`
- `task/checkpoint-manager.ts`
- `task/task-tools-registry.ts`
- `task/task-completion-review.ts`

职责：

- 管理长程任务生命周期
- 创建后台 Task Agent
- 追踪进度、恢复检查点
- 将 Task Agent 接入主事件系统

### 2.5 审查层

- `review/review-agent.ts`
- `review/review-toolkit.ts`
- `review/review-types.ts`

职责：

- 对“任务完成”或“Agent 声明完成”进行二次验证
- 尝试把“声称完成”与“真正完成”分离

### 2.6 协作层

- `collaboration/capability-registry.ts`
- `collaboration/register-collaboration-tools.ts`

职责：

- 管理 agent capability
- 支持基于能力选择目标 agent
- 支持任务委派

---

## 三、顶层设计：`AgentPlugin`

### 3.1 它不是一个 Agent，而是 Agent 域控制器

`AgentPlugin` 的职责不是自己推理，而是：

- 维护全局事件总线 `globalBus`
- 维护默认 `memory` 与 `sharedMemory`
- 维护所有 `AgentRuntime` 实例
- 维护系统工具列表 `systemTools`
- 装配 task / review / collaboration 子系统
- 对接外部系统输入（例如 `kairo.user.message`）

所以更准确的理解是：

> `AgentPlugin` 是 Agent Domain 的操作入口和生命周期管理器。

### 3.2 启动时的关键流程

`AgentPlugin.start()` 大致完成以下事情：

1. 解析依赖：AI、MCP、Vault、MemoryStore。
2. 将 `MemoryStore` 注入默认短期记忆。
3. 构造 `AgentRuntimeFactory`。
4. 启动默认主 Agent：`default`。
5. 创建 Task 子系统：
   - `TaskOrchestrator`
   - `CheckpointManager`
   - `ReviewAgent`
   - `TaskAgentManager`
6. 恢复历史 checkpoint。
7. 注册 task 工具。
8. 注册 collaboration 工具。
9. 创建 `AgentRouter`。
10. 监听 `kairo.user.message` 并交给 router。
11. 监听 capability 注册事件。
12. 将 legacy 事件桥接到默认 agent。

这表明：

- 默认 agent 只是 agent 生态中的一个成员。
- 任务系统和审查系统不是外挂，而是 agent 域启动时的标准组成部分。

### 3.3 工具注入机制

`AgentPlugin.registerSystemTool()` 会将工具定义保存到域级工具表中，并同步注册到当前已存在的所有 agent runtime。

这意味着：

- memory、device、channel、task 等能力都可以在运行期注入。
- 新增 agent 时会继承当前工具集。
- agent 看到的是统一的 system tool 接口，而不是分散的域 API。

这是整个设计可扩展性的基础之一。

---

## 四、单 Agent 的核心：`AgentRuntime`

### 4.1 `AgentRuntime` 的职责

`AgentRuntime` 是单个 agent 的核心执行体。它负责：

- 订阅事件
- 将事件转换为 observations
- 组织上下文
- 调用模型
- 解析输出
- 执行动作
- 跟踪 pending action
- 处理取消语义
- 控制自动继续与防循环

它本质上是一个 **事件驱动的状态机 + 推理循环**。

### 4.2 `AgentRuntime` 内部的关键组件

当前 runtime 通过组合多个子组件实现：

- `ObservationMapper`
  - 把事件转成 observations
- `RuntimeEventLoop`
  - 管理事件缓冲与 tick 调度
- `EventFilter`
  - 过滤不属于当前 agent 的事件
- `CancelHandler`
  - 处理取消语义
- `ResponseParser`
  - 把模型输出变成结构化动作
- `ToolDispatcher`
  - 分发 system tools / MCP tools
- `ActionExecutor`
  - 执行 `say` / `tool_call` / `finish` 等动作
- `SayLoopGuard`
  - 防止重复 say 死循环

这种拆分非常重要，因为它表明作者没有把 runtime 做成一个“大函数”，而是有意识地进行职责分层。

### 4.3 runtime 的输入输出模型

从架构上看，`AgentRuntime` 的输入是：

- 事件流 `KairoEvent[]`
- memory / sharedMemory
- tools / MCP tools
- vault
- AI provider

输出是：

- `kairo.agent.thought`
- `kairo.agent.action`
- `kairo.tool.result`
- `kairo.intent.started`
- `kairo.intent.ended`
- `kairo.intent.cancelled`
- 以及某些内部继续事件

也就是说，runtime 不是一个“返回字符串”的组件，而是一个“消费事件、生产事件”的组件。

---

## 五、事件驱动执行链路

下面是一条典型链路：用户发来一条消息，最终 agent 做出响应并调用工具。

### 5.1 输入事件进入系统

入口事件可能来自：

- WebSocket 的 `kairo.user.message`
- channel adapter 发布的 `kairo.agent.{id}.message`
- task 系统发布的任务事件
- tool result 事件
- 系统事件、UI 事件等

这些事件通过全局 `EventBus` 进入 `AgentRuntime`。

### 5.2 runtime 订阅并过滤事件

runtime 启动后会订阅多类事件，例如：

- `kairo.tool.result`
- `kairo.user.message`
- `kairo.agent.{id}.message`
- `kairo.system.>`
- `kairo.agent.internal.>`
- `kairo.cancel`
- `kairo.agent.{id}.task`

随后通过 `EventFilter` 判断当前事件是否属于自己。

过滤策略很关键：

- `tool.result` 必须命中本 agent 的 pending action 才会接收
- 带 targetAgentId 的用户消息若不是当前 agent，则丢弃

这让“共享总线 + 多 agent 并存”成为可能。

### 5.3 RuntimeEventLoop 缓冲事件并调度 tick

事件不会直接触发模型调用，而是先进入 `RuntimeEventLoop`。

`RuntimeEventLoop` 的职责是：

- 缓冲事件
- 控制最大事件积压量
- 确保 runtime 运行时的 tick 串行化
- 当上一个 tick 结束后再处理下一批事件

这使得 runtime 更像 actor/event-loop，而不是普通同步 handler。

### 5.4 `tick()`：一轮推理的总入口

真正的一轮推理在 `AgentRuntime.tick()` 中完成。它大体包含：

1. 使用 `buildTickContext()` 组装上下文
2. 调用 AI 模型获取响应
3. 通过 `ResponseParser` 解析出 `thought + action`
4. 使用 `SayLoopGuard` 做重复 say 检测
5. 发布思考事件与动作事件
6. 通过 `ActionExecutor` 执行动作
7. 把 action/result 写回短期记忆
8. 决定是否自动继续下一轮

这个流程说明：

- Kairo 把“思考”“动作”“结果”都显式结构化了。
- 它不是把模型输出直接当最终回答，而是让模型先产出“行为决策”。

---

## 六、上下文构造：Agent 看到的到底是什么

虽然已有单独文档分析 context 与 memory，这里只保留与 agent 架构相关的重点。

### 6.1 `buildTickContext()` 的职责

它负责将以下信息组装为一轮 prompt：

- 当前 observations
- 短期上下文 `memory.getContext()`
- 长期记忆召回 `memory.recall()`
- 共享事实 `sharedMemory.getFacts()`
- system tools
- MCP 相关工具

所以对 `AgentRuntime` 来说，context 不是静态 prompt，而是每轮动态拼装的运行时状态。

### 6.2 prompt 的工程化特点

system prompt 中不仅有人格，还有：

- 项目路径
- workspace
- skills 目录
- MCP 目录
- 输出格式要求
- 工具调用示例
- 渲染能力说明
- 语言策略
- 长任务约束
- 渠道文件约束

这说明 Kairo 的 agent prompt 更接近 **runtime contract**，而不是单纯“设定人格”。

---

## 七、动作模型：为什么这套 agent 更像操作系统而不是聊天机器人

### 7.1 模型输出不是文本，而是动作

通过 `ResponseParser`，模型输出被规范成：

- `thought`
- `action`

其中 action 可以是：

- `say`
- `query`
- `render`
- `finish`
- `noop`
- `tool_call`

这说明模型的职责不是“直接回答用户”，而是“决定下一步系统动作”。

### 7.2 `ActionExecutor` 的作用

`ActionExecutor` 不只是执行工具，而是对动作执行生命周期进行完整事件化：

- 发布 `kairo.agent.action`
- 执行工具调用
- 发布 `kairo.tool.result`
- 发布 `kairo.intent.ended`
- 在错误场景下发布失败结果

这样做的好处是：

- UI 可以实时看到 agent 的动作流
- 审查模块可以监听完成声明
- task 系统可以把 `say` 解释成进度上报
- future debugging / tracing 更容易做

### 7.3 pending action 跟踪

runtime 使用：

- `pendingActions`
- `pendingCorrelations`

来追踪哪些 tool result 属于自己，哪些 cancellation 应该命中自己。

这在多 agent + 异步工具调用场景下非常关键。否则结果回流时就无法知道应该路由给谁。

---

## 八、自动继续与防循环：runtime 的两个重要控制机制

### 8.1 自动继续

runtime 设计了 `shouldAutoContinue` 和 `autoContinueStreak` 等状态，用于支持：

- say 后继续
- 长程任务自动推进
- 某些内部循环型工作流

这意味着 agent 并不总是在一次动作后停下来等用户输入，而是可以在系统内部继续推进。

这对 task agent 尤其重要。

### 8.2 SayLoopGuard

为了防止模型连续重复输出相同 say 内容，runtime 使用 `SayLoopGuard` 做简单防护。

逻辑是：

- 如果连续若干次 say 内容相同
- 则将其视为无效循环，转换为 noop 或阻断继续

这是一个很实用的“运行时纠偏”设计，因为它把一些 prompt 难以完全约束的问题下沉到了 runtime 层。

### 8.3 CancelHandler

`CancelHandler` 使用 `targetCorrelationId` 来撤销 pending action。

这一设计表明：

- Kairo 并不把取消看成“直接打断函数调用”
- 而是通过 correlation-based cancellation 处理语义上的取消

这对分布式/异步事件风格的系统更自然。

---

## 九、Router：从单 Agent 走向多 Agent 的入口

### 9.1 `AgentRouter` 的角色

Router 的核心职责是：

- 处理用户消息入口
- 决定消息交给哪个 agent
- 必要时创建 agent
- 默认回退到 `default` agent

这意味着主 Agent 只是默认路由目标，不是系统唯一 agent。

### 9.2 为什么单独做 Router 是对的

如果不单独抽 Router，消息分配逻辑就会散落在：

- server
- runtime
- task manager
- collaboration tools

这样系统会很难扩展。把路由层独立出来，至少从架构上为未来复杂多 agent 调度留出了位置。

---

## 十、Task 子系统：把长程任务从主 Agent 解耦

Task 子系统是当前 agent 设计里最有“工程系统感”的部分之一。

### 10.1 `TaskOrchestrator`

它管理任务生命周期：

- 创建任务
- 启动任务
- 更新进度
- 暂停 / 恢复
- 完成 / 失败 / 取消
- 查询 agent 对应任务
- 自动清理旧任务

可以把它看作一个：

- 任务注册表
- 任务状态机
- 任务事件发布器

它不是只服务 task agent，也服务整个系统的任务观测和恢复机制。

### 10.2 `TaskAgentManager`

它的职责是：

- 为任务创建 Task Agent Runtime
- 启动 / 停止 task agent
- 追踪活跃 task agent
- 在任务系统和 runtime 之间建立桥梁

它的存在使得主 Agent 不需要自己一直挂在长程任务上，而是可以“派生一个后台 agent 去做”。

### 10.3 `TaskAgentRuntimeAdapter`

这是一个非常巧妙的适配层。

Task Agent 使用的仍然是通用 `AgentRuntime`，但适配器会拦截 runtime 的 action：

- `say` → 尝试抽取进度
- `finish` → 报告完成
- `noop` → 上报空推进情况

这意味着：

- Task Agent 不需要有一套独立 runtime 实现
- 只需要通过 adapter 赋予其“任务语义”

这是高复用、低侵入的设计。

### 10.4 `TaskAgentPrompt`

Task Agent 的 prompt 很明确，要求它：

- 专注任务
- 持续推进
- 定期汇报进度
- 不等待用户确认
- 完成后 finish

这意味着 Task Agent 被设计成“执行型 agent”，而不是“交互型 agent”。

### 10.5 主 Agent 与 Task Agent 的关系

从角色上看：

- 主 Agent：偏交互、协调、决策、向用户解释
- Task Agent：偏执行、专注、后台推进、汇报进度

这是一个典型的“前台协调者 + 后台执行者”设计。

---

## 十一、ReviewAgent：把完成声明转化为可验证完成

### 11.1 为什么需要 ReviewAgent

很多 agent 系统的问题不在于不会做，而在于会：

- 过早 finish
- 声称完成但没有证据
- 工具失败后仍然宣称成功
- 任务进度未满却结束

`ReviewAgent` 的存在，就是为了在系统层面对这些问题做治理。

### 11.2 当前 review 机制做了什么

它会监听 agent action，尤其是：

- `say`
- `finish`

当 agent 出现 `finish` 时，会发布 `kairo.review.requested`，然后根据 scope 进行不同验证：

- `task-completion`
- `agent-finish`

### 11.3 task completion review

针对任务完成，当前 review 关注：

- task 是否存在
- task 是否被取消
- 进度是否到达 total

这是一套轻量级、偏规则化的校验。

### 11.4 agent finish review

针对 agent 自己宣称完成，当前 review 会尝试：

- 检查 finish result 是否为空
- 根据最近 say 判断是否承诺了交付物
- 若承诺了路径，则验证路径是否存在
- 若是 workspace 内路径，则检查 git diff 是否确有改动
- 若请求 auto commit，则在 review 通过后再执行 commit

这说明 review 不只是“再问一遍模型”，而是尽量走 **证据校验** 路线。

### 11.5 这一设计的价值

这实际上是把：

- “我觉得做完了”
- 和 “系统验证确实做完了”

分成两层语义。

对一个本地 coding/automation agent 来说，这是非常关键的架构意识。

---

## 十二、Collaboration：能力驱动的 Agent 协作雏形

### 12.1 capability registry

`CapabilityRegistry` 负责记录：

- 哪个 agent 声明了什么能力
- 某个任务描述最适合路由给哪个 agent

这意味着多 agent 协作不一定要靠人工指定目标 agent，而可以开始转向按 capability 发现。

### 12.2 collaboration tools

当前注册了两个关键工具：

- `delegate_task`
- `list_agent_capabilities`

其中 `delegate_task` 的逻辑是：

1. 优先用显式传入的 `targetAgentId`
2. 否则通过 capability registry 选择最佳 agent
3. 若仍找不到，就随机生成一个 agentId
4. 发布任务给目标 agent

这说明当前协作层已经形成了一条完整闭环：

- capability 注册
- capability 查询
- 基于能力委派
- 动态生成新 agent

虽然还偏初步，但方向已经非常明确。

---

## 十三、运行时工厂：主 Agent 与 Task Agent 的差异化装配

### 13.1 为什么需要工厂层

`AgentRuntimeFactory` 将 runtime 创建拆成：

- `MainRuntimeAssembler`
- `TaskRuntimeAssembler`

这不是形式主义，而是说明系统明确承认：

- 主 Agent 与 Task Agent 虽然共用同一个 runtime 类
- 但它们不是同一种实例

### 13.2 主 Agent 的装配特点

主 Agent 使用：

- 全局总线
- 默认 memory / 指定 memory
- 完整 system tools
- shared memory / vault / MCP 等标准能力

### 13.3 Task Agent 的装配特点

Task Agent 使用：

- 任务相关 bus
- 新解析出的 memory
- 经过过滤的工具列表
- 额外接一个 `TaskAgentRuntimeAdapter`

特别是 `AgentPlugin.getTaskAgentSystemTools()` 中对某些工具进行了过滤，例如禁掉 `kairo_feishu_*` 一类能力，这体现了：

- Task Agent 的权限应当更收敛
- 并不是所有主 Agent 能做的事都适合 task agent 做

---

## 十四、这套 Agent 设计的优点

### 14.1 解耦较好

当前设计把下列关注点拆开了：

- 域管理
- 单 agent runtime
- 任务系统
- 完成审查
- 协作分工
- 工具分发
- 上下文构造

这对后续演进非常重要。

### 14.2 事件驱动天然适合多 Agent

通过 EventBus：

- 不同 agent 可以共享通信机制
- review 和 server 可以旁路监听行为
- 工具调用结果可以自然回流到 runtime
- 新子系统更容易接入

### 14.3 主 Agent / Task Agent 职责清晰

这避免了把“和用户对话”与“后台长期执行”揉成一个 runtime 模式。

### 14.4 治理意识强于普通 Agent Demo

很多 agent 项目到“能调用工具”就结束了，而 Kairo 已经开始处理：

- 取消
- 重复 say
- 长任务
- checkpoint
- 完成审查
- capability-driven delegation

这说明它更接近“可运行的 agent platform”，而不是“示例工程”。

### 14.5 扩展点较清晰

新增一个领域能力，通常只需要：

1. 在对应 domain 中注册 service 或工具
2. 将 system tool 注入 agent
3. 通过 EventBus 接入 runtime 行为链

这使系统在保持结构化的同时仍然有良好的可扩展性。

---

## 十五、当前设计的边界与潜在问题

### 15.1 系统复杂度已经明显上升

这是一个真正的 runtime，而不是简单 controller，因此：

- 学习成本较高
- 事件追踪难度较高
- 调试需要更好的 tracing 工具

### 15.2 事件语义依赖命名规范

大量逻辑建立在事件名与 correlation/causation 语义上。一旦：

- 命名不统一
- 某个环节漏传 correlationId
- 某个插件发布了不规范事件

就容易出现难以排查的问题。

### 15.3 某些扩展点偏动态

例如 `TaskAgentRuntimeAdapter` 通过拦截 runtime 的 `onAction` 来附加任务语义，这种方式灵活，但也意味着：

- 对 runtime 内部结构有隐含依赖
- 后续重构时需要小心兼容性

### 15.4 review 仍然是轻量治理

当前 ReviewAgent 非常有价值，但仍然偏规则校验。对于更复杂的“真正完成”判定，它还不是完整解决方案。

### 15.5 collaboration 还处于雏形阶段

现在已有 capability 注册和委派机制，但要走向成熟的多 agent 编排，还需要补足：

- 更强的路由策略
- 更细粒度的权限与资源控制
- agent 生命周期治理
- agent 之间的协议化协作

---

## 十六、我对当前 Agent 设计的定位

如果要给这套架构一个定位，我会这样描述：

> Kairo 当前的 Agent 设计，已经超出了“LLM + tools”的阶段，进入了“本地事件驱动 Agent Runtime”的阶段；它拥有清晰的 runtime 核心、多 agent 路由能力、长任务分治机制、完成审查机制和能力协作雏形，是一个明显面向平台化演进的架构。

换一种更直白的话说：

- 它不是一个“聊天机器人后端”
- 它更像一个“本地智能体内核”

---

## 十七、建议的进一步演进方向

基于当前设计，我认为后续可以继续演进的重点方向包括：

### 17.1 强化 tracing 与调试工具

既然架构是事件驱动的，就非常值得补：

- 统一事件时序可视化
- correlation / causation 链路追踪
- 每轮 tick 的上下文快照
- action / tool result 的调试面板

### 17.2 进一步制度化多 Agent 协作

例如：

- 明确 agent role 模型
- capability 与权限绑定
- 支持 agent 生命周期策略
- 增加 agent 间协作协议

### 17.3 把 review 提升为通用治理层

当前 review 已经有很好雏形，下一步可以扩展到：

- finish 前验证
- task delivery 验证
- 风险动作审查
- 自动修复回路

### 17.4 提升 runtime 的状态可解释性

例如把以下信息结构化输出：

- tick reason
- selected observations
- chosen action why
- filtered events
- auto-continue cause

### 17.5 继续强化 task agent 的隔离与权限边界

随着 task agent 承担更多后台工作，它们的工具能力、工作目录、可见上下文和取消机制都值得进一步严格化。

---

## 十八、结语

Kairo 的 Agent 设计最值得肯定的，不是“能不能调用模型”，而是它已经开始把 Agent 当成一个需要：

- 生命周期管理
- 运行时治理
- 状态流转
- 多实例协作
- 任务分治
- 审查闭环

的系统软件组件来设计。

这使它天然具备继续演进成一个本地 Agent Platform 的基础。

当前它仍有不少地方可以继续打磨，但架构主方向是清晰且有潜力的。
