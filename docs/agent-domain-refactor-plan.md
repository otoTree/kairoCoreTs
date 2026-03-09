# Agent 域评估与后续优化计划（2026-03）

## 背景

`src/domains/agent` 已完成一轮结构化重构，目录已经从“单体文件集中”进入“子域拆分”阶段，当前包含：

- `bootstrap/`：依赖与子系统组装
- `runtime/`：事件循环、动作执行、提示词与工具分发
- `task/`：长任务编排、Task Agent 管理、检查点
- `review/`：任务与 finish 审核
- `routing/`、`collaboration/`：路由与能力协作

本计划用于承接下一阶段优化，目标是把当前“可用且可维护”推进到“强类型、低耦合、可持续演进”。

## 当前状态评估

### 已完成项

1. `runtime` 拆分落地：
   - `response-parser.ts` / `action-executor.ts` / `tool-dispatcher.ts` / `runtime-event-loop.ts`
   - `tick-context-builder.ts` 已从主循环中抽离 prompt 与上下文构建
2. `review` 拆分落地：
   - `review-agent.ts` + `review-toolkit.ts`
3. `task` 拆分落地：
   - `task-agent-prompt.ts`
   - `task-completion-review.ts`
4. `agent.plugin` 进行去负载：
   - 协作工具注册抽到 `register-collaboration-tools.ts`
   - legacy 事件桥接抽到 `legacy-event-bridge.ts`

### 仍需解决的核心问题

1. 事件载荷仍有大量弱类型入口（`event.data as any`）。
2. `task-orchestrator.ts`、`task-agent-manager.ts` 仍偏重，聚合了状态、流程和事件映射逻辑。
3. `agent.plugin.ts` 依旧承担较多编排职责（start/stop 链路较长）。
4. `TaskAgentRuntimeAdapter` 仍依赖 Runtime 内部约定，扩展契约尚未显式化。

## 目标

1. 建立 Agent 域统一事件类型契约，减少 `any` 与隐式字段访问。
2. 继续拆分 Task 子域职责，降低核心类改动半径。
3. 进一步瘦身 AgentPlugin，明确生命周期 orchestration 边界。
4. 形成可验证、可回滚、可并行推进的阶段式实施路线。

## 非目标

1. 本轮不引入新的 Agent 产品能力。
2. 本轮不重写已有业务策略语义，仅做结构与契约收敛。
3. 本轮不做跨域协议大改，保持当前事件命名和兼容行为。

## 分阶段实施计划

### Phase A：事件强类型化（最高优先级）

目标：让核心链路摆脱 `event.data as any`，稳定后续重构基础。

改动项：

1. 新建 Agent 域事件契约模块（建议：`task/task-events.ts` + `runtime/runtime-events.ts`）。
2. 为以下高频事件提供 payload 类型与 parse helper：
   - `kairo.task.created|progress|completed|failed|cancelled`
   - `kairo.agent.action`
   - `kairo.tool.result`
   - `kairo.user.message`
3. 替换关键入口的 `as any`：
   - `task-agent-manager.ts`
   - `task-orchestrator.ts`
   - `review-agent.ts`
   - `runtime/event-filter.ts`
   - `runtime/observation-mapper.ts`

验收标准：

- 关键生产代码中 `event.data as any` 显著减少。
- lint/test 全通过。
- 行为与事件语义不变。

### Phase B：Task 子域内聚化

目标：降低 `TaskOrchestrator` 与 `TaskAgentManager` 的复杂度峰值。

改动项：

1. 将 `TaskOrchestrator` 拆为：
   - 状态存储与查询（state store）
   - 事件投影（event projector）
   - 生命周期服务（lifecycle service）
2. 将 `TaskAgentManager` 的事件处理拆为 handlers：
   - progress handler
   - noop handler
   - completed handler
3. 将 `CheckpointManager` 与 Task 事件契约打通，去掉 `any` 入口。

验收标准：

- `task-orchestrator.ts` / `task-agent-manager.ts` 体量继续下降。
- 任务链路测试保持通过。
- 关键流程函数圈复杂度下降。

### Phase C：AgentPlugin 生命周期瘦身

目标：把 `start/stop` 的流程编排从插件主类中进一步抽离。

改动项：

1. 引入 `AgentLifecycleComposer`（或等价命名）负责启动/停止编排。
2. `AgentPlugin` 保留：
   - 外部接口与 service facade
   - 工具注册入口
   - 运行中最小状态持有
3. 统一 system tool 注册契约，减少跨域传入 `unknown/any` 的漂移。

验收标准：

- `agent.plugin.ts` 继续减薄。
- start/stop 行为回归一致。
- 对外 API 保持兼容。

### Phase D：Runtime 扩展契约化

目标：消除 task adapter 对 Runtime 内部实现的隐式依赖。

改动项：

1. 在 Runtime 暴露正式 hook/interceptor（如 `onActionEmitted`、`onTickCompleted`）。
2. `TaskAgentRuntimeAdapter` 迁移到正式扩展点。
3. 补齐 adapter 与 runtime 的契约测试。

验收标准：

- 不再依赖私有字段覆写或内部回调注入。
- Runtime 内部重构不影响 TaskAdapter。

## 里程碑建议

1. M1：完成 Phase A（事件强类型化）
2. M2：完成 Phase B（Task 子域内聚化）
3. M3：完成 Phase C（AgentPlugin 生命周期瘦身）
4. M4：完成 Phase D（Runtime 扩展契约化）

## 验证与质量门槛

每个阶段均执行以下检查：

1. `bun run lint`
2. `bun test src/domains/agent`
3. 必要时补充阶段性单测（优先覆盖事件契约与边界分支）

## 风险与控制

### 风险 1：类型收敛导致隐藏行为变化

控制：

- 先引入 parse helper，再替换调用点，不直接“一步到位”改写。
- 保持事件字段兼容，缺省值由 helper 统一兜底。

### 风险 2：阶段交叉导致改动面过大

控制：

- 严格按 Phase 拆 PR，单阶段可独立回滚。
- 先做契约（Phase A），再做结构（Phase B/C/D）。

### 风险 3：测试盲区导致回归遗漏

控制：

- 优先补齐 task/review/runtime 边界测试。
- 对关键事件链路加断言：`intent started/ended`、`task progress/completed`、`review failed`。

## 预期收益

1. 降低核心链路维护成本与回归风险。
2. 提升跨文件重构的可预测性和可验证性。
3. 为 async-task、channels 等跨域接入提供更稳固的 Agent 契约基础。
