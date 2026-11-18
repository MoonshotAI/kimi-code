import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Component, TUI } from '@moonshot-ai/pi-tui';

const MAX_SAMPLES = 500;

export interface LatencySample {
  latency: number;
  at: string;
}

export class LatencyStats {
  last = 0;
  events = 0;
  over100 = 0;
  over300 = 0;
  over1000 = 0;
  readonly worst: LatencySample[] = [];
  private readonly samples: number[] = [];

  record(latency: number, at: string): void {
    this.last = latency;
    this.events++;
    if (latency > 100) this.over100++;
    if (latency > 300) this.over300++;
    if (latency > 1000) this.over1000++;
    this.samples.push(latency);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    const smallestKept = this.worst[this.worst.length - 1]?.latency ?? -1;
    if (this.worst.length < 5 || latency >= smallestKept) {
      this.worst.push({ latency, at });
      this.worst.sort((a, b) => b.latency - a.latency);
      if (this.worst.length > 5) this.worst.length = 5;
    }
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  }

  max(): number {
    return this.samples.length === 0 ? 0 : Math.max(...this.samples);
  }

  formatLines(): string[] {
    if (this.events === 0) return [' input→render: (type something) '];
    const head =
      ` io ${this.last.toFixed(0)}ms | p50 ${this.percentile(50).toFixed(0)} p95 ${this.percentile(95).toFixed(0)}` +
      ` p99 ${this.percentile(99).toFixed(0)} max ${this.max().toFixed(0)}ms | n=${this.events}` +
      ` >100:${this.over100} >300:${this.over300} >1s:${this.over1000} `;
    const worstLine = ` worst: ${this.worst.map((w) => `${w.latency.toFixed(0)}ms@${w.at}`).join('  ')} `;
    return [head, worstLine];
  }
}

export function installInputLatencyProbe(tui: TUI): void {
  const stats = new LatencyStats();
  const pending: number[] = [];
  const logPath = process.env['KIMI_TUI_INPUT_LATENCY_LOG'];
  if (logPath) mkdirSync(path.dirname(logPath), { recursive: true });

  tui.addInputListener(() => {
    pending.push(performance.now());
    return undefined;
  });

  const overlay: Component = {
    invalidate: () => {},
    render: () => {
      if (pending.length > 0) {
        const now = performance.now();
        const at = new Date().toISOString().slice(11, 23);
        for (const t of pending.splice(0)) {
          const latency = now - t;
          stats.record(latency, at);
          if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), latencyMs: Math.round(latency) })}\n`);
        }
      }
      return stats.formatLines();
    },
  };
  tui.showOverlay(overlay, { nonCapturing: true, anchor: 'top-right', margin: 0 });
}
