import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ScriptTaskRun } from "./script-task.types";

type StreamType = "stdout" | "stderr";

interface BufferState {
  stdoutTail: string;
  stderrTail: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  pendingWrite: Promise<void>;
}

export class ScriptTaskLogBuffer {
  private readonly buffers = new Map<string, BufferState>();

  constructor(
    private readonly baseDir: string = resolve(process.cwd(), "data/async-task/logs"),
    private readonly maxTailChars: number = 4096,
  ) {}

  async initialize(taskId: string, runId: string) {
    const runDir = resolve(this.baseDir, taskId);
    const stdoutLogPath = resolve(runDir, `${runId}.stdout.log`);
    const stderrLogPath = resolve(runDir, `${runId}.stderr.log`);
    await mkdir(runDir, { recursive: true });
    this.buffers.set(runId, {
      stdoutTail: "",
      stderrTail: "",
      stdoutLogPath,
      stderrLogPath,
      pendingWrite: Promise.resolve(),
    });
    return { stdoutLogPath, stderrLogPath };
  }

  async append(runId: string, type: StreamType, chunk: Uint8Array | string) {
    const state = this.buffers.get(runId);
    if (!state) {
      return;
    }
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    state.pendingWrite = state.pendingWrite.then(async () => {
      const logPath = type === "stdout" ? state.stdoutLogPath : state.stderrLogPath;
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, text);

      if (type === "stdout") {
        state.stdoutTail = this.trimTail(state.stdoutTail + text);
      } else {
        state.stderrTail = this.trimTail(state.stderrTail + text);
      }
    });
    await state.pendingWrite;
  }

  snapshot(runId: string): Pick<ScriptTaskRun, "stdoutTail" | "stderrTail" | "stdoutLogPath" | "stderrLogPath"> {
    const state = this.buffers.get(runId);
    if (!state) {
      return {};
    }
    return {
      stdoutTail: state.stdoutTail,
      stderrTail: state.stderrTail,
      stdoutLogPath: state.stdoutLogPath,
      stderrLogPath: state.stderrLogPath,
    };
  }

  close(runId: string) {
    this.buffers.delete(runId);
  }

  async flush(runId: string) {
    const state = this.buffers.get(runId);
    await state?.pendingWrite;
  }

  restore(run: ScriptTaskRun) {
    if (!run.stdoutLogPath || !run.stderrLogPath) {
      return;
    }
    this.buffers.set(run.runId, {
      stdoutTail: run.stdoutTail || "",
      stderrTail: run.stderrTail || "",
      stdoutLogPath: run.stdoutLogPath,
      stderrLogPath: run.stderrLogPath,
      pendingWrite: Promise.resolve(),
    });
  }

  private trimTail(value: string) {
    if (value.length <= this.maxTailChars) {
      return value;
    }
    return value.slice(-this.maxTailChars);
  }
}
