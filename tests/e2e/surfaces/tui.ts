import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import {
  killProcessTree,
  kimiCliCommand,
  kimiCliEnv,
  NETWORK_GUARD_PRELOAD,
  networkGuardEnv,
  readNetworkViolations,
  TIMEOUTS,
  until,
} from '@moonshot-ai/testkit/fixtures';
import { FAKE_PROVIDER_DEFAULTS } from '@moonshot-ai/testkit/model';

import type { Diagnostic, SurfaceDriver, SurfaceLaunch, ToolExpectation, ToolStatus } from '../support/verbs';
import { offlineStubs } from './offline';

const COLUMNS = 120;
const ROWS = 40;
const EXIT_MARKER = 'E2E_CLI_EXIT=';
const SCROLLBACK_LINES = 1000;
const OUTPUT_TAIL = 64 * 1024;
const RECENT_INPUTS = 12;

const KEYS = { enter: '\r', escape: '\x1b', interrupt: '\x03', approveOnce: '1', reject: '3' } as const;

const USER_MARK = '❯';
const DONE_MARK = '●';
const FAILED_MARK = '✗';
const TRANSCRIPT_MARKS = [USER_MARK, DONE_MARK, FAILED_MARK] as const;

const APPROVAL_PANEL = '↵ confirm';
const ACTIVITY = /^\s*[\u{1F311}-\u{1F318}\u2800-\u28FF]/u;
const TOOL_CARD = /^(?:Used |Using |Truncated |Ran a command|Running a command|Read(?:ing)? \d+ files?)/;
const TURN_COMPLETED = 'Worked for ';
const TURN_STOPPED = 'Interrupted by user';
const TURN_FAILED = 'Error: [';
const APPROVED = 'Approved: ';
const REJECTED = 'Rejected: ';
const REJECTION_NOTICE = 'was not run because the user rejected the approval request';

interface Screen {
  readonly text: string;
  readonly lines: readonly string[];
  readonly viewport: readonly string[];
}

interface Block {
  readonly mark: (typeof TRANSCRIPT_MARKS)[number];
  readonly head: string;
  readonly text: string;
}

interface Turn {
  readonly stopped: number;
  readonly failed: number;
}

type Settled<T> = { readonly found: T } | { readonly over: Screen };

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function insidePseudoTerminal(launcher: string): string {
  return process.platform === 'darwin'
    ? `script -q /dev/null /bin/sh ${quote(launcher)}`
    : `script -q -e -c ${quote(`/bin/sh ${quote(launcher)}`)} /dev/null`;
}

function paste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

function squash(text: string): string {
  return text.replaceAll(/\s+/g, '');
}

function blocksOf(screen: Screen): Block[] {
  const blocks: { mark: Block['mark']; head: string; text: string }[] = [];
  let open: (typeof blocks)[number] | undefined;
  for (const raw of screen.lines) {
    const line = raw.trim();
    const mark = TRANSCRIPT_MARKS.find((candidate) => line.startsWith(`${candidate} `));
    if (mark !== undefined) {
      const head = line.slice(mark.length).trim();
      open = { mark, head, text: head };
      blocks.push(open);
    } else if (line === '') {
      open = undefined;
    } else if (open !== undefined) {
      open.text = `${open.text}\n${line}`;
    }
  }
  return blocks;
}

function statusLines(screen: Screen, prefix: string): number {
  return screen.lines.filter((line) => line.trimStart().startsWith(prefix)).length;
}

function latestTurn(screen: Screen): Block[] {
  const blocks = blocksOf(screen);
  return blocks.slice(blocks.findLastIndex((block) => block.mark === USER_MARK) + 1);
}

function userMessages(screen: Screen, text: string): number {
  return blocksOf(screen).filter((block) => block.mark === USER_MARK && squash(block.text).startsWith(squash(text))).length;
}

function showsApproval(screen: Screen): boolean {
  return screen.viewport.some((line) => line.includes(APPROVAL_PANEL));
}

