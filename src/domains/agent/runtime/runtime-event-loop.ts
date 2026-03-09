import type { KairoEvent } from "../../events";

export interface RuntimeEventLoopDeps {
  maxEventBuffer: number;
  isRunning: () => boolean;
  onTick: (events: KairoEvent[]) => Promise<void>;
  onError: (error: unknown) => void;
  setTraceContext: (context: { traceId: string; spanId: string } | undefined) => void;
  createTraceContext: (trigger: KairoEvent | undefined) => { traceId: string; spanId: string };
  consumeAutoContinueReason: () => string | null;
  publishAutoContinue: (reason: string) => void;
  log: (message: string) => void;
}

export class RuntimeEventLoop {
  private eventBuffer: KairoEvent[] = [];
  private tickLock: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RuntimeEventLoopDeps) {}

  enqueue(event: KairoEvent) {
    if (!this.deps.isRunning()) return;
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.deps.maxEventBuffer) {
      this.eventBuffer = this.eventBuffer.slice(-this.deps.maxEventBuffer);
    }
    this.tickLock = this.tickLock.then(() => this.processTick());
  }

  private async processTick() {
    if (!this.deps.isRunning()) return;
    try {
      const eventsToProcess = [...this.eventBuffer];
      this.eventBuffer = [];
      if (eventsToProcess.length > 0) {
        const trigger = eventsToProcess[eventsToProcess.length - 1];
        this.deps.setTraceContext(this.deps.createTraceContext(trigger));
        try {
          await this.deps.onTick(eventsToProcess);
        } finally {
          this.deps.setTraceContext(undefined);
        }
      }
    } catch (error) {
      this.deps.onError(error);
    } finally {
      const continueReason = this.deps.consumeAutoContinueReason();
      if (continueReason) {
        this.deps.log("Auto-continuing after say action...");
        setTimeout(() => {
          if (this.deps.isRunning()) {
            this.deps.publishAutoContinue(continueReason);
          }
        }, 0);
      }
    }
  }
}
