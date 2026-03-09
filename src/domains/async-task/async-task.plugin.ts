import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import type { AgentPlugin } from "../agent";
import type { KernelPlugin } from "../kernel/kernel.plugin";
import { AsyncTaskService } from "./async-task.service";

export class AsyncTaskPlugin implements Plugin {
  name = "async-task";
  private app?: Application;
  private service?: AsyncTaskService;

  setup(app: Application) {
    this.app = app;
    app.registerService("asyncTask", this);
  }

  async start() {
    if (!this.app) return;

    let agent: AgentPlugin;
    try {
      agent = this.app.getService<AgentPlugin>("agent");
    } catch (e) {
      console.warn("[AsyncTask] Agent service not found. Async task tools disabled.");
      return;
    }

    let kernel: KernelPlugin | undefined;
    try {
      kernel = this.app.getService<KernelPlugin>("kernel");
    } catch (e) {
      console.warn("[AsyncTask] Kernel service not found. Process task tools partially disabled.");
    }

    this.service = new AsyncTaskService(agent, kernel, kernel?.stateRepository);
    await this.service.start();
    console.log("[AsyncTask] Async task domain started.");
  }

  async stop() {
    this.service?.stop();
  }
}
