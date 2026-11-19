import { setTimeout as delayBetweenKeystrokes } from 'node:timers/promises';

import { KIMI_REGION_PROFILES } from '@moonshot-ai/kimi-code-oauth';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { kimiCliCommand, kimiCliEnv, kimiServiceStubs, TestProcess, TIMEOUTS, writeKimiConfig, type FetchStub, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, type FakeModel } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures, type Use } from '@moonshot-ai/testkit/vitest';
import { expect, type TestContext } from 'vitest';

import { getFdAssetName } from '#/utils/process/fd-detect';

function unavailableDownloads(): FetchStub[] {
  const asset = getFdAssetName();
  if (asset === null) return [];
  return Object.values(KIMI_REGION_PROFILES).map(({ cdnBase }) => ({ method: 'GET', url: `${cdnBase}/fd/${asset}`, status: 404 }));
}

async function startTerminal(model: FakeModel, home: TestHome) {
  await model.listen();
  const modelName = 'terminal-smoke-model';
  await writeKimiConfig(home.dataDir, fakeModelConfig(model, { modelName }));
  const columns = 100;
  const rows = 36;
  const screen = new VirtualTerminal(columns, rows);
  const cli = TestProcess.start({
    label: 'CLI',
    command: kimiCliCommand(),
    cwd: home.workspace,
    env: kimiCliEnv(home, { KIMI_CODE_TUI_FULL_SCREEN: '0', COLUMNS: String(columns), LINES: String(rows) }),
    logDir: home.root,
    stdin: true,
    fetchStubs: [...kimiServiceStubs(), ...unavailableDownloads()],
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
  const waitText = async (value: string, visible = true, timeout = TIMEOUTS.frame) => {
    try {
      await expect.poll(async () => cli.exited || (await viewport()).includes(value) === visible, { timeout }).toBe(true);
      if (cli.exited) throw new Error('CLI exited');
    } catch (cause) {
      throw new Error(`Waiting for ${JSON.stringify(value)} to ${visible ? 'appear' : 'disappear'}\n${await diagnostics()}`, { cause });
    }
  };
  return {
    modelName, diagnostics, viewport,
    waitForText: (text: string, timeout?: number) => waitText(text, true, timeout),
    waitForTextGone: (text: string, timeout?: number) => waitText(text, false, timeout),
    scrollback: async () => { await screen.flush(); return screen.getScrollBuffer().join('\n'); },
    type: async (text: string) => {
      for (const char of text) {
        send(char);
        await delayBetweenKeystrokes(20);
      }
    },
    paste: (text: string) => send(`\x1b[200~${text}\x1b[201~`),
    press: (key: 'Enter' | 'Escape' | 'Ctrl+C') => send({ Enter: '\r', Escape: '\x1b', 'Ctrl+C': '\x03' }[key]),
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

export const terminalFixtures = {
  ...homeFixtures(),
  ...modelFixtures(),
  terminal: async ({ model, testHome, onTestFailed }: HomeFixtures & ModelFixtures & TestContext, use: Use<TerminalSession>) => {
    const terminal = await startTerminal(model, testHome);
    onTestFailed(async () => { process.stderr.write((await terminal.diagnostics()) + '\n'); });
    try {
      await terminal.waitForText(terminal.modelName, TIMEOUTS.server);
      await use(terminal);
    } finally {
      await terminal.close();
    }
  },
};
