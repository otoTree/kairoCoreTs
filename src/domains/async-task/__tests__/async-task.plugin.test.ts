import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Application } from "../../../core/app";
import { AsyncTaskPlugin } from "../async-task.plugin";

class MockProcessManager extends EventEmitter {
  private statuses = new Map<string, any>();

  async spawn(id: string, _command: string[]) {
    this.statuses.set(id, { state: "running", pid: 1001 });
  }

  getStatus(id: string) {
    return this.statuses.get(id) || { state: "unknown" };
  }

  kill(id: string) {
    this.statuses.set(id, { state: "exited", exitCode: -1 });
    this.emit("exit", { id, code: -1 });
  }
}

describe("AsyncTaskPlugin", () => {
  let app: Application;
  let plugin: AsyncTaskPlugin;
  let tools: Map<string, (args: any, context: any) => Promise<any>>;
  let processManager: MockProcessManager;
  let delegateTask: ReturnType<typeof mock>;
  let stateRepo: {
    save: ReturnType<typeof mock>;
    getByPrefix: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    app = new Application();
    plugin = new AsyncTaskPlugin();
    tools = new Map();
    processManager = new MockProcessManager();
    delegateTask = mock(async () => "delegated_task_1");
    stateRepo = {
      save: mock(async () => undefined),
      getByPrefix: mock(async () => []),
    };

    const agent = {
      registerSystemTool: (definition: any, handler: any) => {
        tools.set(definition.name, handler);
      },
      globalBus: {
        publish: async (_event: any) => "event_1",
      },
      capabilityRegistry: {
        findBestAgent: () => undefined,
      },
      delegateTask,
    };

    const kernel = {
      processManager,
      stateRepository: stateRepo,
    };

    app.registerService("agent", agent);
    app.registerService("kernel", kernel);
    plugin.setup(app);
    await plugin.start();
  });

  afterEach(async () => {
    await plugin.stop();
  });

  it("调度任务会在到期后派发给目标 Agent", async () => {
    const schedule = tools.get("kairo_async_schedule");
    const list = tools.get("kairo_async_tasks_list");
    expect(schedule).toBeDefined();
    expect(list).toBeDefined();

    const result = await schedule!(
      { description: "稍后执行", delayMs: 20 },
      { agentId: "default" },
    );
    expect(result.status).toBe("scheduled");

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(delegateTask).toHaveBeenCalledTimes(1);

    const tasks = await list!({}, { agentId: "default" });
    expect(tasks.scheduled.length).toBe(1);
    expect(tasks.scheduled[0].status).toBe("dispatched");
    expect(stateRepo.save).toHaveBeenCalled();
  });

  it("周期任务会自动重新调度下一次执行", async () => {
    const schedule = tools.get("kairo_async_schedule");
    const list = tools.get("kairo_async_tasks_list");
    expect(schedule).toBeDefined();
    expect(list).toBeDefined();

    await schedule!(
      {
        description: "周期执行",
        delayMs: 10,
        repeat: { intervalMs: 20 },
      },
      { agentId: "default" },
    );

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(delegateTask.mock.calls.length).toBeGreaterThanOrEqual(2);

    const tasks = await list!({}, { agentId: "default" });
    expect(tasks.scheduled.length).toBe(1);
    expect(tasks.scheduled[0].status).toBe("scheduled");
    expect(tasks.scheduled[0].runCount).toBeGreaterThanOrEqual(2);
  });

  it("后台进程任务支持启动和状态追踪", async () => {
    const start = tools.get("kairo_async_process_start");
    const status = tools.get("kairo_async_process_status");
    expect(start).toBeDefined();
    expect(status).toBeDefined();

    const started = await start!(
      { processId: "proc_test_1", command: "sleep", args: ["1"] },
      { agentId: "default" },
    );
    expect(started.status).toBe("running");

    const running = await status!({ processId: "proc_test_1" }, { agentId: "default" });
    expect(running.runtime.state).toBe("running");
    expect(running.tracked.status).toBe("running");

    processManager.emit("exit", { id: "proc_test_1", code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const exited = await status!({ processId: "proc_test_1" }, { agentId: "default" });
    expect(exited.tracked.status).toBe("exited");
    expect(exited.tracked.exitCode).toBe(0);
  });
});
