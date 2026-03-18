# Kairo 项目上下文组织与记忆系统分析

## 文档目的

本文记录当前对 Kairo Core 中 **上下文组织方式** 与 **记忆系统设计** 的理解，重点说明：

1. Agent 每一轮推理时，上下文是如何拼装的。
2. 短期记忆、长期记忆、共享记忆分别承担什么职责。
3. 当前实现的优点、局限与后续可演进方向。

本文偏向架构理解文档，不是 API 参考手册。

---

## 一、总体判断

Kairo 当前的上下文系统不是简单的“聊天历史数组”，而是一个典型的 **Agent Runtime 分层上下文模型**。

每一轮模型输入大致由以下几部分组成：

1. **系统级提示词**：身份、环境、能力、输出格式、行动规则。
2. **共享事实**：对当前 Agent 持续生效的稳定知识。
3. **短期上下文**：近期的 Observation / Thought / Action / Result 轨迹，以及历史摘要。
4. **长期记忆召回**：从持久化记忆中按当前上下文检索出的相关内容。
5. **工具上下文**：本轮可用的 system tools 和 MCP tools。
6. **当前观察结果**：由事件映射而来的 observations，组织成 user prompt。

从设计角度看，它更接近：

- `System Prompt + Runtime State + Retrieval + Current Observations`

而不是：

- `System Prompt + Full Chat History`

---

## 二、上下文是如何组织的

### 2.1 主入口：`buildTickContext`

上下文构造的核心入口在：

- `src/domains/agent/runtime/tick-context-builder.ts`

每次 `AgentRuntime.tick()` 执行时，都会调用 `buildTickContext()` 来生成本轮推理所需的材料。其产出包括：

- `observations`
- `systemPrompt`
- `userPrompt`
- `correlationId`
- `causationId`

可以把它理解为：**一轮 Agent 思考所需输入的总装配器**。

### 2.2 第一步：事件转换为 Observation

输入给 runtime 的并不是直接的用户消息，而是一批事件 `KairoEvent[]`。这些事件会先经过 `observationMapper` 转换为统一的 `Observation[]`。

这一步的意义是把不同来源的输入标准化，例如：

- 用户消息
- 工具执行结果
- 系统事件
- UI 信号
- 其他 agent 产生的事件

统一转成 agent 能理解的“观察结果”。

这意味着在 Kairo 中，**用户输入只是 observation 的一种来源**，而不是唯一输入源。

### 2.3 第二步：读取短期上下文

随后 runtime 会读取 agent memory 中的上下文：

- `memory.getContext()`

这里得到的是当前 agent 的短期运行时上下文，它并不是原始消息列表，而是经过组织后的：

- 近期若干轮的 observation / thought / action / result
- 外加一份历史摘要 `summary`

如果上下文过长，还会触发：

- `memory.compress(ai)`

即对旧历史进行摘要压缩，只保留最近若干轮详细轨迹。

### 2.4 第三步：收集本轮可用工具

当前轮可用工具分为两类：

1. **System Tools**：由各个插件注册到 agent，例如 memory、device、task、channel 等工具。
2. **MCP Tools**：由 MCP 插件按当前 observation 进行相关性筛选后提供。

这部分会组织成 `toolsContext` 注入到 system prompt 中。

这说明 Kairo 不是始终把所有工具都给模型，而是至少在 MCP 层面尝试做了 **按上下文裁剪**。

### 2.5 第四步：从长期记忆中召回相关内容

runtime 会基于近期 observation 生成一个 `recentContext`，再调用：

- `memory.recall(recentContext)`

这里的 `memory` 实际上是 `InMemoryAgentMemory`，而它会把 recall 请求转发给配置好的 `LongTermMemory` 实现，也就是 `MemoryStore`。

召回结果会组织成：

- `memoryContext`

然后注入到 system prompt 中。

也就是说，**长期记忆不是一直塞给模型，而是按当前上下文按需检索后注入**。

### 2.6 第五步：构造 system prompt 与 user prompt

#### system prompt 包含的内容

最终 system prompt 由 runtime system prompt builder 生成，主要包含：

