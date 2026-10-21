import { WebSocket as WsWebSocket } from 'ws';

import { recordReportEvent } from './report.js';

export interface AnyFrame {
  readonly type: string;
  readonly seq?: number;
  readonly session_id?: string;
  readonly timestamp?: string;
  readonly id?: string;
  readonly code?: number;
  readonly msg?: string;
  readonly payload?: unknown;
}

export interface WsClientOptions {
  url: string;
  wsImpl: typeof WsWebSocket;
  logger: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: unknown) => void;
  reportDir?: string;
}

type FrameWaiter = (frame: AnyFrame) => boolean;

interface PendingWaiter {
  match: FrameWaiter;
  resolve: (frame: AnyFrame) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class WsClient {
  private ws: WsWebSocket | null = null;
  private readonly _queue: AnyFrame[] = [];
  private readonly _waiters: PendingWaiter[] = [];
  private readonly _subscribers = new Set<(f: AnyFrame) => void>();
  private _closed = false;
  private _closeReason: { code: number; reason: string } | null = null;
  private _closeWaiters: Array<(v: { code: number; reason: string }) => void> = [];

  constructor(private readonly opts: WsClientOptions) {}

  async open(): Promise<void> {
    if (this.ws) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new this.opts.wsImpl(this.opts.url);
      this.ws = ws;
      ws.once('open', () => {
        recordReportEvent(
          { kind: 'ws', direction: 'lifecycle', url: this.opts.url, message: 'open' },
          { reportDir: this.opts.reportDir },
        );
        resolve();
      });
      ws.once('error', (err) => {
        if (this._closed) return;
        recordReportEvent(
          {
            kind: 'ws',
            direction: 'lifecycle',
            url: this.opts.url,
            message: 'error',
            error: errorForReport(err),
          },
          { reportDir: this.opts.reportDir },
        );
        reject(err as Error);
      });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', (code, reason) => this._onClose(code, String(reason ?? '')));
    });
  }

  send(frame: object): void {
    if (!this.ws) throw new Error('ws not open');
    this.ws.send(JSON.stringify(frame));
    recordReportEvent(
      { kind: 'ws', direction: 'out', url: this.opts.url, frame },
      { reportDir: this.opts.reportDir },
    );
  }

  onFrame(handler: (f: AnyFrame) => void): () => void {
    this._subscribers.add(handler);
    return () => {
      this._subscribers.delete(handler);
    };
  }

  waitForFrame(predicate: FrameWaiter, timeoutMs: number): Promise<AnyFrame> {
    return new Promise((resolve, reject) => {
      for (let i = 0; i < this._queue.length; i++) {
        const frame = this._queue[i];
        if (frame === undefined) continue;
        if (predicate(frame)) {
          this._queue.splice(i, 1);
          resolve(frame);
          return;
        }
      }
      if (this._closed) {
        reject(new Error(`ws closed before matching frame arrived (code=${this._closeReason?.code})`));
        return;
      }
      const waiter: PendingWaiter = {
        match: predicate,
        resolve: (f) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(f);
        },
        reject: (e) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(e);
        },
      };
      waiter.timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(`waitForFrame timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiter.timer.unref?.();
      this._waiters.push(waiter);
    });
  }

  async sendAndAwaitAck(frame: { type: string; id: string; payload: unknown }, timeoutMs: number): Promise<AnyFrame> {
    this.send(frame);
    return this.waitForFrame(
      (f) => f.type === 'ack' && f.id === frame.id,
      timeoutMs,
    );
  }

  closed(): Promise<{ code: number; reason: string }> {
    if (this._closeReason) return Promise.resolve(this._closeReason);
    return new Promise((resolve) => {
      this._closeWaiters.push(resolve);
    });
  }

  async close(): Promise<void> {
    if (!this.ws || this._closed) return;
    this.ws.close();
    await this.closed();
  }

  private _onMessage(data: unknown): void {
    let frame: AnyFrame;
    try {
      const raw = typeof data === 'string' ? data : String(data);
      frame = JSON.parse(raw) as AnyFrame;
    } catch (err) {
      this.opts.logger('warn', 'ws: dropped non-JSON frame', { err: String(err) });
      recordReportEvent(
        {
          kind: 'ws',
          direction: 'in',
          url: this.opts.url,
          message: 'dropped non-JSON frame',
          error: errorForReport(err),
        },
        { reportDir: this.opts.reportDir },
      );
      return;
    }
    recordReportEvent(
      { kind: 'ws', direction: 'in', url: this.opts.url, frame },
      { reportDir: this.opts.reportDir },
    );

    if (frame.type === 'ping') {
      this.send({ type: 'pong', payload: { nonce: pingNonce(frame) } });
    }

    for (const sub of this._subscribers) {
      try {
        sub(frame);
      } catch (err) {
        this.opts.logger('warn', 'ws: subscriber threw', { err: String(err) });
      }
    }

    for (let i = 0; i < this._waiters.length; i++) {
      const w = this._waiters[i];
      if (w === undefined) continue;
      let matches = false;
      try {
        matches = w.match(frame);
      } catch (err) {
        this.opts.logger('warn', 'ws: waiter predicate threw', { err: String(err) });
      }
      if (matches) {
        this._waiters.splice(i, 1);
        w.resolve(frame);
        return;
      }
    }
    this._queue.push(frame);
  }

  private _onClose(code: number, reason: string): void {
    this._closed = true;
    this._closeReason = { code, reason };
    recordReportEvent(
      {
        kind: 'ws',
        direction: 'lifecycle',
        url: this.opts.url,
        message: 'close',
        frame: { code, reason },
      },
      { reportDir: this.opts.reportDir },
    );
    for (const w of this._waiters.splice(0)) {
      w.reject(new Error(`ws closed (code=${code}) before matching frame arrived`));
    }
    for (const w of this._closeWaiters.splice(0)) w(this._closeReason);
  }
}

function pingNonce(frame: AnyFrame): string {
  const payload = frame.payload as { nonce?: unknown } | undefined;
  return typeof payload?.nonce === 'string' ? payload.nonce : '';
}

function errorForReport(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return error;
}
