import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delayBetweenKeystrokes } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { killProcessTree, testEnv, TIMEOUTS, writeKimiConfig, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, type FakeModel } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures, type Use } from '@moonshot-ai/testkit/vitest';
import { expect, type TestContext } from 'vitest';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

async function startTerminal(model: FakeModel, home: TestHome) {
  await model.listen();
  const modelName = 'terminal-smoke-model';
  await writeKimiConfig(home.dataDir, fakeModelConfig(model, { modelName }));
  const columns = 100;
  const rows = 36;
  const screen = new VirtualTerminal(columns, rows);
  const reportPath = join(home.root, 'blocked-network.json');
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    '--import', new URL('../../../../../../build/register-raw-text-loader.mjs', import.meta.url).href,
    '--import', new URL('./loopback-only.ts', import.meta.url).href,
    fileURLToPath(new URL('../../../../src/main.ts', import.meta.url)),
  ], {
    cwd: home.workspace,
    detached: process.platform !== 'win32',
    env: testEnv({ set: {
      HOME: home.home,
      USERPROFILE: home.home,
      XDG_CONFIG_HOME: join(home.home, '.config'),
      XDG_CACHE_HOME: join(home.home, '.cache'),
      XDG_DATA_HOME: join(home.home, '.local', 'share'),
      APPDATA: join(home.home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home.home, 'AppData', 'Local'),
      KIMI_CODE_HOME: home.dataDir,
      KIMI_CODE_BASE_URL: 'http://client-config.example.test',
      KIMI_CODE_TRUST_WORKSPACE: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CODE_TUI_FULL_SCREEN: '0',
      COLUMNS: String(columns),
      LINES: String(rows),
      KIMI_E2E_NETWORK_REPORT: reportPath,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.dev.json', import.meta.url)),
    } }),
  });
  let stderr = '';
  const inputs: string[] = [];
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  const recordError = (error: Error) => { stderr = (stderr + error.message + '\n').slice(-8192); };
  child.on('error', recordError);
  child.stdin.on('error', recordError);
  child.stdout.setEncoding('utf8').on('data', (data: string) => screen.write(data));
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr = (stderr + data).slice(-8192); });
  const viewport = async () => (await screen.flushAndGetViewport()).join('\n');
  const diagnostics = async () => [
    `CLI exit=${child.exitCode} signal=${child.signalCode}; recent input=${JSON.stringify(inputs)}`,
    `Screen:\n${await viewport()}`,
    `Stderr:\n${stderr}`,
    `Model requests: ${JSON.stringify(model.requests().map(({ index, lane, state }) => ({ index, lane, state })))}`,
  ].join('\n');
  const send = (input: string) => {
    inputs.push(input.slice(-200));
    if (inputs.length > 12) inputs.shift();
    child.stdin.write(input);
  };
  const waitText = async (value: string, visible = true, timeout = TIMEOUTS.frame) => {
    try {
      await expect.poll(async () => exited || (await viewport()).includes(value) === visible, { timeout }).toBe(true);
      if (exited) throw new Error('CLI exited');
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
      const early = exited || child.exitCode !== null || child.signalCode !== null;
      if (!early) child.stdin.write('\x03\x1b[200~/exit\x1b[201~\r');
      let forced = false;
      const fallback = setTimeout(() => {
        forced = true;
        if (child.pid !== undefined) killProcessTree(child.pid);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, TIMEOUTS.wait);
      try {
        await closed;
      } finally {
        clearTimeout(fallback);
      }
      if (forced) throw new Error(`CLI failed to close within ${TIMEOUTS.wait} ms; forced process tree cleanup\n${await diagnostics()}`);
      if (early || child.exitCode !== 0) throw new Error(`Unexpected CLI exit\n${await diagnostics()}`);
      const blocked: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
      if (!Array.isArray(blocked) || blocked.length > 0) {
        throw new Error(`TUI child network violations: ${JSON.stringify(blocked)}\n${await diagnostics()}`);
      }
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