- Agent 身份与角色
- 环境信息（OS、CWD、ProjectRoot、Workspace、SkillsDir、MCPDir、时间等）
- 能力描述（shell、文件、工具、技能、UI render）
- 语言策略（与用户输入保持同语言）
- 输出格式约束（严格 JSON）
- 短期上下文
- 长期记忆召回结果
- 共享事实
- 当前可用工具
- 长任务 / 渠道文件等额外指导

因此这个项目的 system prompt 更像一个 **运行时契约**，而不是一段通用人格提示。

#### user prompt 包含的内容

user prompt 则是根据 observations 组织出来的。这表示模型本轮看到的“用户输入”，本质上是：

- 当前对系统来说最相关的一批 observation

而不是原始 websocket 消息体本身。

---

## 三、记忆系统的分层结构

Kairo 当前的记忆系统可以拆成三条线：

1. **短期记忆**：`InMemoryAgentMemory`
2. **长期记忆**：`MemoryStore`
3. **共享记忆 / 共享事实**：`SharedMemory`

这三者并不是同一个东西。

---

## 四、短期记忆：`InMemoryAgentMemory`

### 4.1 它存的不是聊天记录，而是 Agent 轨迹

`InMemoryAgentMemory` 定义在：

- `src/domains/agent/memory.ts`

它维护的历史条目包含：

- `observation`
- `thought`
- `action`
- `actionResult`

也就是说，它记录的是 agent 在每一轮中的“看到了什么、想了什么、做了什么、结果如何”，而不是单纯的对话消息序列。

这使得它更像一个 **运行时执行轨迹记忆**。

### 4.2 上下文呈现形式

`getContext()` 会把历史组织成类似下面这种结构：

- 旧历史摘要：`Previous Memory Summary`
- 近期历史：`Recent History`
- 每一轮包含 Observation / Thought / Action / Result

这个结构非常像常见 Agent Runtime 中的：

- `summary + tail history`

即保留最近细节，同时把更早内容压缩为摘要。

### 4.3 压缩机制

当短期上下文过长时，会触发 `compress(ai)`：

1. 保留最近几条 history。
2. 将更早的 history 与现有 summary 一起交给 AI 总结。
3. 用新的 summary 替换旧 summary。

这个机制的优点是：

- 可以有效控制 prompt 长度。
- 比纯截断历史更保留“上下文连续性”。

但它的代价是：

- 旧历史会被 AI 重写成摘要，存在信息丢失和意义漂移风险。

### 4.4 与长期记忆的关系

`InMemoryAgentMemory` 自身并不负责长期持久化。它只是暴露了：

- `recall(query)`
- `memorize(content)`

然后把这些能力代理给外部注入的 `LongTermMemory`。

也就是说，短期记忆是 agent runtime 的工作区，长期记忆才是跨轮、跨会话的持久层。

---

## 五、长期记忆：`MemoryStore`

### 5.1 持久化方式

长期记忆的实现位于：

- `src/domains/memory/memory-store.ts`

它不是数据库向量库存储，而是 **按 namespace + layer 存放的文件型记忆库**。

每条记忆包含：

- `id`
- `layer`
- `content`
- `importance`
- `tags`
- `createdAt`

存储格式是 markdown 文本块加 HTML 注释元数据，而不是关系表或向量索引。

### 5.2 分层模型

Kairo 当前定义了四层仿生记忆：

1. `working`
   - 工作记忆，容量有限，偏短期。
2. `episodic`
   - 情景记忆，记录具体事件与经历。
3. `semantic`
   - 语义记忆，记录抽象知识与稳定规律。
4. `flashbulb`
   - 闪光灯记忆，记录高重要性的关键事件。

这是一个很有认知架构色彩的设计，不是简单的“收藏夹”式 memory。

### 5.3 重要性机制

每条长期记忆都有 `importance`，范围通常是 1 到 10。

并且存在一个升级规则：

- 当情景记忆的 `importance >= 8` 时，会自动晋升到 `flashbulb`

这表示系统已经尝试用“重要性”来影响记忆的层级和保留方式。

### 5.4 长期记忆的写入方式

长期记忆主要通过注册给 agent 的工具写入，例如：

- `memory_add`
- `memory_recall`
- `memory_forget`
- `memory_list`
- `memory_consolidate`

