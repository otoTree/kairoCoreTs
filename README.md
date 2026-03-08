# Kairo Core (TypeScript)

Kairo Core 是一个基于 Bun + TypeScript 的插件化智能体运行时，整合了 AI、沙箱执行、MCP、设备管理、记忆系统、事件总线与 WebSocket 服务能力。

## 功能概览

- 插件化内核：通过统一生命周期管理各个领域插件
- Agent 运行时：支持事件驱动的思考/行动流转
- AI 能力：默认接入 OpenAI 兼容接口（可配置为 DeepSeek 等）
- 沙箱执行：提供跨平台沙箱与受控执行能力
- MCP 集成：可自动扫描并注册本地 MCP 服务
- 设备能力：支持设备注册、驱动与协议管理
- 记忆与 Vault：支持记忆存储与敏感信息能力
- HTTP + WebSocket 服务：用于前端或外部客户端接入

## 技术栈

- 运行时：Bun
- 语言：TypeScript（ESM）
- Web 框架：Hono
- 数据层：Kysely + SQLite（kysely-bun-sqlite）
- 校验：Zod

## 目录结构

```text
src/
  core/                # 核心应用与插件接口
  domains/             # 各领域插件（agent/ai/kernel/mcp/sandbox 等）
  index.ts             # 应用启动入口
```

## 快速开始

### 1) 安装依赖

```bash
bun install
```

### 2) 配置环境变量

```bash
cp .env.example .env
```

至少建议配置以下变量：

- `OPENAI_API_KEY`：AI Provider 密钥
- `KAIRO_TOKEN`：WebSocket 鉴权 token（未配置时会自动生成临时 token）
- `PORT`：服务端口（默认 `3000`）

### 3) 启动开发模式

```bash
bun run dev
```

服务启动后默认监听：

- HTTP: `http://localhost:3000`
- WebSocket: `ws://localhost:3000/ws?token=<KAIRO_TOKEN>`

## Docker 运行

```bash
docker compose up --build
```

默认会将以下目录挂载到容器内：

- `./workspace`
- `./deliverables`
- `./memory`
- `./data/memory`
- `./.run`

## 常用脚本

```bash
# 开发（watch）
bun run dev

# 测试
bun run test

# 代码检查
bun run lint

# 代码格式化
bun run format
```

## 环境变量说明（节选）

完整变量见 `.env.example`。

- `OPENAI_API_KEY`：OpenAI 兼容 API Key
- `OPENAI_BASE_URL`：OpenAI 兼容接口地址
- `OPENAI_MODEL_NAME`：默认聊天模型
- `PYTHON_ENV_PATH`：Python 环境目录
- `KAIRO_RUNTIME_DIR`：运行时目录
- `KAIRO_IPC_SOCKET`：Kernel IPC Socket 路径
- `KAIRO_WS_TOKEN_FILE`：WebSocket Token 文件路径
- `SQLITE_DB_PATH`：SQLite 数据库文件路径
- `KAIRO_CORS_ORIGINS`：允许跨域来源列表

## 飞书渠道配置

- 详见 `docs/feishu-channel-setup.md`

## 插件启动顺序（入口）

入口位于 `src/index.ts`，启动时会依次注册并启动：

- `DatabasePlugin`
- `HealthPlugin`
- `SandboxPlugin`
- `AIPlugin`
- `MemoryPlugin`
- `VaultPlugin`
- `MCPPlugin`
- `AgentPlugin`
- `KernelPlugin`
- `DevicePlugin`
- `SkillsPlugin`
- `ObservabilityPlugin`
- `CompositorPlugin`
- `ServerPlugin`
- `ChannelsPlugin`

## 相关说明

- 沙箱模块有独立文档：`src/domains/sandbox/README.md`
- 项目默认使用 SQLite 本地文件存储
