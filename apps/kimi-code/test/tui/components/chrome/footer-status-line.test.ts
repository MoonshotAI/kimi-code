import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  STATUS_LINE_COMMAND_TIMEOUT_MS,
  STATUS_LINE_MAX_CAPTURE_BYTES,
  STATUS_LINE_RERUN_INTERVAL_MS,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import type { AppState } from '#/tui/types';

const baseState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  stepRetry: null,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  towerMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

const payload: StatusLinePayload = {
  model: 'kimi-k2',
  cwd: '/tmp/project',
  gitBranch: 'main',
  permissionMode: 'manual',
  planMode: false,
  contextUsage: 12,
  contextTokens: 1024,
  maxContextTokens: 8192,
  sessionId: 'ses-1',
  version: '1.2.3',
};

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('FooterComponent status_line items', () => {
  it('renders only the chosen slots in the given order', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['cwd', 'model'], command: null },
    };
    const footer = new FooterComponent(state);

    const line1 = plain(footer.render(120)[0]!);
    const cwdAt = line1.indexOf('/tmp/project');
    const modelAt = line1.indexOf('kimi-k2');
    expect(cwdAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThan(cwdAt);
    expect(line1).not.toContain('goal');
  });

  it('keeps the default layout when statusLine is unset', () => {
    const footer = new FooterComponent({ ...baseState });

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('kimi-k2');
    expect(line1).toContain('/tmp/project');
  });

  it('drops the rotating tips when tips is not in items', () => {
    const withTips = plain(new FooterComponent(baseState).render(200)[0]!);
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['model', 'cwd'], command: null },
    };
    const withoutTips = plain(new FooterComponent(state).render(200)[0]!);

    expect(withoutTips.length).toBeLessThan(withTips.length);
    expect(withoutTips.trimEnd()).toMatch(/kimi-k2 {2}\/tmp\/project$/);
  });

  it('honors the configured position of the tips slot', () => {
    // The tip content itself rotates; locate it via a tips-only render.
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[0]!,
    ).trim();

    const tipsFirst = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips', 'model'], command: null },
      }).render(200)[0]!,
    );
    const tipsLast = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['model', 'tips'], command: null },
      }).render(200)[0]!,
    );

    expect(tipsOnly.length).toBeGreaterThan(0);
    expect(tipsFirst.indexOf(tipsOnly)).toBeLessThan(tipsFirst.indexOf('kimi-k2'));
    expect(tipsLast.indexOf('kimi-k2')).toBeLessThan(tipsLast.indexOf(tipsOnly));
  });

  it('renders nothing on line 1 for an empty items list', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: [], command: null },
    };
    const footer = new FooterComponent(state);

    expect(plain(footer.render(120)[0]!).trim()).toBe('');
  });
});