这意味着 memory 并不是被 runtime 自动全盘托管，而是更多通过 tool-use 方式显式管理。

### 5.5 长期记忆的固化

`consolidate()` 的逻辑是：

1. 从 `episodic` 层挑选重要性较高的情景记忆。
2. 用 AI 将这些记忆总结为更抽象的知识条目。
3. 把摘要写入 `semantic` 层。
4. 删除已被固化的情景记忆。

这相当于模拟了从“经历”提炼“知识”的过程。

这是当前实现里非常有价值的一点，因为它体现了：

- 情景记忆不是无限堆积
- 长期记忆可以从事件向知识演化

---

## 六、共享记忆：`SharedMemory`

共享记忆位于：

- `src/domains/agent/shared-memory.ts`

它的职责不是像长期记忆那样做按需 recall，而是维护一组更稳定、可持续注入的事实知识。

在 runtime 中，这些事实会直接被读取成：

- `Shared Knowledge`

然后拼入 system prompt。

因此，shared memory 更像：

- 当前 agent 集群共享的稳定事实层

而 long-term memory 更像：

- 可检索的历史经验与知识存档

两者的注入方式不同，也意味着它们在 prompt 中的“地位”不同。

---

## 七、当前方案的优点

### 7.1 不是简单堆聊天历史

它已经清晰地区分了：

- 当前 observation
- 短期历史
- 摘要
- 长期记忆
- 共享事实
- 工具上下文

这是一个成熟 agent runtime 常见的组织方向。

### 7.2 短期与长期职责分离

`InMemoryAgentMemory` 和 `MemoryStore` 分工明确：

- 前者负责本轮到近期的工作集
- 后者负责跨轮持久化与检索

这使得系统未来比较容易继续升级检索能力，而不必重写 runtime 主链路。

### 7.3 长期记忆有层级与重要性

相比把所有记忆视为同类文本块，当前的 layer + importance 模型已经能表达：

- 临时工作信息
- 具体经历
- 抽象知识
- 关键事件

这是记忆系统演进的重要基础。

### 7.4 已有 consolidation 机制

系统已经有从 episodic 到 semantic 的固化流程，这意味着它不是单纯的 append-only 存档，而是开始有了“知识提炼”的能力。

### 7.5 prompt 组织较工程化

上下文不是一次性塞给模型，而是做了：

- 压缩
- recall
- tool routing
- facts 注入

这说明作者已经把 memory 看作 runtime 的一部分，而不是一个附加功能。

---

## 八、当前方案的局限

下面是对当前记忆系统局限的详细理解。

### 8.1 长期检索主要是关键词匹配，不是语义检索

当前 recall 的核心机制是：

1. 将 query 拆成关键词。
2. 在 `content + tags` 中做字符串包含匹配。
3. 按匹配率计分。
4. 再乘以 importance 权重。

优点是实现简单、透明、稳定，但它有明显局限：

- 同义词、近义表达难以召回。
- 改写后的自然语言不容易命中。
- 跨语言检索效果差。
- 对抽象概念和偏好模式的召回能力弱。
- 容易出现“字面相关但语义无关”的误召回。

这意味着当前长期记忆更像一个轻量全文搜索，而不是语义记忆检索系统。

### 8.2 namespace 设计存在，但还比较基础

当前 `MemoryStore` 已经支持 namespace，这说明系统已有“记忆分桶”的意识。

但目前的 namespace 更像文件存储层面的目录划分，而不是成熟的作用域模型。当前还缺少：

- 明确的 namespace 策略
- user / project / agent / session 等层次化命名空间
- 自动根据上下文选择 namespace 的机制
- 跨 namespace 检索的规则
- 作用域隔离与继承策略

在小规模使用时问题不大，但一旦进入多用户、多项目、多 agent 场景，就容易出现记忆污染和召回范围失控。

### 8.3 shared memory 和 long-term memory 的边界偏手工

理论上两者职责不同：

- shared memory：持续注入、偏稳定的共享知识
- long-term memory：按需检索的历史经验和知识条目

但目前还缺少一套清晰的自动化规则来决定：

- 什么内容应进入 shared facts
- 什么内容只应留在 semantic memory
- 什么内容需要更新、降级或删除

