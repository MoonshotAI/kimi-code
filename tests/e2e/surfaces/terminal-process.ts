import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  killProcessTree,
  NETWORK_GUARD_PRELOAD,
  networkGuardEnv,
  readNetworkViolations,
  TIMEOUTS,
  until,
  type FetchStub,
} from '@moonshot-ai/testkit/fixtures';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import type { IPty } from 'node-pty';

const INTERRUPT = '\x03';

export interface TerminalCommand {
  readonly entry: string;
  readonly imports?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface TerminalProcessOptions {
  readonly label: string;
  readonly command: TerminalCommand;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logDir: string;
  readonly fetchStubs: readonly FetchStub[];
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalExit {
  readonly code: number;
  readonly signal: number | undefined;
}

export async function loadNodePty(): Promise<typeof import('node-pty')> {
  try {
    return await import('node-pty');
  } catch (cause) {
    throw new Error(
      'Could not load node-pty. On Linux it is compiled by the apps/desktop postinstall during pnpm install; run pnpm install again and let that postinstall finish.',
      { cause },
    );
  }
}

export class TerminalProcess {
  readonly label: string;
  readonly pid: number;
  readonly networkLog: string;
  readonly closed: Promise<TerminalExit>;
  private readonly pty: IPty;
  private readonly screen: VirtualTerminal;
  private exitState: TerminalExit | undefined;

  private constructor(pty: IPty, label: string, networkLog: string, screen: VirtualTerminal) {
    this.pty = pty;
    this.screen = screen;
    this.label = label;
    this.networkLog = networkLog;
    this.pid = pty.pid;
    pty.onData((text) => {
      screen.write(text);
    });
    screen.onReply((reply) => {
      if (this.exitState === undefined) pty.write(reply);
    });
    this.closed = new Promise((resolve) => {
      pty.onExit(({ exitCode, signal }) => {
        this.exitState = { code: exitCode, signal };
        resolve(this.exitState);
      });
    });
  }

  static async start(options: TerminalProcessOptions): Promise<TerminalProcess> {
    if (!existsSync(options.command.entry)) throw new Error(`${options.label} cannot start: ${options.command.entry} does not exist`);
    const { spawn } = await loadNodePty();
    const networkLog = join(options.logDir, `network-${randomUUID()}.log`);
    const imports = [...(options.command.imports ?? []), NETWORK_GUARD_PRELOAD.href].flatMap((specifier) => ['--import', specifier]);
    const pty = spawn(process.execPath, [...imports, options.command.entry, ...options.args], {
      name: 'xterm-256color',
      cols: options.columns,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...options.env, ...options.command.env, ...networkGuardEnv(networkLog, options.fetchStubs) },
    });
    return new TerminalProcess(pty, options.label, networkLog, new VirtualTerminal(options.columns, options.rows));
  }

  get exited(): boolean {
    return this.exitState !== undefined;
  }

  exit(): TerminalExit | undefined {
    return this.exitState;
  }

  async waitForLine(predicate: (line: string) => boolean, description: string): Promise<string> {
    const outcome = await until(
      description,
      async () => {
        await this.screen.flush();
        const found = this.screen.getScrollBuffer().find((row) => predicate(row.trimEnd()));
        if (found !== undefined) return { line: found };
        return this.exited ? { exited: true as const } : undefined;
      },
      { timeoutMs: TIMEOUTS.server },
    );
    if ('exited' in outcome) throw new Error(`${this.label} exited before printing ${description}.\n${this.describe()}`);
    return outcome.line;
  }

  interrupt(): void {
    this.pty.write(INTERRUPT);
  }

  async forceKill(): Promise<TerminalExit> {
    if (this.exitState === undefined) {
      killProcessTree(this.pid);
    } else if (process.platform !== 'win32') {
      try {
        process.kill(-this.pid, 'SIGKILL');
      } catch {
        return this.closed;
      }
    }
    return this.closed;
  }

  networkViolations(): Promise<readonly string[]> {
    return readNetworkViolations(this.networkLog, this.label);
  }

  describe(): string {
    const state = this.exitState === undefined ? 'running' : `exit=${String(this.exitState.code)} signal=${String(this.exitState.signal)}`;
    const output = this.screen.getScrollBuffer().map((row) => row.trimEnd()).join('\n').trim();
    return [`${this.label} pid=${this.pid} ${state}`, 'terminal screen:', output === '' ? '(empty)' : output].join('\n');
  }
}