describe('runStatusLineCommand', () => {
  it('passes the payload as JSON on stdin and returns the first stdout line', async () => {
    const line = await runStatusLineCommand('cat', payload);

    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!);
    expect(parsed.model).toBe('kimi-k2');
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.cwd).toBe('/tmp/project');
  });

  it('returns null on a nonzero exit', async () => {
    expect(await runStatusLineCommand('exit 3', payload)).toBeNull();
  });

  it('returns null on empty output', async () => {
    expect(await runStatusLineCommand('true', payload)).toBeNull();
  });

  it('returns null when the command overruns the timeout', async () => {
    expect(await runStatusLineCommand('sleep 2', payload, 100)).toBeNull();
  });

  it('trims the line and ignores later lines', async () => {
    const line = await runStatusLineCommand('printf "first\\nsecond\\n"', payload);

    expect(line).toBe('first');
  });

  it('caps the captured output instead of accumulating an unending stream', async () => {
    // 200 KB on a single line, then exit: only the capped prefix is kept.
    const line = await runStatusLineCommand(
      'head -c 200000 /dev/zero | tr "\\0" "a"',
      payload,
    );

    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(STATUS_LINE_MAX_CAPTURE_BYTES);
  });

  it.skipIf(process.platform === 'win32')(
    'spawns /bin/sh directly without searching long PATH prefixes for sh',
    async () => {
      const dir = join(tmpdir(), `sl-long-path-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPath = process.env['PATH'];
      try {
        const prefixDirs = Array.from({ length: 13 }, (_, idx) => {
          const entry = join(dir, `p-${idx}`);
          mkdirSync(entry, { recursive: true });
          return entry;
        });
        const wrapperDir = join(dir, 'sh-wrapper');
        mkdirSync(wrapperDir, { recursive: true });
        const hitsFile = join(dir, 'sh-hits');
        const wrapperSh = join(wrapperDir, 'sh');
        writeFileSync(wrapperSh, `#!/bin/sh\nprintf 'hit\\n' >> "${hitsFile}"\nexec /bin/sh "$@"\n`);
        chmodSync(wrapperSh, 0o755);

        const absCmd = join(dir, 'status-cmd.sh');
        writeFileSync(absCmd, '#!/bin/sh\n/bin/cat >/dev/null\nprintf "abs-%s" "$KIMI_CODE_STATUS_LINE"\n');
        chmodSync(absCmd, 0o755);

        process.env['PATH'] = [...prefixDirs, wrapperDir, '/bin', '/usr/bin'].join(delimiter);

        const line = await runStatusLineCommand(absCmd, payload);
        expect(line).toBe('abs-1');
        expect(existsSync(hitsFile)).toBe(false);
      } finally {
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs relative user commands via PATH and preserves sh -c semantics without resolving outer sh from PATH',
    async () => {
      const dir = join(tmpdir(), `sl-rel-cmd-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPath = process.env['PATH'];
      try {
        const decoyShDir = join(dir, 'decoy-sh');
        const toolDir = join(dir, 'tools');
        mkdirSync(decoyShDir, { recursive: true });
        mkdirSync(toolDir, { recursive: true });
        const hitsFile = join(dir, 'decoy-hits');
        const decoySh = join(decoyShDir, 'sh');
        writeFileSync(decoySh, `#!/bin/sh\nprintf 'decoy\\n' >> "${hitsFile}"\nexit 97\n`);
        chmodSync(decoySh, 0o755);

        const relTool = join(toolDir, 'custom-status-tool');
        writeFileSync(
          relTool,
          '#!/bin/sh\nbody=$(/bin/cat)\nprintf "%s|%s|%s" "$1" "$KIMI_CODE_STATUS_LINE" "$body"\n',
        );
        chmodSync(relTool, 0o755);

        process.env['PATH'] = [decoyShDir, toolDir, '/bin', '/usr/bin'].join(delimiter);

        const line = await runStatusLineCommand('custom-status-tool "hello world" | tr "a-z" "A-Z"', payload);
        expect(line).not.toBeNull();
        expect(line).toContain('HELLO WORLD|1|');
        expect(line).toContain('"MODEL":"KIMI-K2"');
        expect(existsSync(hitsFile)).toBe(false);
      } finally {
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs absolute user commands even when PATH omits /bin',
    async () => {
      const dir = join(tmpdir(), `sl-isolated-path-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPath = process.env['PATH'];
      try {
        const emptyDirs = Array.from({ length: 13 }, (_, idx) => {
          const entry = join(dir, `empty-${idx}`);
          mkdirSync(entry, { recursive: true });
          return entry;
        });
        const absCmd = join(dir, 'abs-only.sh');
        writeFileSync(absCmd, '#!/bin/sh\nIFS= read -r raw\nprintf "isolated:%s" "${raw%%,*}"\n');
        chmodSync(absCmd, 0o755);

        process.env['PATH'] = emptyDirs.join(delimiter);

        const line = await runStatusLineCommand(absCmd, payload);
        expect(line).toBe('isolated:{"model":"kimi-k2"');
      } finally {
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'falls back to sh on PATH when /bin/sh is absent such as on Termux',
    async () => {
      const dir = join(tmpdir(), `sl-termux-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPath = process.env['PATH'];
      try {
        const prefixBin = join(dir, 'usr', 'bin');
        mkdirSync(prefixBin, { recursive: true });
        const hitsFile = join(dir, 'termux-sh-hits');
        const termuxSh = join(prefixBin, 'sh');
        writeFileSync(termuxSh, `#!/bin/sh\nprintf 'termux-sh\\n' >> "${hitsFile}"\nexec /bin/sh "$@"\n`);
        chmodSync(termuxSh, 0o755);

        const statusTool = join(prefixBin, 'termux-status');
        writeFileSync(
          statusTool,
          '#!/bin/sh\nIFS= read -r raw\nprintf "termux:%s:%s" "$KIMI_CODE_STATUS_LINE" "${raw%%,*}"\n',
        );
        chmodSync(statusTool, 0o755);

        process.env['PATH'] = [prefixBin, '/usr/bin'].join(delimiter);

        const missingBinSh = join(dir, 'missing-bin', 'sh');
        const line = await runStatusLineCommand(
          'termux-status',
          payload,
          STATUS_LINE_COMMAND_TIMEOUT_MS,
          missingBinSh,
        );
        expect(line).toBe('termux:1:{"model":"kimi-k2"');
        expect(readFileSync(hitsFile, 'utf-8').trim()).toBe('termux-sh');
      } finally {
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'returns null when /bin/sh is absent and sh is also missing from PATH',
    async () => {
      const dir = join(tmpdir(), `sl-no-sh-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPath = process.env['PATH'];
      try {
        const emptyBin = join(dir, 'empty-bin');
        mkdirSync(emptyBin, { recursive: true });
        process.env['PATH'] = emptyBin;

        const missingBinSh = join(dir, 'missing-bin', 'sh');
        const line = await runStatusLineCommand(
          'printf unreachable',
          payload,
          STATUS_LINE_COMMAND_TIMEOUT_MS,
          missingBinSh,
        );
        expect(line).toBeNull();
      } finally {
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills the entire POSIX process group when a command times out',
    async () => {
      const dir = join(tmpdir(), `sl-kill-tree-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const activeSockets: Socket[] = [];
      let resolveConnected: (() => void) | null = null;
      let resolveClosed: (() => void) | null = null;
      const connected = new Promise<void>((resolve) => {
        resolveConnected = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const server = createServer((socket) => {
        activeSockets.push(socket);
        resolveConnected?.();
        socket.on('close', () => {
          resolveClosed?.();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('Expected TCP server address');
        }
        const holder = join(dir, 'holder.mjs');
        const sleeper = join(dir, 'sleeper.sh');
        writeFileSync(
          holder,
          `import { connect } from 'node:net';\nconst s = connect(${String(address.port)}, '127.0.0.1');\ns.on('error', () => {});\nsetInterval(() => {}, 10000);\n`,
        );
        writeFileSync(sleeper, `#!/bin/sh\n"${process.execPath}" "${holder}" &\nwait\n`);
        chmodSync(sleeper, 0o755);

        const runPromise = runStatusLineCommand(sleeper, payload, 600);
        const connectedBeforeTimeout = await Promise.race([
          connected.then(() => true),
          runPromise.then(() => false),
        ]);
        expect(connectedBeforeTimeout).toBe(true);

        const result = await runPromise;
        expect(result).toBeNull();

        const closedAfterKill = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              resolve(false);
            }, 2_000);
          }),
        ]);
        expect(closedAfterKill).toBe(true);
      } finally {
        for (const socket of activeSockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves the Windows ComSpec /d /s /c branch when platform is win32',
    async () => {
      const dir = join(tmpdir(), `sl-win-comspec-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPlatform = process.platform;
      const originalComSpec = process.env['ComSpec'];
      try {
        const argsFile = join(dir, 'comspec-args.txt');
        const fakeComSpec = join(dir, 'fake-cmd.sh');
        writeFileSync(
          fakeComSpec,
          `#!/bin/sh\n/bin/cat >/dev/null\nprintf "%s\\n" "$@" > "${argsFile}"\nprintf "win-%s" "$KIMI_CODE_STATUS_LINE"\n`,
        );
        chmodSync(fakeComSpec, 0o755);

        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        process.env['ComSpec'] = fakeComSpec;

        const line = await runStatusLineCommand('echo custom-win-line', payload);
        expect(line).toBe('win-1');
        expect(readFileSync(argsFile, 'utf-8').trim().split('\n')).toEqual([
          '/d',
          '/s',
          '/c',
          'echo custom-win-line',
        ]);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        if (originalComSpec === undefined) {
          delete process.env['ComSpec'];
        } else {
          process.env['ComSpec'] = originalComSpec;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('FooterComponent status_line command', () => {
  it('passes the remote binding cwd and suppresses the local git branch', async () => {
    const dir = join(tmpdir(), `sl-remote-cwd-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const captured = join(dir, 'payload.json');
    const footer = new FooterComponent({
      ...baseState,
      statusLine: { items: null, command: `tee ${captured} >/dev/null; printf remote-cwd` },
      environment: {
        environmentId: 'dev-box',
        type: 'ssh',
        status: 'ready',
        cwd: '/remote/proj',
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      footer.render(120);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(plain(footer.render(120)[0]!)).toContain('remote-cwd');
      expect(JSON.parse(readFileSync(captured, 'utf8'))).toMatchObject({
        cwd: '/remote/proj',
        gitBranch: null,
      });
    } finally {
      footer.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swaps line 1 to the command output once it lands', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'printf "my-custom-status"' },
    };
    const footer = new FooterComponent(state);

    // Before the first run completes the built-in layout is still shown.
    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('my-custom-status');
  });

  it('keeps the built-in layout when the command fails', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'exit 1' },
    };
    const footer = new FooterComponent(state);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');
  });
});

describe('StatusLineCommandRunner', () => {
  it('caches the last good line and coalesces refreshes in the same interval', async () => {
    const runner = new StatusLineCommandRunner('printf "x"', () => {});

    runner.maybeRefresh(payload);
    runner.maybeRefresh(payload);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(runner.current()).toBe('x');
  });

  it('runs a deferred refresh after the throttle interval instead of dropping it', async () => {
    const dir = join(tmpdir(), `sl-trailing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const counterFile = join(dir, 'count');
      const scriptFile = join(dir, 'count.sh');
      writeFileSync(counterFile, '0');
      writeFileSync(
        scriptFile,
        '#!/bin/sh\nn=$(cat "$1")\necho $((n+1)) > "$1"\nprintf "run-%s" "$n"\n',
      );
      const runner = new StatusLineCommandRunner(`sh ${scriptFile} ${counterFile}`, () => {});

      runner.maybeRefresh(payload);
      await new Promise((resolve) => setTimeout(resolve, 250));
      runner.maybeRefresh(payload); // throttled: must defer, not drop
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(readFileSync(counterFile, 'utf-8').trim()).toBe('1');

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readFileSync(counterFile, 'utf-8').trim()).toBe('2');
      runner.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recreates the runner when the command changes', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'printf "aaa"' },
    };
    const footer = new FooterComponent(state);
    footer.render(120); // kicks the first run
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(plain(footer.render(120)[0]!)).toContain('aaa');

    footer.setState({ ...state, statusLine: { items: null, command: 'printf "bbb"' } });
    footer.render(120); // kicks the replacement run
    await new Promise((resolve) => setTimeout(resolve, 450));

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('bbb');
    expect(line1).not.toContain('aaa');
  });

  it.skipIf(process.platform === 'win32')(
    'refreshes multiple instances once per second under a long PATH without PATH sh lookups',
    async () => {
      const dir = join(tmpdir(), `sl-multi-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const originalPath = process.env['PATH'];
      const runners: StatusLineCommandRunner[] = [];
      try {
        const prefixDirs = Array.from({ length: 13 }, (_, idx) => {
          const entry = join(dir, `prefix-${idx}`);
          mkdirSync(entry, { recursive: true });
          return entry;
        });
        const wrapperDir = join(dir, 'wrapper');
        mkdirSync(wrapperDir, { recursive: true });
        const hitsFile = join(dir, 'sh-wrapper-hits');
        const wrapperSh = join(wrapperDir, 'sh');
        writeFileSync(wrapperSh, `#!/bin/sh\nprintf 'hit\\n' >> "${hitsFile}"\nexec /bin/sh "$@"\n`);
        chmodSync(wrapperSh, 0o755);

        const scriptFile = join(dir, 'instance-status.sh');
        writeFileSync(
          scriptFile,
          '#!/bin/sh\n/bin/cat >/dev/null\nn=$(/bin/cat "$1")\nnext=$((n+1))\nprintf "%s\\n" "$next" > "$1"\nprintf "inst-%s-run-%s" "$2" "$next"\n',
        );
        chmodSync(scriptFile, 0o755);

        process.env['PATH'] = [...prefixDirs, wrapperDir, '/bin', '/usr/bin'].join(delimiter);

        const instanceCount = 4;
        for (let idx = 0; idx < instanceCount; idx++) {
          const counterFile = join(dir, `count-${idx}`);
          writeFileSync(counterFile, '0');
          runners.push(new StatusLineCommandRunner(`"${scriptFile}" "${counterFile}" "${idx}"`, () => {}));
        }

        for (const runner of runners) {
          runner.maybeRefresh(payload);
          runner.maybeRefresh(payload);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        for (let idx = 0; idx < instanceCount; idx++) {
          expect(runners[idx]!.current()).toBe(`inst-${idx}-run-1`);
        }

        await new Promise((resolve) => setTimeout(resolve, STATUS_LINE_RERUN_INTERVAL_MS));
        for (let idx = 0; idx < instanceCount; idx++) {
          expect(runners[idx]!.current()).toBe(`inst-${idx}-run-2`);
        }

        for (const runner of runners) {
          runner.maybeRefresh(payload);
        }
        await new Promise((resolve) => setTimeout(resolve, STATUS_LINE_RERUN_INTERVAL_MS));
        for (let idx = 0; idx < instanceCount; idx++) {
          expect(runners[idx]!.current()).toBe(`inst-${idx}-run-3`);
        }

        expect(existsSync(hitsFile)).toBe(false);
      } finally {
        for (const runner of runners) {
          runner.dispose();
        }
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
