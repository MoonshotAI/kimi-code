import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  killProcessTree,
  NETWORK_GUARD_PRELOAD,
  networkGuardEnv,
  readNetworkViolations,
  TIMEOUTS,
  until,
  type FetchStub,
} from '@moonshot-ai/testkit/fixtures';
import type { IPty } from 'node-pty';

const OUTPUT_TAIL = 64 * 1024;
const TERMINAL_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
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

export function plainText(text: string): string {
  return text.replaceAll(TERMINAL_ESCAPE, '').replaceAll('\r', '');
}

export class TerminalProcess {
  readonly label: string;
  readonly pid: number;
  readonly networkLog: string;
  readonly closed: Promise<TerminalExit>;
  private readonly pty: IPty;
  private output = '';
  private exitState: TerminalExit | undefined;

  private constructor(pty: IPty, label: string, networkLog: string) {
    this.pty = pty;
    this.label = label;
    this.networkLog = networkLog;
    this.pid = pty.pid;
    pty.onData((text) => {
      this.output = (this.output + text).slice(-OUTPUT_TAIL);
    });
    this.closed = new Promise((resolve) => {
      pty.onExit(({ exitCode, signal }) => {
        this.exitState = { code: exitCode, signal };
        resolve(this.exitState);
      });
    });
  }

  static async start(options: TerminalProcessOptions): Promise<TerminalProcess> {
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
    return new TerminalProcess(pty, options.label, networkLog);
  }

  get exited(): boolean {
    return this.exitState !== undefined;
  }

  exit(): TerminalExit | undefined {
    return this.exitState;
  }

  outputTail(): string {
    return plainText(this.output);
  }

  async waitForLine(predicate: (line: string) => boolean, description: string): Promise<string> {
    const line = await until(
      description,
      () => {
        const found = this.outputTail().split('\n').find(predicate);
        if (found !== undefined) return found;
        if (this.exited) throw new Error(`${this.label} exited before printing ${description}.\n${this.describe()}`);
        return undefined;
      },
      { timeoutMs: TIMEOUTS.server },
    );
    return line;
  }

  interrupt(): void {
    this.pty.write(INTERRUPT);
  }

  async forceKill(): Promise<TerminalExit> {
    if (this.exitState === undefined) killProcessTree(this.pid);
    return this.closed;
  }

  networkViolations(): Promise<readonly string[]> {
    return readNetworkViolations(this.networkLog, this.label);
  }

  describe(): string {
    const state = this.exitState === undefined ? 'running' : `exit=${String(this.exitState.code)} signal=${String(this.exitState.signal)}`;
    const output = this.outputTail().trimEnd();
    return [`${this.label} pid=${this.pid} ${state}`, 'terminal output:', output === '' ? '(empty)' : output].join('\n');
  }
}
