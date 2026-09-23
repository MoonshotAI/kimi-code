/**
 * Scenario: the `kimi exec-server` light entry (bare or with the explicit
 * `--listen stdio` spelling) — argv
 * pre-dispatch shape, transport validation, hidden Commander subcommand, and
 * the import-graph rule that keeps the SDK mega-module out of the executor
 * path — plus a real stdio handshake against the source entry (tsx).
 * Responsibilities: light-entry contract, exit codes/stderr discipline,
 * executorVersion surface.
 * Wiring: child processes spawn the real `src/main.ts` through tsx; no mocks.
 * Run: pnpm -C apps/kimi-code exec vitest run test/cli/exec-server.test.ts
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createProgram } from '#/cli/commands';
import {
  EXEC_SERVER_COMMAND,
  isExecServerArgv,
  resolveExecutorVersion,
  runExecServerCommand,
} from '#/cli/exec-server';

const appRoot = resolve(import.meta.dirname, '..', '..');
const srcRoot = resolve(appRoot, 'src');
const hostPackage = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf-8')) as {
  version: string;
};

describe('isExecServerArgv', () => {
  it('matches the node/tsx argv shape [exec, script, ...args]', () => {
    expect(isExecServerArgv(['node', 'dist/main.mjs', 'exec-server', '--listen', 'stdio'])).toBe(
      true,
    );
  });

  it('matches the bare command, which defaults to stdio', () => {
    expect(isExecServerArgv(['node', 'dist/main.mjs', 'exec-server'])).toBe(true);
    expect(isExecServerArgv(['/home/me/.kimi-code/bin/kimi', 'exec-server'])).toBe(true);
  });

  it('matches the SEA argv shape without a script slot', () => {
    expect(isExecServerArgv(['/home/me/.kimi-code/bin/kimi', 'exec-server', '--listen', 'stdio'])).toBe(
      true,
    );
  });

  it('matches the SEA argv shape with the executable repeated', () => {
    expect(
      isExecServerArgv(['kimi', 'kimi', 'exec-server', '--listen', 'stdio']),
    ).toBe(true);
  });

  it('rejects malformed transports, unknown options, and excess args', () => {
    expect(isExecServerArgv(['node', 'main.mjs', 'exec-server', '--listen', 'ws'])).toBe(false);
    expect(isExecServerArgv(['node', 'main.mjs', 'exec-server', '--listen=stdio'])).toBe(false);
    expect(isExecServerArgv(['node', 'main.mjs', 'exec-server', '--bogus'])).toBe(false);
    expect(
      isExecServerArgv(['node', 'main.mjs', 'exec-server', '--listen', 'stdio', '--verbose']),
    ).toBe(false);
  });

  it('does not match the tokens in later positions', () => {
    expect(isExecServerArgv(['node', 'main.mjs', '-p', 'exec-server --listen stdio'])).toBe(false);
    expect(isExecServerArgv(['node', 'main.mjs', 'web', 'exec-server', '--listen', 'stdio'])).toBe(
      false,
    );
  });
});

describe('runExecServerCommand transport validation', () => {
  it.each(['ws', 'tcp'])(
    'rejects the %s transport with exit code 2 and a stderr-only error',
    async (transport) => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const code = await runExecServerCommand(transport);
        expect(code).toBe(2);
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--listen stdio'));
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    },
  );
});

describe('resolveExecutorVersion', () => {
  it('reports the host package version for the handshake gate', () => {
    expect(resolveExecutorVersion()).toBe(hostPackage.version);
  });
});

describe('hidden exec-server subcommand', () => {
  function createExecServerProgram(): {
    program: ReturnType<typeof createProgram>;
    calls: string[];
  } {
    const calls: string[] = [];
    const program = createProgram(
      '0.0.0',
      () => {
        throw new Error('main action should not run');
      },
      () => {},
      () => {},
      () => {},
      () => {},
      (listen) => {
        calls.push(listen);
      },
    );
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    return { program, calls };
  }

  it('routes exec-server --listen stdio to the handler without the main action', () => {
    const { program, calls } = createExecServerProgram();
    program.parse(['node', 'kimi', 'exec-server', '--listen', 'stdio']);
    expect(calls).toEqual(['stdio']);
  });

  it('defaults --listen to stdio on a bare invocation', () => {
    const { program, calls } = createExecServerProgram();
    program.parse(['node', 'kimi', 'exec-server']);
    expect(calls).toEqual(['stdio']);
  });

  it('accepts the --listen=stdio spelling', () => {
    const { program, calls } = createExecServerProgram();
    program.parse(['node', 'kimi', 'exec-server', '--listen=stdio']);
    expect(calls).toEqual(['stdio']);
  });

  it('passes an unsupported transport through for the runner to reject', () => {
    const { program, calls } = createExecServerProgram();
    program.parse(['node', 'kimi', 'exec-server', '--listen', 'ws']);
    expect(calls).toEqual(['ws']);
  });

  it('rejects unknown options instead of silently starting', () => {
    const { program, calls } = createExecServerProgram();
    expect(() => program.parse(['node', 'kimi', 'exec-server', '--bogus'])).toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects excess arguments', () => {
    const { program } = createExecServerProgram();
    expect(() => program.parse(['node', 'kimi', 'exec-server', '--listen', 'stdio', 'extra'])).toThrow();
  });

  it('stays out of the help output', () => {
    const help = createProgram('0.0.0', () => {}, () => {}).helpInformation();
    expect(help).not.toContain(EXEC_SERVER_COMMAND);
  });
});

describe('light entry import graph', () => {
  const STATIC_IMPORT_RE =
    /^\s*(?:import\s+(?:type\s+)?(?:[\w${},\s*]+\s+from\s+)?|export\s+(?:type\s+)?(?:[\w${},\s*]+\s+from\s+))['"]([^'"]+)['"]/gm;

  function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
    if (specifier.startsWith('#/')) {
      return resolve(srcRoot, `${specifier.slice(2)}.ts`);
    }
    if (specifier.startsWith('.')) {
      const base = resolve(dirname(fromFile), specifier);
      return base.endsWith('.ts') ? base : `${base}.ts`;
    }
    return undefined;
  }

  function collectStaticGraph(entry: string): { files: Set<string>; externals: Set<string> } {
    const files = new Set<string>();
    const externals = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(STATIC_IMPORT_RE)) {
        const specifier = match[1]!;
        const resolved = resolveSpecifier(specifier, file);
        if (resolved === undefined) {
          externals.add(specifier);
        } else {
          queue.push(resolved);
        }
      }
    }
    return { files, externals };
  }

  it('keeps the process entry free of the SDK mega-module and heavy CLI modules', () => {
    const { files, externals } = collectStaticGraph(resolve(srcRoot, 'main.ts'));

    expect([...externals].filter((name) => !name.startsWith('node:'))).toEqual([]);
    expect(externals).not.toContain('@moonshot-ai/kimi-code-sdk');
    expect([...files].map((file) => file.slice(srcRoot.length + 1)).toSorted()).toEqual([
      'cli/build-info.ts',
      'cli/exec-server.ts',
      'cli/host-package.ts',
      'main.ts',
    ]);
  });

  it('reaches the executor implementation only through a dynamic import of the server subpath', () => {
    const source = readFileSync(resolve(srcRoot, 'cli/exec-server.ts'), 'utf-8');
    expect(source).toContain(`import('@moonshot-ai/agent-core-v2/remote/server')`);
    expect(source).not.toMatch(/^\s*import\s+.*['"]@moonshot-ai\//m);
  });
});

interface HandshakeResult {
  readonly initialize: Record<string, unknown>;
  readonly status: Record<string, unknown>;
  readonly exitCode: number | null;
  readonly stderr: string;
}

async function runExecServerHandshake(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<HandshakeResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(command, [...args], {
    cwd: options.cwd ?? appRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  let waiters: Array<(line: Record<string, unknown>) => void> = [];
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter !== undefined) {
          waiter(parsed);
        } else {
          lines.push(parsed);
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  const nextLine = () =>
    new Promise<Record<string, unknown>>((resolveLine, rejectLine) => {
      const queued = lines.shift();
      if (queued !== undefined) {
        resolveLine(queued);
        return;
      }
      const timer = setTimeout(() => {
        rejectLine(new Error(`timed out waiting for a protocol frame; stderr so far:\n${stderr}`));
      }, timeoutMs);
      waiters.push((line) => {
        clearTimeout(timer);
        resolveLine(line);
      });
    });

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  try {
    send({ method: 'initialize', id: 1, params: { clientName: 'vitest', clientVersion: '0.0.0' } });
    const initialize = await nextLine();
    send({ method: 'initialized' });
    send({ method: 'fs/getMetadata', id: 2, params: { path: '/' } });
    const status = await nextLine();
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolveExit) => {
      let settled = false;
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        resolveExit(code);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(null);
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        settle(code);
      });
    });
    return { initialize, status, exitCode, stderr };
  } finally {
    waiters = [];
    child.kill('SIGKILL');
  }
}

describe('exec-server stdio handshake (source entry)', () => {
  it.each([
    ['bare', ['src/main.ts', 'exec-server']],
    ['explicit --listen stdio', ['src/main.ts', 'exec-server', '--listen', 'stdio']],
  ] as const)(
    'answers initialize with the host version and a posix environment, then exits 0 on stdin EOF (%s argv)',
    { timeout: 60_000 },
    async (_label, argv) => {
      const tsxBin = resolve(appRoot, 'node_modules/.bin/tsx');
      const result = await runExecServerHandshake(tsxBin, argv);

      expect(result.initialize['id']).toBe(1);
      const initializeResult = result.initialize['result'] as {
        executorVersion: string;
        environment: { osKind: string; cwd: string };
      };
      expect(initializeResult.executorVersion).toBe(hostPackage.version);
      expect(initializeResult.environment.osKind).not.toBe('windows');
      expect(initializeResult.environment.cwd).toBe(appRoot);

      expect(result.status['id']).toBe(2);
      expect((result.status['result'] as { isDirectory: boolean }).isDirectory).toBe(true);
      expect(result.exitCode).toBe(0);
    },
  );
});
