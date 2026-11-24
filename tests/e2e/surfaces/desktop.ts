import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killProcessTree, kimiCliEnv, NETWORK_GUARD_PRELOAD, networkGuardEnv, readNetworkViolations, repoPath, TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';
import { _electron, type ElectronApplication } from '@playwright/test';

import type { Diagnostic, SurfaceDriver, SurfaceLaunch } from '../support/verbs';
import { offlineStubs } from './offline';
import { OFFLINE_NAMES, PageDriver, reasonOf } from './page-driver';

const MAIN_PAGE = 'app://renderer/';
const AUXILIARY_PAGES = /^app:\/\/renderer\/(?:browser-overlay|browser-control|screenshot|pin|capture-host)\b/;
const OUTPUT_TAIL = 64 * 1024;

class DesktopDriver extends PageDriver {
  private readonly app: ElectronApplication;
  private readonly child: ReturnType<ElectronApplication['process']>;
  private readonly workspace: string;
  private readonly networkLog: string;
  private output = '';
  private exit: { readonly code: number | null; readonly signal: string | null } | undefined;

  constructor(app: ElectronApplication, root: string, workspace: string, networkLog: string) {
    super(app.context(), root, 'desktop');
    this.app = app;
    this.child = app.process();
    this.workspace = workspace;
    this.networkLog = networkLog;
    const collect = (chunk: Buffer): void => {
      this.output = (this.output + chunk.toString()).slice(-OUTPUT_TAIL);
    };
    this.child.stdout?.on('data', collect);
    this.child.stderr?.on('data', collect);
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
    });
  }

  async ready(): Promise<void> {
    await this.startTrace();
    const page = await this.wait('the main window to open', () =>
      this.app.windows().find((candidate) => candidate.url().startsWith(MAIN_PAGE) && !AUXILIARY_PAGES.test(candidate.url())),
    );
    this.show(page, this.workspace);
    await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUTS.server });
    const welcome = page.getByRole('dialog', { name: 'Welcome to Kimi Code' });
    await welcome.waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    await welcome.getByRole('button', { name: 'Skip', exact: true }).click({ timeout: TIMEOUTS.wait });
    await welcome.waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await page.getByRole('button', { name: basename(this.workspace), exact: true }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    await page.getByRole('status', { name: 'Connecting…' }).first().waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await page.getByRole('combobox', { name: 'Message input' }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
  }

  async startupFailure(error: unknown): Promise<Error> {
    const page = await this.readPage();
    await this.saveTrace();
    await this.kill();
    return new Error(
      [
        `The Desktop app did not become ready: ${reasonOf(error)}`,
        page,
        this.describe(),
        ...(existsSync(this.trace) ? [`A trace of the start-up is at ${this.trace}`] : []),
      ].join('\n'),
      { cause: error },
    );
  }

  async close(): Promise<void> {
    if (this.exit !== undefined) throw new Error(`The Desktop app exited before the scenario closed it.\n${this.describe()}`);
    await this.leave();
    let closed: { readonly refused: string | undefined } | undefined;
    void this.app.close().then(
      () => {
        closed = { refused: undefined };
      },
      (error: unknown) => {
        closed = { refused: reasonOf(error) };
      },
    );
    let exit;
    try {
      exit = await until('the Desktop app to exit', () => this.exit, { timeoutMs: TIMEOUTS.server });
    } catch (cause) {
      throw new Error(`The Desktop app did not exit after it was asked to quit.\n${this.describe()}`, { cause });
    }
    const stuck = await this.finishClosing(() => closed);
    const problems = [
      ...(exit.code === 0 ? [] : [`The Desktop app exited with code ${String(exit.code)} and signal ${String(exit.signal)}.`]),
      ...(stuck === undefined ? [] : [stuck]),
      ...(closed?.refused === undefined ? [] : [`Closing the Desktop app reported: ${closed.refused}`]),
      ...this.pageProblems(),
    ];
    if (problems.length > 0) throw new Error(`${problems.join('\n')}\n${this.describe()}`);
  }

  async kill(): Promise<void> {
    if (this.exit === undefined) await this.forceExit();
    this.dropOutput();
  }

  async networkViolations(): Promise<readonly string[]> {
    return [...(await readNetworkViolations(this.networkLog, 'The Desktop main process')), ...this.beyond];
  }

  async diagnostics(): Promise<readonly Diagnostic[]> {
    if (this.exit === undefined) await this.readPage();
    await this.saveTrace();
    return [...this.pageDiagnostics(), { name: 'desktop-session', body: this.describe() }];
  }

  private async forceExit(): Promise<void> {
    const pid = this.child.pid;
    if (pid !== undefined) killProcessTree(pid);
    try {
      await until('the Desktop app to exit after it was killed', () => this.exit, { timeoutMs: TIMEOUTS.wait });
    } catch {
      this.output = `${this.output}\nThe Desktop app did not exit after it was killed.`;
    }
  }

  private async finishClosing(closed: () => object | undefined): Promise<string | undefined> {
    if (await this.within('closing the Desktop app to finish', closed)) return undefined;
    const gone = await this.within("the Desktop app's own processes to exit", () => (this.ownProcessesAlive() ? undefined : true));
    if (!gone) return 'The Desktop app exited, but processes of its own were still running.';
    this.output = `${this.output}\nThe app and its own processes had exited, but its output was still held open by something outside its process group.`;
    this.dropOutput();
    if (await this.within('closing the Desktop app to finish', closed)) return undefined;
    return 'The Desktop app exited, but closing it never finished.';
  }

  private async within(label: string, check: () => unknown): Promise<boolean> {
    try {
      await until(label, check, { timeoutMs: TIMEOUTS.wait });
      return true;
    } catch {
      return false;
    }
  }

  private ownProcessesAlive(): boolean {
    const pid = this.child.pid;
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private dropOutput(): void {
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  private async wait<T>(label: string, check: () => T | undefined): Promise<Exclude<T, undefined>> {
    let outcome: { readonly value: Exclude<T, undefined> } | { readonly exited: true };
    try {
      outcome = await until(
        label,
        () => {
          const value = check();
          if (value !== undefined) return { value: value as Exclude<T, undefined> };
          return this.exit === undefined ? undefined : { exited: true as const };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      throw new Error(`${reasonOf(cause)}\n${this.describe()}`, { cause });
    }
    if ('exited' in outcome) throw new Error(`The Desktop app exited while the test waited for ${label}.\n${this.describe()}`);
    return outcome.value;
  }

  private describe(): string {
    return [
      this.exit === undefined ? 'The Desktop app is still running.' : `The Desktop app exited with code ${String(this.exit.code)} and signal ${String(this.exit.signal)}.`,
      `Windows: ${this.exit === undefined ? this.app.windows().map((page) => page.url()).join(', ') : '(closed)'}`,
      this.describePage(),
      `Output:\n${this.output === '' ? '(empty)' : this.output}`,
    ].join('\n');
  }
}

export async function startDesktop({ home }: SurfaceLaunch): Promise<SurfaceDriver> {
  const desktop = repoPath('apps', 'desktop');
  for (const built of [join(desktop, 'out', 'main.cjs'), join(desktop, 'desktop-dist', 'index.html')]) {
    if (!existsSync(built)) throw new Error(`${built} does not exist; build the Desktop app first with "pnpm --filter kimi-code-app run build".`);
  }
  const networkLog = join(home.root, 'desktop-network.log');
  const app = await _electron.launch({
    args: ['-r', fileURLToPath(NETWORK_GUARD_PRELOAD), desktop, `--user-data-dir=${join(home.root, 'user-data')}`, '--lang=en-US', `--workspace=${home.workspace}`, OFFLINE_NAMES],
    cwd: home.workspace,
    env: {
      ...kimiCliEnv(home, {
        ELECTRON_RUN_AS_NODE: undefined,
        LANG: 'en_US.UTF-8',
        KIMI_DESKTOP_E2E: process.env['E2E_HEADED'] === '1' ? '1' : 'quiet',
        KIMI_DESKTOP_NO_SHELL_ENV: '1',
      }),
      ...networkGuardEnv(networkLog, offlineStubs()),
    },
    timeout: TIMEOUTS.server,
  });
  const driver = new DesktopDriver(app, home.root, home.workspace, networkLog);
  try {
    await driver.ready();
  } catch (error) {
    throw await driver.startupFailure(error);
  }
  return driver;
}