function showsActivity(screen: Screen): boolean {
  return screen.viewport.some((line) => ACTIVITY.test(line));
}

function toolHead({ name, target }: ToolExpectation): string {
  return name === 'Bash' ? `Ran a command · $ ${target}` : `Used ${name} (${target})`;
}

function toolStatus(block: Block): ToolStatus | undefined {
  if (block.mark === USER_MARK) return undefined;
  if (block.mark === DONE_MARK) return 'done';
  return squash(block.text).includes(squash(REJECTION_NOTICE)) ? 'rejected' : 'failed';
}

function showsTool(screen: Screen, expectation: ToolExpectation): boolean {
  const head = toolHead(expectation);
  return latestTurn(screen).some(
    (block) => (block.head === head || block.head.startsWith(`${head} · `)) && toolStatus(block) === expectation.status,
  );
}

function showsReply(screen: Screen, text: string): boolean {
  return latestTurn(screen).some(
    (block) => block.mark === DONE_MARK && !TOOL_CARD.test(block.head) && squash(block.text).includes(squash(text)),
  );
}

function latestTurnEntries(screen: Screen): string {
  const entries = latestTurn(screen).map((block) => `${block.mark} ${block.text.replaceAll('\n', '\n  ')}`);
  return entries.length === 0 ? '(nothing after the last user message)' : entries.join('\n');
}

