import { describe, expect, it, vi } from 'vitest';

import { ExecBridge } from '#/remote/client/execBridge';

describe('ExecBridge disconnect guards', () => {
  it('survives writes after the spawned child exits — no uncaught EPIPE', async () => {
    const bridge = ExecBridge.spawn({
      program: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    const onEnd = vi.fn();
    bridge.onEnd(onEnd);
    await bridge.exited;

    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.write(new Uint8Array([1, 2, 3]));
    bridge.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEnd).toHaveBeenCalled();
  });
});

describe('ExecBridge spawn environment', () => {
  async function captureStdout(bridge: ExecBridge): Promise<string> {
    let out = '';
    bridge.onData((chunk) => {
      out += Buffer.from(chunk).toString('utf8');
    });
    await Promise.all([bridge.exited, new Promise<void>((resolve) => bridge.onEnd(resolve))]);
    return out;
  }

  it('uses options.env verbatim instead of merging the host environment', async () => {
    vi.stubEnv('REMOTE_EXEC_TEST_HOST_ONLY', 'host-secret');
    try {
      const bridge = ExecBridge.spawn({
        program: process.execPath,
        args: ['-e', 'process.stdout.write(process.env["REMOTE_EXEC_TEST_HOST_ONLY"] ?? "<absent>")'],
        env: { PATH: process.env['PATH'] ?? '' },
      });
      expect(await captureStdout(bridge)).toBe('<absent>');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('ExecBridge shutdown', () => {
  it('waits for EOF cleanup without interrupting the executor', async () => {
    const bridge = ExecBridge.spawn({
      program: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => process.exit(2)); process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.exit(0), 800)); process.stdout.write("ready")'],
    });
    await new Promise<void>((resolve) => {
      bridge.onData(() => { resolve(); });
    });
    bridge.close();
    bridge.close();
    expect(await bridge.exited).toMatchObject({ code: 0, signal: null });
  });

  it('force-kills a launcher that ignores EOF and TERM', async () => {
    const bridge = ExecBridge.spawn({
      program: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write("ready")'],
    });
    await new Promise<void>((resolve) => {
      bridge.onData(() => { resolve(); });
    });
    bridge.close();
    expect(await bridge.exited).toMatchObject({ signal: 'SIGKILL' });
  });
});