因此两者边界现在更多依赖人工理解，而不是系统治理规则。

这会导致：

- 信息重复
- 信息漂移
- 冲突难以统一解决
- prompt 中不同知识源优先级不稳定

### 8.4 短期压缩依赖 AI 摘要质量

短期历史的压缩是通过 AI 摘要完成的，因此存在以下风险：

- 细节丢失
- 条件性例外被忽略
- “观察结果”被重写成不准确结论
- 历史偏差在多轮 summary 中累计
- 模型切换导致摘要质量波动

也就是说，压缩虽然解决了长度问题，但也引入了 **生成式记忆漂移** 的风险。

### 8.5 缺少强冲突消解与遗忘策略

目前系统已经有一些基础治理手段：

- `forget()`
- `importance`
- `working` 层容量裁剪
- `consolidate()`

但还缺少更成熟的记忆治理机制，例如：

- 冲突事实检测与合并
- 新旧偏好的时间衰减与覆盖规则
- 低价值记忆的自动遗忘
- 临时记忆的过期策略
- 重复记忆的去重机制
- 带来源证据的可追溯更新机制

这意味着记忆系统当前更像“可以存很多内容”，但还不是“可以长期维护一致性”的知识系统。

---

## 九、这些局限在实际运行中的表现

如果系统长期运行，可能会逐渐出现下面这些典型现象：

1. Agent 偶尔想不起本该记住的事情。
2. 旧偏好与新偏好并存，响应风格前后不一致。
3. 同类记忆不断堆积，召回结果重复且有噪声。
4. 某些历史摘要在早期出现偏差，后续不断放大。
5. 系统很难解释“为什么这次想起了 A 而不是 B”。
6. 多项目或多用户场景下，记忆容易串味。

这些都不是单点 bug，而是 memory system 进入长期运行阶段后常见的系统性问题。

---

## 十、我对当前实现的定位

如果要给当前记忆系统一个定位，我会这样描述：

> 它已经具备了一个 Agent 记忆架构的优秀雏形：有短期工作记忆、有长期分层记忆、有共享事实层，也开始尝试 consolidation；但在检索质量、边界治理、冲突修正和长期稳定性方面，仍处于第一阶段实现。

换句话说：

- **骨架已经不错**
- **检索还偏初级**
- **治理还偏手工**
- **可扩展性潜力很好**

---

## 十一、建议的演进方向

如果后续要把这套系统升级为更成熟的 `Memory v2`，我认为优先级可以是：

### 第一优先级：升级检索

从“纯关键词检索”升级为“混合检索”：

- 关键词检索
- embedding 语义检索
- importance / recency / namespace 共同排序

### 第二优先级：细化记忆类型

除了 layer 外，进一步区分：

- preference
- fact
- task state
- experience
- constraint

这样召回时可以按记忆类型进行更精准的拼装。

### 第三优先级：增强冲突治理

新记忆写入时，不再一律 append，而是进行：

- 相似性检测
- 冲突检查
- 更新或降级旧事实

### 第四优先级：引入时间与时效

将下面这些维度纳入记忆治理：

- recency
- expiration
- lastAccessed
- decay

### 第五优先级：让摘要可追溯

当前 summary 更像最终文本，未来可以考虑保留：

- summary 来源条目列表
- 被摘要历史片段的引用
- 可追溯的压缩元数据

### 第六优先级：制度化 namespace

明确作用域模型，例如：

- `user/*`
- `project/*`
- `agent/*`
- `session/*`

并定义默认的读取顺序、合并顺序和隔离规则。

---

## 十二、结语

Kairo 当前的上下文和记忆设计，已经体现出明显的 Agent Runtime 思路，而不是传统聊天机器人思路。这是它最有价值的地方。

当前系统已经完成了从“只有 prompt”到“有上下文系统”的跃迁，但要继续走向“长期稳定、可解释、可治理的 agent memory”，还需要进一步完善：

- 检索能力
- 记忆边界
- 冲突消解
- 遗忘机制
- 可追溯性

如果把这些能力逐步补齐，这套结构是有潜力成长为一个很强的本地 Agent 记忆内核的。
