import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';

import {
  KIMI_SERVICE_URL,
  killProcessTree,
  kimiServiceStubs,
  NETWORK_GUARD_PRELOAD,
  networkGuardEnv,
  osHomeEnv,
  readNetworkViolations,
  testEnv,
} from '@moonshot-ai/testkit/fixtures';
import { startFakeModel, type FakeModel } from '@moonshot-ai/testkit/model';

import { connectBrowserAgent, type BrowserAgent } from './agent';
import { startStubModel, stubModelConfig, type ModelRequest, type PermissionMode, type StubModel } from './model';
import { startFixturePages, type FixturePages } from './pages';
import { closeApp, CLOSE_TIMEOUT_MS, killSurvivors, windowsDescendants, windowsLoad, within } from './processes';
import { saveSnapshot } from './snapshot';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAIN_SHIM = fileURLToPath(new URL('./main-shim.cjs', import.meta.url));
const NETWORK_GUARD = fileURLToPath(NETWORK_GUARD_PRELOAD);
const OFFLINE_MODELS_DEV = { method: 'GET', url: 'https://models.dev/api.json', status: 404 };
const PAGE_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = process.platform === 'win32' ? 90_000 : 30_000;
const AUXILIARY_PAGES = /^app:\/\/renderer\/(browser-overlay|browser-control|screenshot|pin|capture-host)\b/;

export const quietMode = process.env['KIMI_E2E_HEADLESS'] === '1';

export interface NativeCall {
  readonly api: string;
  readonly detail: string;
}

export interface DesktopApp {
  readonly electron: ElectronApplication;
  readonly window: Page;
  readonly workspace: string;
  readonly downloads: string;
  readonly serverOrigin: string;
  readonly page: (matches: (url: string) => boolean, description: string) => Promise<Page>;
  readonly overlay: () => Promise<Page>;
  readonly controlSurface: () => Promise<Page>;
  readonly startAgentTurn: (prompt: string) => Promise<BrowserAgent>;
  readonly submit: (prompt: string) => Promise<void>;
  readonly startTurn: (prompt: string) => Promise<ModelRequest>;
  readonly sessionId: () => Promise<string>;
  readonly trustWorkspace: () => Promise<void>;
  readonly relaunch: () => Promise<void>;
  readonly waitForExit: () => Promise<number | null>;
  readonly snapshot: (name: string) => Promise<void>;
}

export interface Options {
  seedWorkspace: boolean;
  permissionMode: PermissionMode | undefined;
  appEnv: Record<string, string | undefined>;
  extraConfig: string;
  onboarded: boolean;
}

export interface Fixtures {
  scratch: string;
  model: StubModel;
  modelServer: StubModel | FakeModel;
  pages: FixturePages;
  app: DesktopApp;
  agent: BrowserAgent;
}

interface Launch {
  readonly electron: ElectronApplication;
  readonly output: string[];
  readonly mcpUrl: () => string | undefined;
  readonly serverOrigin: () => string | undefined;
}

interface LaunchReport {
  readonly nativeCalls: NativeCall[];
  readonly unusedAnswers: string[];
  readonly closeError: string | null;
  readonly leftovers: string[];
}
async function findPage(electron: ElectronApplication, matches: (url: string) => boolean, description: string, timeout = PAGE_TIMEOUT_MS): Promise<Page> {
  let found: Page | undefined;
  try {
    await expect.poll(() => {
      found = electron.windows().find(page => !page.isClosed() && matches(page.url()));
      return found !== undefined;
    }, { timeout }).toBe(true);
  } catch (error) {
    const open = electron.windows().map(page => decodeURIComponent(page.url()).slice(0, 600));
    const native = await electron
      .evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => `${contents.getType()} ${contents.getURL().slice(0, 600)}`))
      .catch((reason: unknown) => [`unavailable: ${String(reason)}`]);
    const load = windowsLoad();
    const busiest = load.length > 0 ? `\nBusiest processes:\n${load.map(line => `- ${line}`).join('\n')}` : '';
    throw new Error(`Timed out waiting for the ${description} page.\nPlaywright pages:\n${open.map(url => `- ${url}`).join('\n')}\nElectron web contents:\n${native.map(url => `- ${decodeURIComponent(url)}`).join('\n')}${busiest}`, { cause: error });
  }
  return found!;
}

