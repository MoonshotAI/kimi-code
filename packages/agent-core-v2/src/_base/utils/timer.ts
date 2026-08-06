/**
 * Repeating timer primitive — a disposable `setInterval` wrapper.
 *
 * `IntervalTimer` owns a single `setInterval` handle: `cancelAndSet` (re)starts
 * the loop (cancelling any previous handle first), `cancel` stops it, and
 * `dispose` guarantees the handle is cleared — so it can be `_register`-ed on a
 * `Disposable` owner and cleaned up for free. One instance is reused across
 * start/stop cycles instead of juggling raw `ReturnType<typeof setInterval>`
 * values. Mirrors VS Code's `IntervalTimer`.
 *
 * `setClampedTimeout` is a `setTimeout` whose delay is clamped to
 * `MAX_TIMER_DELAY_MS`, the largest delay the host timer accepts: beyond it
 * the delay overflows into an immediate (~1ms) fire, so huge ("effectively
 * unbounded") timeouts would fire at once instead of waiting. Callers that
 * outlive the clamp (~24.8 days) re-arm.
 */

import type { IDisposable } from '#/_base/di/lifecycle';

export const MAX_TIMER_DELAY_MS = 0x7fffffff;

export function setClampedTimeout(
  callback: () => void,
  timeoutMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
}

export interface IntervalTimerOptions {
  readonly unref?: boolean;
}

export class IntervalTimer implements IDisposable {
  private handle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: IntervalTimerOptions = {}) {}

  cancel(): void {
    if (this.handle !== undefined) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  cancelAndSet(runner: () => void, intervalMs: number): void {
    this.cancel();
    const handle = setInterval(runner, intervalMs);
    if (
      this.options.unref === true &&
      typeof handle === 'object' &&
      handle !== null &&
      'unref' in handle
    ) {
      (handle as { unref: () => void }).unref();
    }
    this.handle = handle;
  }

  isSet(): boolean {
    return this.handle !== undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

export class TimeoutTimer implements IDisposable {
  private handle: ReturnType<typeof setTimeout> | undefined;

  cancel(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  cancelAndSet(runner: () => void, timeoutMs: number): void {
    this.cancel();
    const handle = setTimeout(() => {
      this.handle = undefined;
      runner();
    }, timeoutMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    this.handle = handle;
  }

  dispose(): void {
    this.cancel();
  }
}
