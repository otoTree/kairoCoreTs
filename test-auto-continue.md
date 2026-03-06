# Agent 自动继续机制测试文档

## 实现的改进

### 1. 核心问题
之前 Agent 在执行 `say` 动作后会立即发布 `intent.ended` 事件，导致流程中断，需要等待外部事件才能继续。

### 2. 解决方案
实现了事件驱动的自动继续机制：

#### 修改点 1: 添加自动继续标志
```typescript
// 在 AgentRuntime 类中添加
private shouldAutoContinue: boolean = false;
```

#### 修改点 2: 改变 `say` 动作的语义
- `say` 不再发布 `intent.ended`，而是发布 `kairo.agent.progress` 事件
- 分析 `thought` 中的关键词，判断是否有后续意图
- 如果检测到后续意图（如"然后"、"接下来"、"完成后"等），设置 `shouldAutoContinue = true`

```typescript
if (action.type === 'say') {
    // 发布进度事件
    this.publish({
        type: "kairo.agent.progress",
        source: "agent:" + this.id,
        data: { message: action.content },
        correlationId,
        causationId: actionEventId
    });

    // 检测后续意图
    const continueKeywords = ['然后', '接下来', '之后', '完成后', '安装后', '执行', '将', 'then', 'next', 'after', 'will'];
    const shouldContinue = continueKeywords.some(keyword => thought.includes(keyword));

    if (shouldContinue) {
        this.shouldAutoContinue = true;
    } else {
        // 没有后续意图，正常结束
        this.publish({ type: "kairo.intent.ended", ... });
    }
}
```

#### 修改点 3: 自动触发下一个 Tick
在 `processTick` 方法结束时检查 `shouldAutoContinue` 标志：

```typescript
finally {
    this.isTicking = false;

    if (this.shouldAutoContinue) {
        this.shouldAutoContinue = false;
        this.log(`Auto-continuing after say action...`);

        setTimeout(() => {
            if (this.running) {
                this.publish({
                    type: "kairo.agent.internal.continue",
                    source: "agent:" + this.id,
                    data: { reason: "auto_continue_after_say" }
                });
            }
        }, 0);
    }
}
```

#### 修改点 4: 订阅内部继续事件
```typescript
unsubs.push(this.bus.subscribe("kairo.agent.internal.>", this.handleEvent.bind(this)));
```

### 3. 工作流程

**之前的流程（有问题）：**
```
Tick #1: Thought: "需要安装curl然后执行搜索"
         Action: say("正在安装curl...")
         → 发布 intent.ended
         → 停止，等待外部事件

[等待 68 秒...]

用户催促 → Tick #2: 才开始安装
```

**现在的流程（优雅）：**
```
Tick #1: Thought: "需要安装curl然后执行搜索"  ← 包含"然后"关键词
         Action: say("正在安装curl...")
         → 发布 progress 事件
         → 检测到"然后"，设置 shouldAutoContinue = true
         → Tick 结束
         → 自动发布 internal.continue 事件

Tick #2: 立即触发（无需等待）
         → Agent 继续执行安装任务
```

### 4. 关键特性

1. **智能检测**：通过分析 `thought` 中的关键词判断是否有后续意图
2. **非阻塞**：使用 `setTimeout(0)` 避免同步递归
3. **事件驱动**：通过内部事件触发，保持架构一致性
4. **向后兼容**：`query` 和 `noop` 仍然正常等待用户输入

### 5. 测试场景

#### 场景 1: 有后续意图的 say
```
Thought: "检测到系统中没有安装curl工具，需要先安装curl，然后执行用户提供的命令"
Action: say("正在安装curl...")
→ 应该自动继续，执行安装
```

#### 场景 2: 无后续意图的 say
```
Thought: "任务已完成，向用户报告结果"
Action: say("搜索完成，结果如下...")
→ 应该正常结束，等待用户输入
```

#### 场景 3: query 动作
```
Thought: "需要询问用户的偏好"
Action: query("您希望使用哪个搜索引擎？")
→ 应该等待用户输入，不自动继续
```

### 6. 优势

1. **流畅性**：Agent 的行为更像人类，说完就做，而不是说完就停
2. **效率**：减少不必要的等待时间
3. **用户体验**：用户不需要催促 Agent 继续执行
4. **可扩展**：可以轻松添加更多关键词或更复杂的意图检测逻辑

### 7. 未来改进方向

1. **更智能的意图检测**：使用 LLM 分析 thought，而不是简单的关键词匹配
2. **任务队列**：维护显式的任务队列，支持多步骤计划
3. **可配置**：允许用户配置自动继续的行为
4. **监控**：添加指标追踪自动继续的频率和效果