async function trustWorkspaceIn(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Trust project' }).click({ timeout: 30_000 });
  await expect(window.getByRole('button', { name: 'Trust project' })).toBeHidden();
}

async function seedRenderer(window: Page, origin: string, workspace: string | null, onboarded: boolean): Promise<void> {
  await window.evaluate(async ([serverOrigin, root, done]) => {
    if (done) localStorage.setItem('kimi-web.onboarded', '1');
    localStorage.setItem('kimi-locale', 'en');
    localStorage.setItem('kimi-web.notify-enabled', '0');
    localStorage.setItem('kimi-web.notify-sound', '0');
    if (root === null) return;
    await fetch(`${serverOrigin}/api/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    });
  }, [origin, workspace, onboarded] as const);
  await window.reload();
  if (workspace !== null) {
    await trustWorkspaceIn(window);
    await expect(window.getByRole('combobox').first()).toBeVisible({ timeout: 30_000 });
  }
}

async function attachLog(testInfo: TestInfo, name: string, lines: readonly string[]): Promise<void> {
  if (lines.length > 0) await testInfo.attach(name, { body: lines.join(''), contentType: 'text/plain' });
}

export const test = base.extend<Options & Fixtures>({
  seedWorkspace: [true, { option: true }],
  permissionMode: [undefined, { option: true }],
  appEnv: [{}, { option: true }],
  extraConfig: ['', { option: true }],
  onboarded: [true, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  scratch: async ({}, use, testInfo) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'kimi-desktop-e2e-')));
    await use(dir);
    if (testInfo.status === testInfo.expectedStatus) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } else {
      testInfo.annotations.push({ type: 'scratch', description: dir });
    }
  },

  // eslint-disable-next-line no-empty-pattern
  model: async ({}, use) => {
    const model = await startStubModel();
    await use(model);
    await model.close();
  },

  // eslint-disable-next-line no-empty-pattern
  pages: async ({}, use) => {
    const pages = await startFixturePages();
    await use(pages);
    await pages.close();
  },

  modelServer: async ({ model }, use) => use(model),

  app: async ({ scratch, modelServer, seedWorkspace, permissionMode, appEnv, extraConfig, onboarded }, use, testInfo) => {
    const home = join(scratch, 'home');
    const osHome = join(scratch, 'os-home');
    const userData = join(scratch, 'user-data');
    const downloads = join(scratch, 'downloads');
    const workspace = join(scratch, 'workspace');
    await Promise.all([home, osHome, userData, downloads, workspace].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(join(home, 'config.toml'), stubModelConfig(modelServer.baseUrl, permissionMode, 'verify' in modelServer ? 'test-key' : 'sk-e2e') + extraConfig);
    const token = randomBytes(24).toString('base64url');
    const networkLog = join(scratch, 'network.log');
    const env = testEnv({
      set: {
        ELECTRON_RUN_AS_NODE: undefined,
        KIMI_CODE_SEARCH_WORKER: undefined,
        KIMI_CODE_PERSISTENCE_MINIDB_READMODEL: undefined,
        ...osHomeEnv(osHome),
        ...networkGuardEnv(networkLog, [...kimiServiceStubs(), OFFLINE_MODELS_DEV]),
        KIMI_CODE_HOME: home,
        KIMI_CODE_BASE_URL: KIMI_SERVICE_URL,
        KIMI_BROWSER_MCP_TEST_TOKEN: token,
        KIMI_MCP_RECONNECT_INITIAL_DELAY_MS: '600000',
        KIMI_MCP_RECONNECT_MAX_DELAY_MS: '600000',
        KIMI_DESKTOP_NO_SHELL_ENV: '1',
        KIMI_DESKTOP_E2E: quietMode ? 'quiet' : '1',
        KIMI_E2E_DOWNLOADS_DIR: downloads,
        LANG: 'en_US.UTF-8',
        ...appEnv,
      },
    });

    const output: string[] = [];
    const rendererErrors: string[] = [];
    const nativeCalls: NativeCall[] = [];
    const unusedAnswers: string[] = [];
    const focusRequests: string[] = [];
    const closeErrors: string[] = [];
    const leftovers: string[] = [];
    const agents: BrowserAgent[] = [];

    const launchElectron = async (): Promise<Launch> => {
      const electron = await _electron.launch({
        args: ['-r', MAIN_SHIM, '-r', NETWORK_GUARD, DESKTOP_DIR, `--user-data-dir=${userData}`, '--lang=en-US'],
        cwd: workspace,
        env,
      });
      const launchOutput: string[] = [];
      let mcpUrl: string | undefined;
      let serverOrigin: string | undefined;
      const collect = (chunk: Buffer): void => {
        const text = chunk.toString();
        output.push(text);
        launchOutput.push(text);
        mcpUrl ??= /Browser MCP listening on (\S+)/.exec(launchOutput.join(''))?.[1];
        serverOrigin ??= /embedded server listening on (http:\/\/[^\s/]+)/.exec(launchOutput.join(''))?.[1];
      };
      electron.process().stdout?.on('data', collect);
      electron.process().stderr?.on('data', collect);
      electron.context().on('weberror', event => {
        if (event.page()?.url().startsWith('app://renderer/')) {
          const error = event.error();
          rendererErrors.push(error.stack ?? error.message);
        }
      });
      electron.context().on('dialog', () => undefined);
      try {
        await electron.context().tracing.start({ screenshots: true, snapshots: true });
      } catch (error) {
        await closeApp(electron);
        throw error;
      }
      return { electron, output: launchOutput, mcpUrl: () => mcpUrl, serverOrigin: () => serverOrigin };
    };

    const traces: Array<{ path: string; clean: boolean }> = [];
    const exitedLaunches = new Set<Launch>();
    const shutdown = async (launch: Launch, tracePath: string): Promise<LaunchReport> => {
      const { electron } = launch;
      if (exitedLaunches.has(launch)) return { nativeCalls: [], unusedAnswers: [], closeError: null, leftovers: [] };
      await electron.context().tracing.stop({ path: tracePath }).catch(() => undefined);
      const report = await electron
        .evaluate(() => {
          const state = globalThis as {
            __kimiE2eNativeCalls?: NativeCall[];
            __kimiE2eFocusRequests?: string[];
            __kimiE2eScriptedAnswers?: Array<{ api: string }>;
          };
          return {
            nativeCalls: state.__kimiE2eNativeCalls ?? [],
            focusRequests: state.__kimiE2eFocusRequests ?? [],
            unusedAnswers: (state.__kimiE2eScriptedAnswers ?? []).map(entry => entry.api),
          };
        })
        .catch(() => ({ nativeCalls: [] as NativeCall[], focusRequests: [] as string[], unusedAnswers: [] as string[] }));
      focusRequests.push(...report.focusRequests);
      const { error, leftovers } = await closeApp(electron);
      traces.push({ path: tracePath, clean: report.nativeCalls.length === 0 && report.unusedAnswers.length === 0 && error === null });
      return { nativeCalls: report.nativeCalls, unusedAnswers: report.unusedAnswers, closeError: error, leftovers };
    };

    const record = (report: LaunchReport): void => {
      nativeCalls.push(...report.nativeCalls);
      unusedAnswers.push(...report.unusedAnswers);
      if (report.closeError !== null) closeErrors.push(report.closeError);
      leftovers.push(...report.leftovers);
    };

    let serverOrigin = '';
    const open = async (launch: Launch, seed: 'workspace' | 'storage' | 'none'): Promise<Page> => {
      const window = await findPage(launch.electron, url => url.startsWith('app://renderer/') && !AUXILIARY_PAGES.test(url), 'main renderer', STARTUP_TIMEOUT_MS);
      await window.waitForLoadState('domcontentloaded');
      await expect.poll(launch.serverOrigin, { message: 'waiting for the embedded server address in the app log', timeout: STARTUP_TIMEOUT_MS }).toBeDefined();
      serverOrigin = launch.serverOrigin()!;
      if (quietMode) await window.emulateMedia({ reducedMotion: 'reduce' });
      if (seed !== 'none') await seedRenderer(window, serverOrigin, seed === 'workspace' ? workspace : null, onboarded);
      await expect.poll(launch.mcpUrl, { message: 'waiting for the browser MCP endpoint in the app log', timeout: 30_000 }).toBeDefined();
      return window;
    };

    let current = await launchElectron();
    let currentWindow: Page | undefined;
    let launches = 1;
    let snapshots = 0;
    let failure: unknown;
    try {
      currentWindow = await open(current, seedWorkspace ? 'workspace' : 'storage');
      const app: DesktopApp = {
        get electron() { return current.electron; },
        get window() { return currentWindow!; },
        workspace,
        downloads,
        get serverOrigin() { return serverOrigin; },
        page: (matches, description) => findPage(current.electron, matches, description),
        overlay: () => findPage(current.electron, url => url.startsWith('app://renderer/browser-overlay.html'), 'browser overlay'),
        controlSurface: () => findPage(current.electron, url => url.startsWith('app://renderer/browser-control.html'), 'browser control surface'),
        snapshot: async (name) => {
          snapshots += 1;
          await saveSnapshot(testInfo, current.electron, currentWindow!, AUXILIARY_PAGES, snapshots, name);
        },
        trustWorkspace: () => trustWorkspaceIn(currentWindow!),
        relaunch: async () => {
          if ('releaseTurns' in modelServer) modelServer.releaseTurns();
          await Promise.allSettled(agents.splice(0).map(agent => agent.close()));
          record(await shutdown(current, testInfo.outputPath(`trace-launch-${launches}.zip`)));
          launches += 1;
          current = await launchElectron();
          currentWindow = undefined;
          currentWindow = await open(current, 'none');
        },
        waitForExit: async () => {
          const launch = current;
          const child = launch.electron.process();
          const running = child.exitCode === null && child.signalCode === null;
          const tree = process.platform === 'win32' && running && child.pid !== undefined ? windowsDescendants(child.pid) : [];
          if (running) {
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
            if (await within(exited, CLOSE_TIMEOUT_MS) === 'timeout') throw new Error(`Electron did not exit within ${CLOSE_TIMEOUT_MS} ms`);
          }
          if (!exitedLaunches.has(launch)) {
            exitedLaunches.add(launch);
            if (child.pid !== undefined) killProcessTree(child.pid);
            const leftovers = killSurvivors(tree);
            for (const stream of child.stdio) stream?.destroy();
            const settled = await within(launch.electron.close().catch(() => undefined), CLOSE_TIMEOUT_MS);
            const errors: string[] = [];
            if (settled === 'timeout') errors.push(`Playwright did not settle ${CLOSE_TIMEOUT_MS} ms after Electron exited (exit code ${child.exitCode}, signal ${child.signalCode}) and its pipes were closed.`);
            if (leftovers.length > 0) errors.push(`Electron exited but left processes running; they were killed: ${leftovers.join(', ')}`);
            const blocked = [...launch.output.join('').matchAll(/\[kimi-e2e\] blocked native (\S+): ([^\n]*)/g)];
            record({ nativeCalls: blocked.map(match => ({ api: match[1]!, detail: match[2]! })), unusedAnswers: [], closeError: errors.length > 0 ? errors.join('\n') : null, leftovers });
          }
          return child.exitCode;
        },
        submit: async (prompt) => {
          const window = currentWindow!;
          await window.getByRole('combobox', { name: 'Message input' }).click();
          await window.keyboard.type(prompt);
          await window.keyboard.press('Enter');
        },
        startTurn: async (prompt) => {
          if (!('releaseTurns' in modelServer)) throw new Error('Use app.submit and provider.waitForRequest with the testkit provider');
          const model = modelServer;
          const next = model.requests().length;
          await app.submit(prompt);
          return model.waitForRequest(next);
        },
        sessionId: async () => {
          let sessionId: string | undefined;
          await expect.poll(() => {
            sessionId = /\/sessions\/([^/?#]+)/.exec(currentWindow!.url())?.[1];
            return sessionId;
          }, { message: 'waiting for the session route' }).toBeDefined();
          return decodeURIComponent(sessionId!);
        },
        startAgentTurn: async (prompt) => {
          const window = currentWindow!;
          if (!('releaseTurns' in modelServer)) throw new Error('startAgentTurn requires the browser-agent stub');
          const model = modelServer;
          const held = model.heldTurns();
          const composer = window.getByRole('combobox').first();
          await composer.click();
          await window.keyboard.type(prompt);
          await window.keyboard.press('Enter');
          await expect.poll(() => model.heldTurns(), { message: 'waiting for the agent turn to reach the stub model' }).toBeGreaterThan(held);
          let sessionId: string | undefined;
          await expect.poll(() => {
            sessionId = /\/sessions\/([^/?#]+)/.exec(window.url())?.[1];
            return sessionId;
          }, { message: 'waiting for the session route' }).toBeDefined();
          const mcpUrl = current.mcpUrl()!;
          const agent = await connectBrowserAgent(mcpUrl, token, decodeURIComponent(sessionId!));
          agents.push(agent);
          return agent;
        },
      };
      await use(app);
    } catch (error) {
      failure = error;
    }

    if ('verify' in modelServer) {
      try {
        modelServer.verify();
      } catch (error) {
        failure ??= error;
      }
    } else {
      modelServer.releaseTurns();
    }
    await Promise.allSettled(agents.map(agent => agent.close()));
    record(await shutdown(current, testInfo.outputPath(launches > 1 ? `trace-launch-${launches}.zip` : 'trace.zip')));
    let blockedConnections: readonly string[] = [];
    try {
      blockedConnections = await readNetworkViolations(networkLog, 'The desktop main process');
    } catch (error) {
      failure ??= error;
    }
    const passed = failure === undefined && testInfo.status === testInfo.expectedStatus && blockedConnections.length === 0;
    for (const trace of traces) {
      if (passed && trace.clean && rendererErrors.length === 0) await rm(trace.path, { force: true });
    }
    for (const [type, entries] of [['blocked focus requests', focusRequests], ['killed processes left after exit', leftovers]] as const) {
      if (entries.length === 0) continue;
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
      const summary = [...counts].map(([entry, count]) => `${entry} x${count}`).join(', ');
      testInfo.annotations.push({ type, description: summary });
      process.stderr.write(`[kimi-e2e] ${testInfo.title}: ${type}: ${summary}\n`);
    }
    if (!passed || rendererErrors.length > 0 || closeErrors.length > 0 || nativeCalls.length > 0 || unusedAnswers.length > 0) {
      await attachLog(testInfo, 'renderer-errors', rendererErrors.map(error => error + '\n'));
      await attachLog(testInfo, 'electron-output', output);
      await writeFile(testInfo.outputPath('electron-output.log'), output.join('')).catch(() => undefined);
    }
    if (failure !== undefined) throw failure;
    if (blockedConnections.length > 0) {
      throw new Error(`The desktop main process tried to reach non-loopback addresses; e2e runs must stay offline:\n${blockedConnections.map(target => `- ${target}`).join('\n')}`);
    }
    if (rendererErrors.length > 0 && 'verify' in modelServer) throw new Error(rendererErrors.join('\n'));
    if (nativeCalls.length > 0) {
      throw new Error(`The app requested native UI during the test; e2e runs must never show it:\n${nativeCalls.map(call => `- ${call.api}: ${call.detail}`).join('\n')}`);
    }
    if (unusedAnswers.length > 0) {
      throw new Error(`Scripted native dialog answers were never used: ${unusedAnswers.join(', ')}`);
    }
    if (closeErrors.length > 0) throw new Error(closeErrors.join('\n'));
  },

  agent: async ({ app }, use) => {
    await use(await app.startAgentTurn('Use the browser to check the fixture page.'));
  },
});

export const testWithProvider = test.extend<{ provider: FakeModel }>({
  provider: async ({ scratch }, use, testInfo) => {
    const provider = await startFakeModel({ apiKey: 'test-key' });
    try {
      await use(provider);
      if (testInfo.status === testInfo.expectedStatus) provider.verify();
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus || provider.problems().length > 0) {
          const path = join(scratch, 'provider-requests.json');
          await writeFile(path, JSON.stringify(provider.requests().map(({ index, lane, state }) => ({ index, lane, state }))));
          await testInfo.attach('provider-requests', { path, contentType: 'application/json' });
        }
      } finally {
        await provider.close();
      }
    }
  },
  modelServer: async ({ provider }, use) => use(provider),
});

export { expect };
