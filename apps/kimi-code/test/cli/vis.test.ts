/**
 * `kimi vis`
 *
 * Verifies the CLI layer for the session visualizer: home + auto-port
 * resolution, browser open vs `--no-open`, and the session deep-link path.
 * Uses injected deps so no real port is bound and the real vis server is
 * never started.
 */

import { describe, it, expect, vi } from 'vitest';

import { handleVis, type VisDeps } from '#/cli/sub/vis';

function makeDeps(over: Partial<VisDeps> = {}): {
  deps: VisDeps;
  opened: string[];
  out: string[];
} {
  const opened: string[] = [];
  const out: string[] = [];
  const deps: VisDeps = {
    getHomeDir: () => '/home/k',
    startVisServer: vi.fn(async (o) => ({
      port: 41234,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:41234/',
      close: async () => {},
      _opts: o,
    })) as unknown as VisDeps['startVisServer'],
    openUrl: async (u: string) => {
      opened.push(u);
    },
    waitForShutdown: async () => {},
    stdout: {
      write: (s: string) => {
        out.push(s);
        return true;
      },
    },
    stderr: { write: () => true },
    exit: vi.fn() as unknown as VisDeps['exit'],
    ...over,
  };
  return { deps, opened, out };
}

describe('handleVis', () => {
  it('starts the server with the home dir + auto port and opens the browser', async () => {
    const { deps, opened, out } = makeDeps();
    await handleVis(deps, { open: true });
    expect(deps.startVisServer).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/home/k', port: 0 }),
    );
    expect(opened).toEqual(['http://127.0.0.1:41234/']);
    expect(out.join('')).toContain('http://127.0.0.1:41234/');
  });

  it('does not open the browser when open is false', async () => {
    const { deps, opened } = makeDeps();
    await handleVis(deps, { open: false });
    expect(opened).toEqual([]);
  });

  it('deep-links to a session when sessionId is given', async () => {
    const { deps, opened } = makeDeps();
    await handleVis(deps, { open: true, sessionId: 'sess_abc' });
    expect(opened[0]).toBe('http://127.0.0.1:41234/sessions/sess_abc');
  });

  it('uses the explicit port when provided', async () => {
    const { deps } = makeDeps();
    await handleVis(deps, { open: false, port: 4321 });
    expect(deps.startVisServer).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/home/k', port: 4321 }),
    );
  });

  it('closes the server after shutdown', async () => {
    const close = vi.fn(async () => {});
    const { deps } = makeDeps({
      startVisServer: vi.fn(async () => ({
        port: 41234,
        host: '127.0.0.1',
        url: 'http://127.0.0.1:41234/',
        close,
      })) as unknown as VisDeps['startVisServer'],
    });
    await handleVis(deps, { open: false });
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a clean error and exits when the server fails to start', async () => {
    const errored: string[] = [];
    const { deps, opened } = makeDeps({
      startVisServer: vi.fn(async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:4321');
      }) as unknown as VisDeps['startVisServer'],
      stderr: {
        write: (s: string) => {
          errored.push(s);
          return true;
        },
      },
      waitForShutdown: vi.fn(async () => {}),
    });
    await handleVis(deps, { open: true, port: 4321 });
    expect(errored.join('')).toContain('Failed to start kimi vis');
    expect(errored.join('')).toContain('EADDRINUSE');
    expect(deps.exit).toHaveBeenCalledWith(1);
    // Nothing past the failed start should run.
    expect(opened).toEqual([]);
    expect(deps.waitForShutdown).not.toHaveBeenCalled();
  });
});
