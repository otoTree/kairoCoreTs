import type { AgentPlugin } from "../agent";
import type { ScriptTask, ScriptTaskReportPayload, ScriptTaskRun } from "./script-task.types";

export class ScriptTaskReporter {
  constructor(private readonly agent: AgentPlugin) {}

  async reportCompletion(task: ScriptTask, run: ScriptTaskRun) {
    if (!run.endedAt || !run.durationMs) {
      return;
    }
    const status = run.status;
    const reportPolicy = task.reportPolicy || {};
    if (status === "succeeded" && reportPolicy.onSuccess === false) {
      return;
    }
    if ((status === "failed" || status === "cancelled") && reportPolicy.onFailure === false) {
      return;
    }

    const payload: ScriptTaskReportPayload = {
      taskId: task.taskId,
      runId: run.runId,
      processId: run.processId,
      ownerAgentId: task.ownerAgentId,
      reportToAgentId: task.reportToAgentId,
      description: task.description,
      status,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      command: task.command,
      args: task.args,
      cwd: task.cwd,
      stdoutTail: reportPolicy.includeOutputSummary === false ? undefined : run.stdoutTail,
      stderrTail: reportPolicy.includeOutputSummary === false ? undefined : run.stderrTail,
      stdoutLogPath: reportPolicy.includeLogPaths === false ? undefined : run.stdoutLogPath,
      stderrLogPath: reportPolicy.includeLogPaths === false ? undefined : run.stderrLogPath,
      artifacts: task.artifacts,
      nextExecuteAt: task.nextExecuteAt,
    };

    await this.agent.globalBus.publish({
      type: "kairo.async.script.completed",
      source: "domain:async-task",
      data: payload,
    });

    await this.agent.globalBus.publish({
      type: `kairo.agent.${task.reportToAgentId}.message`,
      source: "async-task",
      data: {
        content: this.buildContent(task, run),
        structured: {
          kind: "script_task_report",
          ...payload,
        },
      },
    });

    if (reportPolicy.triggerFollowupAgentTask) {
      const description = this.buildFollowupDescription(task, run);
      await this.agent.delegateTask(task.ownerAgentId, task.reportToAgentId, { description });
    }
  }

  private buildContent(task: ScriptTask, run: ScriptTaskRun) {
    const duration = run.durationMs ? `${run.durationMs}ms` : "unknown";
    if (run.status === "succeeded") {
      return [
        `[脚本任务完成] 任务 ${task.taskId} 执行成功，exitCode=${run.exitCode ?? 0}，耗时 ${duration}。`,
        `脚本：${[task.command, ...(task.args || [])].join(" ")}`,
        task.artifacts?.outputPaths?.length ? `产物：${task.artifacts.outputPaths.join(", ")}` : undefined,
      ].filter(Boolean).join("\n");
    }
    return [
      `[脚本任务失败] 任务 ${task.taskId} 执行结束，状态 ${run.status}，exitCode=${run.exitCode ?? -1}，耗时 ${duration}。`,
      run.stderrTail ? `stderr 摘要：${run.stderrTail}` : undefined,
      run.error ? `错误：${run.error}` : undefined,
    ].filter(Boolean).join("\n");
  }

  private buildFollowupDescription(task: ScriptTask, run: ScriptTaskRun) {
    const template = task.reportPolicy?.followupDescriptionTemplate;
    if (template) {
      return template
        .replaceAll("${description}", task.description)
        .replaceAll("${status}", run.status)
        .replaceAll("${taskId}", task.taskId)
        .replaceAll("${runId}", run.runId);
    }
    return [
      `脚本任务“${task.description}”已结束，状态为 ${run.status}。`,
      "请根据 stdout/stderr 摘要、日志路径和产物路径检查执行结果，并生成结论。",
    ].join("");
  }
}
