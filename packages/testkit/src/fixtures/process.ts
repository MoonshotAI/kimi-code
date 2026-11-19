import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { TestkitError } from '#/errors';
import { FETCH_STUBS_ENV, NETWORK_LOG_ENV, type FetchStub } from '#/fixtures/network';
import { TIMEOUTS } from '#/fixtures/timeouts';
import { waitForEvent } from '#/fixtures/wait';

const NETWORK_GUARD_PRELOAD = new URL('./network-preload.ts', import.meta.url).href;
const TAIL_CHARACTERS = 16 * 1024;
const LINE_HISTORY = 1_000;
const LONGEST_LINE = 64 * 1024;

export function killProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new RangeError('Expected a child process ID');
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { return; }
  }
}

function killExitedProcessGroup(pid: number): void {
  if (process.platform === 'win32') return;
  try { process.kill(-pid, 'SIGKILL'); } catch { return; }
}

export interface NodeCommand {
  readonly entry: string;
  readonly imports?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface StartTestProcessOptions {
  readonly label: string;
  readonly command: NodeCommand;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logDir: string;
  readonly stdin?: boolean;
  readonly fetchStubs?: readonly FetchStub[];
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface LineWaitOptions {
  readonly timeoutMs?: number;
  readonly description?: string;
}

export class TestProcess {
  readonly label: string;
  readonly pid: number;
  readonly networkLog: string;
  readonly closed: Promise<ProcessExit>;
  private readonly child: ChildProcess;
  private exitState: ProcessExit | undefined;
  private stdoutText = '';
  private stderrText = '';
  private partialLine = '';
  private readonly lines: string[] = [];
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly outputListeners = new Set<(text: string) => void>();

  private constructor(options: StartTestProcessOptions) {
    this.label = options.label;
    this.networkLog = join(options.logDir, `network-${randomUUID()}.log`);
    const imports = [...(options.command.imports ?? []), NETWORK_GUARD_PRELOAD].flatMap((specifier) => ['--import', specifier]);
    const stubs = options.fetchStubs ?? [];
    this.child = spawn(process.execPath, [...imports, options.command.entry, ...(options.args ?? [])], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [options.stdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...options.env,
        ...options.command.env,
        [NETWORK_LOG_ENV]: this.networkLog,
        ...(stubs.length === 0 ? {} : { [FETCH_STUBS_ENV]: JSON.stringify(stubs) }),
      },
    });
    const recordError = (error: Error): void => {
      this.stderrText = appendTail(this.stderrText, `${error.message}\n`);
    };
    this.child.on('error', recordError);
    this.child.stdin?.on('error', recordError);
    this.closed = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        if (this.partialLine !== '') this.acceptLine(this.partialLine);
        this.partialLine = '';
        this.exitState = { code, signal };
        resolve(this.exitState);
      });
    });
    this.child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      this.stdoutText = appendTail(this.stdoutText, text);
      for (const listener of this.outputListeners) listener(text);
      this.collectLines(text);
    });
    this.child.stderr?.setEncoding('utf8').on('data', (text: string) => {
      this.stderrText = appendTail(this.stderrText, text);
    });
    if (this.child.pid === undefined) throw new TestkitError(`${this.label} did not start: ${this.stderrText || 'no process ID'}`);
    this.pid = this.child.pid;
  }

  static start(options: StartTestProcessOptions): TestProcess {
    if (!existsSync(options.command.entry)) throw new TestkitError(`${options.label} cannot start: ${options.command.entry} does not exist`);
    return new TestProcess(options);
  }

  get stdin(): Writable {
    const stdin = this.child.stdin;
    if (stdin === null) throw new TestkitError(`${this.label} was started without stdin; pass stdin: true`);
    return stdin;
  }

  get exited(): boolean {
    return this.exitState !== undefined || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  exit(): ProcessExit | undefined {
    return this.exitState;
  }

  stdoutTail(): string {
    return this.stdoutText;
  }

  stderrTail(): string {
    return this.stderrText;
  }

  onOutput(listener: (text: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  waitForLine(predicate: (line: string) => boolean, options: LineWaitOptions = {}): Promise<string> {
    const seen = this.lines.find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    const description = options.description ?? 'a matching stdout line';
    return waitForEvent<string>(
      (settle, fail) => {
        const onLine = (line: string): void => {
          if (predicate(line)) settle(line);
        };
        this.lineListeners.add(onLine);
        void this.closed.then(() => fail(new TestkitError(`${this.label} exited before printing ${description}\n${this.describe()}`)));
        return () => {
          this.lineListeners.delete(onLine);
        };
      },
      { timeoutMs: options.timeoutMs ?? TIMEOUTS.server, describe: () => `${description} from ${this.label}\n${this.describe()}` },
    );
  }

  async forceKill(): Promise<ProcessExit> {
    if (this.exitState === undefined) {
      if (this.child.exitCode === null && this.child.signalCode === null) killProcessTree(this.pid);
      else killExitedProcessGroup(this.pid);
    }
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    return this.closed;
  }

  networkViolations(): Promise<readonly string[]> {
    return readNetworkViolations(this.networkLog, this.label);
  }

  describe(): string {
    const state = this.exitState === undefined ? 'running' : `exit=${String(this.exitState.code)} signal=${String(this.exitState.signal)}`;
    return [`${this.label} pid=${this.pid} ${state}`, 'stderr:', this.stderrText === '' ? '(empty)' : this.stderrText].join('\n');
  }

  private collectLines(text: string): void {
    const parts = (this.partialLine + text).split(/\r?\n/);
    this.partialLine = (parts.pop() ?? '').slice(-LONGEST_LINE);
    for (const line of parts) this.acceptLine(line);
  }

  private acceptLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LINE_HISTORY) this.lines.shift();
    for (const listener of this.lineListeners) listener(line);
  }
}

export async function readNetworkViolations(path: string, label = 'The child process'): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TestkitError(`${label} did not load the testkit network guard preload (no log at ${path})`, { cause: error });
    }
    throw error;
  }
  return text.split('\n').filter((line) => line !== '');
}

function appendTail(tail: string, text: string): string {
  const combined = tail + text;
  return combined.length > TAIL_CHARACTERS ? combined.slice(-TAIL_CHARACTERS) : combined;
}
