import { systemInfo } from "mioki";
import type { NetworkSample } from "./types";

/**
 * Background sampler for network throughput.
 *
 * Polls `systeminformation.networkStats()` at a fixed interval, sums the
 * `rx_sec` / `tx_sec` of all interfaces, and stores the result in a ring
 * buffer. The first sample is always discarded because macOS reports all
 * zeros on the first call.
 */
class NetworkSampler {
  private rxBpsRing: number[] = [];
  private txBpsRing: number[] = [];
  private tsRing: number[] = [];
  private rxTotalBytes = 0;
  private txTotalBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = 5000;
  private maxSamples = 360;
  private lastSampleAt: number | null = null;
  private lastRxPerSec = 0;
  private lastTxPerSec = 0;

  start(intervalMs = 5000, maxSamples = 360): void {
    if (this.timer) {
      return;
    }
    this.intervalMs = intervalMs;
    this.maxSamples = maxSamples;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (typeof this.timer?.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getLastSpeeds(): { rxBps: number; txBps: number } {
    return { rxBps: this.lastRxPerSec, txBps: this.lastTxPerSec };
  }

  getTotals(): { rxBytes: number; txBytes: number } {
    return { rxBytes: this.rxTotalBytes, txBytes: this.txTotalBytes };
  }

  getRecentSeries(windowMs: number): NetworkSample[] {
    const cutoff = Date.now() - windowMs;
    const result: NetworkSample[] = [];
    for (let i = 0; i < this.tsRing.length; i++) {
      const ts = this.tsRing[i] ?? 0;
      if (ts >= cutoff) {
        result.push({
          ts,
          rxBps: this.rxBpsRing[i] ?? 0,
          txBps: this.txBpsRing[i] ?? 0,
        });
      }
    }
    return result;
  }

  private async tick(): Promise<void> {
    try {
      const stats = await systemInfo.networkStats();
      if (!Array.isArray(stats) || stats.length === 0) {
        return;
      }
      let rxPerSec = 0;
      let txPerSec = 0;
      let rxBytes = 0;
      let txBytes = 0;
      for (const iface of stats) {
        rxPerSec += Number(iface?.rx_sec || 0);
        txPerSec += Number(iface?.tx_sec || 0);
        rxBytes += Number(iface?.rx_bytes || 0);
        txBytes += Number(iface?.tx_bytes || 0);
      }
      const now = Date.now();
      // macOS returns all zeros on the first call after process start. Drop
      // the first sample to avoid a giant spike in the chart.
      if (this.lastSampleAt === null) {
        this.lastSampleAt = now;
        this.lastRxPerSec = rxPerSec;
        this.lastTxPerSec = txPerSec;
        this.rxTotalBytes = rxBytes;
        this.txTotalBytes = txBytes;
        this.pushSample(now, rxPerSec, txPerSec);
        return;
      }
      const deltaSec = Math.max(0.001, (now - this.lastSampleAt) / 1000);
      // Accumulate bytes based on per-second rates to avoid double-counting
      // the `rx_bytes` field on systems where it resets on interface bounce.
      this.rxTotalBytes += rxPerSec * deltaSec;
      this.txTotalBytes += txPerSec * deltaSec;
      this.lastSampleAt = now;
      this.lastRxPerSec = rxPerSec;
      this.lastTxPerSec = txPerSec;
      this.pushSample(now, rxPerSec, txPerSec);
    } catch {
      // Ignore transient errors; sampler continues.
    }
  }

  private pushSample(ts: number, rxBps: number, txBps: number): void {
    this.tsRing.push(ts);
    this.rxBpsRing.push(rxBps);
    this.txBpsRing.push(txBps);
    if (this.tsRing.length > this.maxSamples) {
      this.tsRing.shift();
      this.rxBpsRing.shift();
      this.txBpsRing.shift();
    }
  }
}

export const networkSampler = new NetworkSampler();