class TuiDriver implements SurfaceDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly networkLog: string;
  private readonly terminal = new VirtualTerminal(COLUMNS, ROWS);
  private readonly inputs: string[] = [];
  private output = '';
  private stderr = '';
  private released = false;
  private turn: Turn | undefined;

  constructor(child: ChildProcessWithoutNullStreams, networkLog: string) {
    this.child = child;
    this.networkLog = networkLog;
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      this.output = (this.output + text).slice(-OUTPUT_TAIL);
      this.terminal.write(text);
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-OUTPUT_TAIL);
    });
    child.stdin.on('error', (error) => {
      this.stderr = `${this.stderr}stdin: ${error.message}\n`;
    });
    child.once('close', () => {
      this.released = true;
    });
    this.terminal.onReply((reply) => {
      if (this.exitCode() === undefined && child.stdin.writable) child.stdin.write(reply);
    });
  }

  async ready(): Promise<void> {
    await this.wait('the TUI to show the configured model', (screen) =>
      screen.viewport.some((line) => line.includes(FAKE_PROVIDER_DEFAULTS.modelName)) ? true : undefined,
    );
  }

  async send(text: string): Promise<void> {
    const screen = await this.read();
    if (!this.turnOver(screen)) {
      throw this.failure('send() needs an idle product, but a turn is running or an approval is pending.', screen);
    }
    const shown = userMessages(screen, text);
    this.turn = { stopped: statusLines(screen, TURN_STOPPED), failed: statusLines(screen, TURN_FAILED) };
    this.write(paste(text));
    this.write(KEYS.enter);
    await this.wait(`the user message ${JSON.stringify(text)} to appear in the transcript`, (current) =>
      userMessages(current, text) > shown ? true : undefined,
    );
  }

  approve(): Promise<void> {
    return this.answerApproval('approve()', KEYS.approveOnce, APPROVED);
  }

  reject(): Promise<void> {
    return this.answerApproval('reject()', KEYS.reject, REJECTED);
  }

  async stop(): Promise<void> {
    const screen = await this.read();
    if (showsApproval(screen)) {
      throw this.failure('stop() cannot stop a turn while an approval is pending; answer it first.', screen);
    }
    if (this.turnOver(screen)) throw this.failure('stop() needs a running turn, but the product is idle.', screen);
    const stopped = statusLines(screen, TURN_STOPPED);
    this.write(KEYS.escape);
    const settled = await this.settle('the turn to stop', (current) =>
      statusLines(current, TURN_STOPPED) > stopped && !showsActivity(current) ? true : undefined,
    );
    if ('over' in settled) {
      throw this.failure('stop() did not interrupt the turn: it ended on its own before the stop took effect.', settled.over);
    }
  }

  async waitIdle(): Promise<void> {
    const settled = await this.settle('the turn to end', (screen) => (showsApproval(screen) ? screen : undefined));
    if ('found' in settled) {
      throw this.failure('waitIdle() found a pending approval; answer it with approve() or reject() first.', settled.found);
    }
  }

  async expectTool(expectation: ToolExpectation): Promise<void> {
    const wanted = `${expectation.name} on ${JSON.stringify(expectation.target)} with status ${expectation.status}`;
    const settled = await this.settle(`the tool ${wanted}`, (screen) => (showsTool(screen, expectation) ? true : undefined));
    if ('over' in settled) {
      throw this.failure(
        `expectTool() did not find ${wanted}. The turn ended and it shows:\n${latestTurnEntries(settled.over)}`,
        settled.over,
      );
    }
  }

  async expectReply(text: string): Promise<void> {
    const settled = await this.settle(`the reply ${JSON.stringify(text)}`, (screen) => (showsReply(screen, text) ? true : undefined));
    if ('over' in settled) {
      throw this.failure(
        `expectReply() did not find ${JSON.stringify(text)} in an assistant reply. The turn ended and it shows:\n${latestTurnEntries(settled.over)}`,
        settled.over,
      );
    }
  }

  async close(): Promise<void> {
    if (this.exitCode() !== undefined) {
      throw new Error(`The CLI exited before the scenario closed it.\n${await this.describe()}`);
    }
    const screen = await this.read();
    if (!this.turnOver(screen)) {
      throw this.failure('The scenario ended while a turn was running or an approval was pending; end it with waitIdle().', screen);
    }
    this.write(KEYS.interrupt);
    this.write(paste('/exit'));
    this.write(KEYS.enter);
    try {
      await until('the CLI to exit after /exit', () => this.exitCode() !== undefined, { timeoutMs: TIMEOUTS.wait });
      this.child.stdin.end();
      await until('the pseudo-terminal to close', () => this.released, { timeoutMs: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`The CLI did not exit cleanly after /exit.\n${await this.describe()}`, { cause });
    }
    if (this.exitCode() !== 0) throw new Error(`The CLI exited with status ${String(this.exitCode())}.\n${await this.describe()}`);
  }

  async kill(): Promise<void> {
    if (this.released) return;
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined) killProcessTree(this.child.pid);
    this.child.stdin.destroy();
    try {
      await until('the pseudo-terminal to close', () => this.released, { timeoutMs: TIMEOUTS.wait });
    } catch {
      this.stderr = `${this.stderr}The pseudo-terminal did not close after it was killed.\n`;
    }
  }

  networkViolations(): Promise<readonly string[]> {
    return readNetworkViolations(this.networkLog, 'The CLI in a pseudo-terminal');
  }

  async diagnostics(): Promise<readonly Diagnostic[]> {
    const screen = await this.read();
    return [
      { name: 'tui-screen', body: screen.text },
      {
        name: 'tui-session',
        body: [
          `exit status: ${String(this.exitCode() ?? 'still running')}`,
          `recent input: ${JSON.stringify(this.inputs)}`,
          `stderr:\n${this.stderr === '' ? '(empty)' : this.stderr}`,
        ].join('\n'),
      },
    ];
  }

  private async answerApproval(verb: string, key: string, recorded: string): Promise<void> {
    const settled = await this.settle('an approval request', (screen) => (showsApproval(screen) ? screen : undefined));
    if ('over' in settled) {
      throw this.failure(`${verb} found no approval: the turn ended without asking for one.`, settled.over);
    }
    const answered = statusLines(settled.found, recorded);
    this.write(key);
    await this.wait(`the transcript to record "${recorded.trim()}"`, (screen) =>
      statusLines(screen, recorded) > answered ? true : undefined,
    );
  }

  private turnOver(screen: Screen): boolean {
    if (showsActivity(screen) || showsApproval(screen)) return false;
    if (this.turn === undefined) return true;
    return (
      screen.viewport.some((line) => line.trimStart().startsWith(TURN_COMPLETED)) ||
      statusLines(screen, TURN_STOPPED) > this.turn.stopped ||
      statusLines(screen, TURN_FAILED) > this.turn.failed
    );
  }

  private settle<T>(label: string, evidence: (screen: Screen) => T | undefined): Promise<Settled<T>> {
    let quiet: string | undefined;
    return this.wait<Settled<T>>(label, (screen) => {
      const found = evidence(screen);
      if (found !== undefined) return { found };
      if (!this.turnOver(screen)) {
        quiet = undefined;
        return undefined;
      }
      if (quiet === screen.text) return { over: screen };
      quiet = screen.text;
      return undefined;
    });
  }

  private async wait<T>(label: string, check: (screen: Screen) => T | undefined): Promise<T> {
    let outcome: { readonly value: T } | { readonly halted: string };
    try {
      outcome = await until(
        label,
        async () => {
          const screen = await this.read();
          const value = check(screen);
          if (value !== undefined) return { value };
          if (screen.lines.length >= SCROLLBACK_LINES + ROWS) {
            return { halted: `The transcript outgrew the ${SCROLLBACK_LINES} lines the virtual terminal keeps, so evidence counted from the screen is no longer reliable.` };
          }
          return this.exitCode() === undefined ? undefined : { halted: 'The CLI exited.' };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${reason}\n${await this.describe()}`, { cause });
    }
    if ('halted' in outcome) throw new Error(`${outcome.halted} The test was waiting for ${label}.\n${await this.describe()}`);
    return outcome.value;
  }

  private async read(): Promise<Screen> {
    await this.terminal.flush();
    const lines = this.terminal.getScrollBuffer();
    return { text: lines.join('\n'), lines, viewport: this.terminal.getViewport() };
  }

  private write(input: string): void {
    this.inputs.push(input.slice(-200));
    if (this.inputs.length > RECENT_INPUTS) this.inputs.shift();
    this.child.stdin.write(input);
  }

  private exitCode(): number | undefined {
    const match = new RegExp(`${EXIT_MARKER}(\\d+)`).exec(this.output);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  }

  private failure(message: string, screen: Screen): Error {
    return new Error(`${message}\nScreen:\n${screen.viewport.join('\n').trimEnd()}`);
  }

  private async describe(): Promise<string> {
    const screen = await this.read();
    return [
      `Screen:\n${screen.viewport.join('\n').trimEnd()}`,
      `Recent input: ${JSON.stringify(this.inputs)}`,
      `Exit status: ${String(this.exitCode() ?? 'still running')}`,
    ].join('\n');
  }
}

export async function startTui({ home }: SurfaceLaunch): Promise<SurfaceDriver> {
  if (process.platform === 'win32') throw new Error('The TUI surface needs the script command; Windows is not supported yet.');
  const command = kimiCliCommand();
  if (!existsSync(command.entry)) {
    throw new Error(`The CLI entry ${command.entry} does not exist; build the CLI before running against its bundle.`);
  }
  const networkLog = join(home.root, 'tui-network.log');
  const launcher = join(home.root, 'tui-launch.sh');
  const preloads = [...(command.imports ?? []), NETWORK_GUARD_PRELOAD.href].flatMap((specifier) => ['--import', specifier]);
  const cli = [process.execPath, ...preloads, command.entry].map(quote).join(' ');
  await writeFile(launcher, [`stty cols ${COLUMNS} rows ${ROWS}`, cli, `printf '\\n${EXIT_MARKER}%s\\n' "$?"`, ''].join('\n'));
  const child = spawn('/bin/sh', ['-c', `cat | ${insidePseudoTerminal(launcher)}`], {
    cwd: home.workspace,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...kimiCliEnv(home, { TERM: 'xterm-256color' }), ...command.env, ...networkGuardEnv(networkLog, offlineStubs()) },
  });
  const driver = new TuiDriver(child, networkLog);
  try {
    await driver.ready();
  } catch (error) {
    await driver.kill();
    throw error;
  }
  return driver;
}
