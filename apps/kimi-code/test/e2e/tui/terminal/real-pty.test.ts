import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as betweenKeystrokes } from 'node:timers/promises';

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
  writeKimiConfig,
} from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, say } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { cliFetchStubs, TURN_FINISHED } from '../support/terminal-session';

const test = base.extend<HomeFixtures & ModelFixtures>({ ...homeFixtures(), ...modelFixtures() });

const COLUMNS = 100;
const ROWS = 36;
const EXIT_MARKER = 'KIMI_PTY_EXIT=';

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function insidePseudoTerminal(launcher: string): [string, string[]] {
  const script = process.platform === 'darwin'
    ? `script -q /dev/null /bin/sh ${quote(launcher)}`
    : `script -q -e -c ${quote(`/bin/sh ${quote(launcher)}`)} /dev/null`;
  return ['/bin/sh', ['-c', `cat | ${script}`]];
}

test.runIf(process.platform !== 'win32')('hands the terminal back in its normal mode after a first turn in a real pseudo-terminal', { timeout: 90_000 }, async ({ model, testHome }) => {
  await model.listen();
  await writeKimiConfig(testHome.dataDir, fakeModelConfig(model, { modelName: 'pty-smoke-model' }));
  const command = kimiCliCommand();
  const networkLog = join(testHome.root, 'pty-network.log');
  const launcher = join(testHome.root, 'pty-launch.sh');
  const node = [process.execPath, ...[...(command.imports ?? []), NETWORK_GUARD_PRELOAD.href].flatMap((specifier) => ['--import', specifier]), command.entry];
  await writeFile(launcher, [
    `stty cols ${COLUMNS} rows ${ROWS}`,
    node.map(quote).join(' '),
    'status=$?',
    `printf '\\n${EXIT_MARKER}%s\\n' "$status"`,
    'stty -a',
    '',
  ].join('\n'));
  const [file, args] = insidePseudoTerminal(launcher);
  const child = spawn(file, args, {
    cwd: testHome.workspace,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...kimiCliEnv(testHome, { TERM: 'xterm-256color' }), ...command.env, ...networkGuardEnv(networkLog, cliFetchStubs()) },
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const screen = new VirtualTerminal(COLUMNS, ROWS);
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output += text;
    screen.write(text);
  });
  screen.onReply((reply) => child.stdin.write(reply));
  const shows = async (text: string) => (await screen.flushAndGetViewport()).join('\n').includes(text);
  try {
    await until('the TUI drew its prompt in the pseudo-terminal', () => shows('pty-smoke-model'), { timeoutMs: TIMEOUTS.server });
    model.script(say('Answer from a real terminal.'));
    for (const key of 'Hello pty') {
      child.stdin.write(key);
      await betweenKeystrokes(20);
    }
    await until('the typed prompt', () => shows('Hello pty'));
    child.stdin.write('\r');
    await until('the answer', () => shows('Answer from a real terminal.'));
    await until('the turn to finish', () => shows(TURN_FINISHED));
    child.stdin.write('\x03\x1b[200~/exit\x1b[201~\r');
    await until('the CLI exited and the shell printed the terminal modes', () => output.includes(EXIT_MARKER) && /\bspeed\b/.test(output.slice(output.indexOf(EXIT_MARKER))), { timeoutMs: TIMEOUTS.server });
    child.stdin.end();
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) killProcessTree(child.pid);
  }
  const after = output.slice(output.indexOf(EXIT_MARKER));
  expect(/^KIMI_PTY_EXIT=(\d+)/.exec(after)?.[1], 'CLI exit status').toBe('0');
  const modes = after.split(/\s+/);
  expect(modes).toEqual(expect.arrayContaining(['icanon', 'echo']));
  expect(modes).not.toEqual(expect.arrayContaining(['-icanon']));
  expect(modes).not.toEqual(expect.arrayContaining(['-echo']));
  expect(model.requests('main').map((request) => request.firstUserText)).toEqual(['Hello pty']);
  await expect(readNetworkViolations(networkLog, 'CLI in a pseudo-terminal')).resolves.toEqual([]);
});
