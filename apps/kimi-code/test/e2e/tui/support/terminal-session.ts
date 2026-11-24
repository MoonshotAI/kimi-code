import { setTimeout as delayBetweenKeystrokes } from 'node:timers/promises';

import { KIMI_REGION_PROFILES } from '@moonshot-ai/kimi-code-oauth';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { kimiCliCommand, kimiCliEnv, kimiServiceStubs, TestProcess, TIMEOUTS, writeKimiConfig, type FetchStub, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, type FakeModel } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures, type Use } from '@moonshot-ai/testkit/vitest';
import { expect, type TestContext } from 'vitest';

import { getFdAssetName } from '#/utils/process/fd-detect';

export function cliFetchStubs(): FetchStub[] {
  const asset = getFdAssetName();
  const downloads = asset === null ? [] : Object.values(KIMI_REGION_PROFILES).map(({ cdnBase }) => ({ method: 'GET', url: `${cdnBase}/fd/${asset}`, status: 404 }));
  return [...kimiServiceStubs(), ...downloads];
}

export const TURN_FINISHED = 'Worked for ';

export interface TerminalOptions {
  readonly columns?: number;
  readonly rows?: number;
}

const KEYS = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  'Shift+Tab': '\x1b[Z',
  Backspace: '\x7f',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  'Ctrl+C': '\x03',
  'Ctrl+D': '\x04',
} as const;

export type TerminalKey = keyof typeof KEYS;

const ECHO_TAIL = 16;

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function startTerminal(model: FakeModel, home: TestHome, options: TerminalOptions) {
  await model.listen();
  const modelName = 'terminal-smoke-model';
  await writeKimiConfig(home.dataDir, fakeModelConfig(model, { modelName }));
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 36;
  const screen = new VirtualTerminal(columns, rows);
  const cli = TestProcess.start({
    label: 'CLI',
    command: kimiCliCommand(),
    cwd: home.workspace,
    env: kimiCliEnv(home, { KIMI_CODE_TUI_FULL_SCREEN: '0', COLUMNS: String(columns), LINES: String(rows) }),
    logDir: home.root,
    stdin: true,
    fetchStubs: cliFetchStubs(),
  });
  screen.onReply((reply) => {
    if (!cli.exited) cli.stdin.write(reply);
  });
  cli.onOutput((data) => screen.write(data));
  const inputs: string[] = [];
  const viewport = async () => (await screen.flushAndGetViewport()).join('\n');
  const diagnostics = async () => [
    `CLI exit=${String(cli.exit()?.code ?? null)} signal=${String(cli.exit()?.signal ?? null)}; recent input=${JSON.stringify(inputs)}`,
    `Screen:\n${await viewport()}`,
    `Stderr:\n${cli.stderrTail()}`,
    `Model requests: ${JSON.stringify(model.requests().map(({ index, lane, state }) => ({ index, lane, state })))}`,
  ].join('\n');
  const send = (input: string) => {
    inputs.push(input.slice(-200));
    if (inputs.length > 12) inputs.shift();
    cli.stdin.write(input);
  };
  const waitFor = async (description: string, ready: (screen: string) => boolean, timeout = TIMEOUTS.frame) => {
    try {
      await expect.poll(async () => cli.exited || ready(await viewport()), { timeout }).toBe(true);
      if (cli.exited) throw new Error('CLI exited');
    } catch (cause) {
      throw new Error(`Waiting for ${description}\n${await diagnostics()}`, { cause });
    }
  };
  return {
    modelName, diagnostics, viewport,
    waitForText: (text: string, timeout?: number) => waitFor(`${JSON.stringify(text)} to appear`, (screen) => screen.includes(text), timeout),
    waitForTextGone: (text: string, timeout?: number) => waitFor(`${JSON.stringify(text)} to disappear`, (screen) => !screen.includes(text), timeout),
    waitForTurnToFinish: (timeout?: number) => waitFor('the turn to finish', (screen) => screen.includes(TURN_FINISHED), timeout),
    scrollback: async () => { await screen.flush(); return screen.getScrollBuffer().join('\n'); },
    type: async (text: string) => {
      const echo = text.length <= columns - 4 ? text : text.slice(-ECHO_TAIL);
      const before = occurrences(await viewport(), echo);
      for (const char of text) {
        send(char);
        await delayBetweenKeystrokes(20);
      }
      await waitFor(`the typed text ${JSON.stringify(echo)} to appear`, (screen) => occurrences(screen, echo) > before);
    },
    paste: (text: string) => send(`\x1b[200~${text}\x1b[201~`),
    press: (key: TerminalKey) => send(KEYS[key]),
    close: async () => {
      const early = cli.exited;
      if (!early) cli.stdin.write('\x03\x1b[200~/exit\x1b[201~\r');
      let forced = false;
      const fallback = setTimeout(() => {
        forced = true;
        void cli.forceKill();
      }, TIMEOUTS.wait);
      let exit;
      try {
        exit = await cli.closed;
      } finally {
        clearTimeout(fallback);
      }
      if (forced) throw new Error(`CLI failed to close within ${TIMEOUTS.wait} ms; forced process tree cleanup\n${await diagnostics()}`);
      if (early || exit.code !== 0) throw new Error(`Unexpected CLI exit\n${await diagnostics()}`);
      const blocked = await cli.networkViolations();
      if (blocked.length > 0) throw new Error(`TUI child network violations: ${JSON.stringify(blocked)}\n${await diagnostics()}`);
    },
  };
}

type TerminalSession = Omit<Awaited<ReturnType<typeof startTerminal>>, 'close' | 'diagnostics' | 'modelName'>;

export interface TerminalFixtures extends HomeFixtures, ModelFixtures {
  terminal: TerminalSession;
}

export function terminalFixturesWith(options: TerminalOptions) {
  return {
    ...homeFixtures(),
    ...modelFixtures(),
    terminal: async ({ model, testHome, onTestFailed }: HomeFixtures & ModelFixtures & TestContext, use: Use<TerminalSession>) => {
      const terminal = await startTerminal(model, testHome, options);
      onTestFailed(async () => { process.stderr.write((await terminal.diagnostics()) + '\n'); });
      try {
        await terminal.waitForText(terminal.modelName, TIMEOUTS.server);
        await use(terminal);
      } finally {
        await terminal.close();
      }
    },
  };
}

export const terminalFixtures = terminalFixturesWith({});
