import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { runAcpServer } from '../src/server';

interface CloseCounterHarness {
  harness: KimiHarness;
  closeCalls: () => number;
}

/**
 * Minimal harness stub. Phase 11's shutdown wiring only touches
 * {@link KimiHarness.close}; the other harness surface is exercised in
 * sibling tests (`session-new`, `session-load`, etc.) and is irrelevant
 * here. Each close call increments a counter so we can assert
 * idempotency on signal+natural-close interleavings.
 */
function makeCloseCounterHarness(opts: { throwOnClose?: boolean } = {}): CloseCounterHarness {
  let calls = 0;
  const harness = {
    close: async (): Promise<void> => {
      calls += 1;
      if (opts.throwOnClose) {
        throw new Error('intentional close failure for test');
      }
    },
  } as unknown as KimiHarness;
  return { harness, closeCalls: () => calls };
}

/**
 * Tear off the JSON-RPC connection by ending stdin so
 * `AgentSideConnection.closed` resolves and `runAcpServer` returns.
 * Used by the natural-close test path; the signal-path test forces
 * cleanup BEFORE this end fires.
 */
function endInput(input: PassThrough): void {
  input.end();
}

describe('runAcpServer graceful shutdown', () => {
  it('calls harness.close() exactly once when SIGINT fires before natural close', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    // Drain output so the agent side never backpressures.
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    // Give the connection a tick to start, then fire SIGINT.
    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.emit('SIGINT');

    // The signal-driven cleanup runs synchronously after the tick but
    // doesn't itself end the stream — close the input so the
    // connection actually settles.
    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('calls harness.close() exactly once on natural close (no signal)', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    // Natural close: end stdin immediately.
    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('treats SIGTERM the same as SIGINT and stays idempotent if both fire', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.emit('SIGTERM');
    signals.emit('SIGINT'); // duplicate signal — must NOT call close again

    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    // SIGTERM and SIGINT collapse to a single close call thanks to the
    // `cleanedUp` latch. The natural-close path in `finally` also
    // re-enters `cleanup()` and must be a no-op.
    expect(closeCalls()).toBe(1);
  });

  it('uninstalls listeners even when harness.close() throws', async () => {
    // The process is exiting anyway; the implementation must NOT let a
    // throwing `close()` leak the SIGINT/SIGTERM handlers.
    const { harness, closeCalls } = makeCloseCounterHarness({ throwOnClose: true });
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
