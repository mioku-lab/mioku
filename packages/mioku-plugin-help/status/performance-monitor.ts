import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

/**
 * Captures Node event-loop delay and (best-effort) GC events.
 *
 * `monitorEventLoopDelay` returns a histogram that must be `reset()` after
 * each read; otherwise values accumulate forever. The GC observer requires
 * Node to be started with `--expose-gc`, otherwise the `gc` entry type is
 * unavailable and we degrade gracefully.
 */
class PerfMonitor {
  private loopHist: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private lastSnapshot: { mean: number; p99: number } = { mean: 0, p99: 0 };
  private gcCount = 0;
  private lastGCDurationMs = 0;
  private readTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.loopHist) {
      return;
    }
    try {
      this.loopHist = monitorEventLoopDelay({ resolution: 20 });
      this.loopHist.enable();
      this.readTimer = setInterval(() => {
        if (!this.loopHist) {
          return;
        }
        // nanoseconds → milliseconds
        this.lastSnapshot = {
          mean: this.loopHist.mean / 1e6,
          p99: this.loopHist.percentile(99) / 1e6,
        };
        this.loopHist.reset();
      }, 1000);
      if (typeof this.readTimer.unref === "function") {
        this.readTimer.unref();
      }
    } catch {
      this.loopHist = null;
    }

    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcCount += 1;
          this.lastGCDurationMs = entry.duration;
        }
      });
      this.gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      this.gcObserver = null;
    }
  }

  stop(): void {
    if (this.readTimer) {
      clearInterval(this.readTimer);
      this.readTimer = null;
    }
    if (this.loopHist) {
      try {
        this.loopHist.disable();
      } catch {
        // ignore
      }
      this.loopHist = null;
    }
    if (this.gcObserver) {
      try {
        this.gcObserver.disconnect();
      } catch {
        // ignore
      }
      this.gcObserver = null;
    }
  }

  isRunning(): boolean {
    return this.loopHist !== null;
  }

  getEventLoop(): { mean: number; p99: number } {
    return this.lastSnapshot;
  }

  getGC():
    | { available: boolean; count: number; lastDurationMs?: number }
    | null {
    if (!this.gcObserver) {
      return { available: false, count: 0 };
    }
    return {
      available: true,
      count: this.gcCount,
      lastDurationMs: this.lastGCDurationMs,
    };
  }
}

export const perfMonitor = new PerfMonitor();
