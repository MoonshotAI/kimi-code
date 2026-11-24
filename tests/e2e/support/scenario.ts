import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contentDigest,
  createTestHome,
  directoryChanges,
  snapshotDirectory,
  writeKimiConfig,
  type DirectorySnapshot,
  type TestHome,
} from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, startFakeModel, type FakeModel } from '@moonshot-ai/testkit/model';
import { expect, test as base, type TestInfo } from '@playwright/test';

import { startAcp } from '../surfaces/acp';
import { startDesktop } from '../surfaces/desktop';
import { startTui } from '../surfaces/tui';
import { startWeb } from '../surfaces/web';
import { SURFACES, VERBS, type Product, type Surface, type SurfaceDriver, type SurfaceLaunch, type Verb } from './verbs';

export { expect };

export interface SurfaceOptions {
  surface: Surface | undefined;
}

export interface ScenarioOptions {
  readonly workspace?: Readonly<Record<string, string>>;
  readonly except?: Readonly<Partial<Record<Surface, string>>>;
  readonly onlyOn?: readonly Surface[];
  readonly reason?: string;
}

export interface Workspace {
  read(path: string): Promise<string>;
  expectFile(path: string, content: string): Promise<void>;
  expectMissing(path: string): Promise<void>;
}

export interface ScenarioContext {
  readonly product: Product;
  readonly model: FakeModel;
  readonly workspace: Workspace;
}

export type ScenarioBody = (context: ScenarioContext) => Promise<void>;

export interface SelfTestCase extends ScenarioOptions {
  readonly run: ScenarioBody;
}

export type SelfTestCases = Readonly<Record<string, SelfTestCase>>;

export interface SelfTestSuite {
  readonly positive: SelfTestCases;
  readonly negative: SelfTestCases;
}

const SELF_TEST_KINDS = ['positive', 'negative'] as const;
const SELF_TEST_DIRECTORY = fileURLToPath(new URL('../self-test/', import.meta.url));

function startSurface(surface: Surface, launch: SurfaceLaunch): Promise<SurfaceDriver> {
  switch (surface) {
    case 'tui':
      return startTui(launch);
    case 'acp':
      return startAcp(launch);
    case 'desktop':
      return startDesktop(launch);
    case 'web':
      return startWeb(launch);
  }
}

function assertOutsideGitWorkTree(workspace: string): void {
  for (let directory = workspace; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) {
      throw new Error(
        `The scenario workspace ${workspace} is inside the git work tree at ${directory}. ` +
          'On POSIX the product approves Edit and Write automatically inside a git work tree, so approval scenarios would hang. ' +
          'Point TMPDIR at a directory outside every repository.',
      );
    }
    if (dirname(directory) === directory) return;
  }
}

function workspaceKey(path: string): string {
  const normalized = normalize(path);
  if (path === '' || isAbsolute(path) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`A workspace path must be relative and stay inside the workspace, got ${JSON.stringify(path)}`);
  }
  return normalized.split(sep).join('/');
}

async function seedWorkspace(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, workspaceKey(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertPrompt(text: string): void {
  if (!/^[ -~]+$/.test(text) || text !== text.trim()) {
    throw new Error(`send() takes one line of printable ASCII without surrounding spaces, got ${JSON.stringify(text)}`);
  }
  if (text.endsWith('\\')) {
    throw new Error(`send() cannot end with a backslash: the product reads a backslash before Enter as a line break and never submits. Got ${JSON.stringify(text)}`);
  }
  if (/^[/!@]/.test(text)) {
    throw new Error(
      `send() cannot take a prompt that starts with "/", "!" or "@": the product reads those as a slash command, shell mode or a file mention. Got ${JSON.stringify(text)}`,
    );
  }
}

function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ScenarioSession {
  private readonly surface: Surface;
  private readonly declared = new Map<string, string | undefined>();
  private home: TestHome | undefined;
  private model: FakeModel | undefined;
  private driver: SurfaceDriver | undefined;
  private baseline: DirectorySnapshot | undefined;
  private interfaceChecks = 0;

  constructor(surface: Surface) {
    this.surface = surface;
  }

  async start(options: ScenarioOptions): Promise<ScenarioContext> {
    const home = await createTestHome(`e2e-${this.surface}`);
    this.home = home;
    assertOutsideGitWorkTree(home.workspace);
    await seedWorkspace(home.workspace, options.workspace ?? {});
    const model = await startFakeModel();
    this.model = model;
    await writeKimiConfig(home.dataDir, fakeModelConfig(model));
    const driver = await startSurface(this.surface, { home, model });
    this.driver = driver;
    this.baseline = await snapshotDirectory(home.workspace);
    return { product: this.userActions(driver), model, workspace: this.workspace(home.workspace) };
  }

  async finish(testInfo: TestInfo): Promise<void> {
    const { home, model, driver } = this;
    if (home === undefined) return;
    let clean = false;
    try {
      const passed = testInfo.status === testInfo.expectedStatus;
      const problems = passed ? await this.closingProblems() : [];
      if (!passed || problems.length > 0) await this.attachDiagnostics(testInfo);
      if (problems.length > 0) throw new Error(`The scenario body passed, but the closing checks failed:\n\n${problems.join('\n\n')}`);
      clean = passed;
    } finally {
      await driver?.kill();
      await model?.close();
      if (clean) await home.remove();
      else testInfo.annotations.push({ type: 'test home', description: home.root });
    }
  }

  private userActions(driver: SurfaceDriver): Product {
    return {
      send: async (text) => {
        assertPrompt(text);
        await driver.send(text);
      },
      approve: () => driver.approve(),
      reject: () => driver.reject(),
      stop: () => driver.stop(),
      waitIdle: () => driver.waitIdle(),
      expectTool: async (expectation) => {
        await driver.expectTool(expectation);
        this.interfaceChecks += 1;
      },
      expectReply: async (text) => {
        await driver.expectReply(text);
        this.interfaceChecks += 1;
      },
    };
  }

  private workspace(root: string): Workspace {
    return {
      read: (path) => readFile(join(root, workspaceKey(path)), 'utf8'),
      expectFile: async (path, content) => {
        const key = workspaceKey(path);
        this.declared.set(key, contentDigest(content));
        expect(await readIfPresent(join(root, key)), `workspace file ${key}`).toBe(content);
      },
      expectMissing: async (path) => {
        const key = workspaceKey(path);
        this.declared.set(key, undefined);
        expect(await readIfPresent(join(root, key)), `workspace file ${key} should not exist`).toBeUndefined();
      },
    };
  }

  private async closingProblems(): Promise<string[]> {
    const { home, model, driver, baseline } = this;
    if (home === undefined || model === undefined || driver === undefined || baseline === undefined) return [];
    const problems: string[] = [];
    try {
      await driver.close();
    } catch (error) {
      problems.push(`The product did not shut down cleanly:\n${problemOf(error)}`);
    }
    try {
      const violations = await driver.networkViolations();
      if (violations.length > 0) {
        problems.push(
          `The product tried to reach ${violations.length} address(es) outside this machine; only the fake model may be contacted:\n${violations.map((violation) => `- ${violation}`).join('\n')}`,
        );
      }
    } catch (error) {
      problems.push(`The network guard record could not be read:\n${problemOf(error)}`);
    }
    if (this.interfaceChecks === 0) {
      problems.push('The scenario never checked the interface. Add at least one product.expectTool() or product.expectReply().');
    }
    try {
      model.verify();
    } catch (error) {
      problems.push(`The fake model reported problems:\n${problemOf(error)}`);
    }
    const changes = directoryChanges(this.expectedWorkspace(baseline), await snapshotDirectory(home.workspace));
    if (changes.length > 0) {
      problems.push(
        [
          'The workspace differs from what the scenario declared:',
          ...changes.map((change) => `- ${change.kind} ${change.path}`),
          'Declare every expected change with workspace.expectFile() or workspace.expectMissing(); every other file must stay untouched.',
        ].join('\n'),
      );
    }
    return problems;
  }

  private expectedWorkspace(baseline: DirectorySnapshot): DirectorySnapshot {
    const expected: Record<string, string> = { ...baseline };
    for (const [path, digest] of this.declared) {
      if (digest === undefined) delete expected[path];
      else expected[path] = digest;
    }
    return expected;
  }

  private async attachDiagnostics(testInfo: TestInfo): Promise<void> {
    const { home, model, driver } = this;
    if (model !== undefined) {
      const requests = model.requests().map(({ index, lane, state }) => ({ index, lane, state }));
      await testInfo.attach('model-requests', { body: JSON.stringify({ requests, problems: model.problems() }, null, 2), contentType: 'application/json' });
    }
    if (driver !== undefined) {
      for (const diagnostic of await driver.diagnostics()) {
        if ('path' in diagnostic) await testInfo.attach(diagnostic.name, { path: diagnostic.path });
        else await testInfo.attach(diagnostic.name, { body: diagnostic.body, contentType: 'text/plain' });
      }
      const violations = await driver.networkViolations().catch((error: unknown) => [problemOf(error)]);
      await testInfo.attach('network-guard', { body: violations.join('\n'), contentType: 'text/plain' });
    }
    if (home === undefined) return;
    const logs = join(home.dataDir, 'logs');
    for (const entry of await readdir(logs, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile()) await testInfo.attach(`product-log-${entry.name}`, { path: join(logs, entry.name), contentType: 'text/plain' });
    }
  }
}

const test = base.extend<SurfaceOptions & { session: ScenarioSession }>({
  surface: [undefined, { option: true }],
  session: async ({ surface }, use, testInfo) => {
    if (surface === undefined) throw new Error(`The Playwright project must set use.surface to one of: ${SURFACES.join(', ')}`);
    const session = new ScenarioSession(surface);
    await use(session);
    await session.finish(testInfo);
  },
});

function assertReasons(title: string, options: ScenarioOptions): void {
  for (const [surface, reason] of Object.entries(options.except ?? {})) {
    if (reason.trim() === '') throw new Error(`Scenario "${title}" excludes ${surface} without a reason.`);
  }
  if (options.onlyOn !== undefined && (options.onlyOn.length === 0 || (options.reason ?? '').trim() === '')) {
    throw new Error(`Scenario "${title}" uses onlyOn; it must name at least one surface and give a reason.`);
  }
  if (options.onlyOn === undefined && options.reason !== undefined) {
    throw new Error(`Scenario "${title}" gives a reason without onlyOn; put per-surface reasons in except.`);
  }
}

function notApplicableReason(options: ScenarioOptions, surface: Surface): string | undefined {
  const excluded = options.except?.[surface];
  if (excluded !== undefined) return excluded;
  return options.onlyOn === undefined || options.onlyOn.includes(surface) ? undefined : options.reason;
}

export function scenario(title: string, options: ScenarioOptions, body: ScenarioBody): void {
  assertReasons(title, options);
  test(title, async ({ surface, session }, testInfo) => {
    const reason = surface === undefined ? undefined : notApplicableReason(options, surface);
    testInfo.skip(reason !== undefined, `not applicable on ${String(surface)}: ${String(reason)}`);
    await body(await session.start(options));
  });
}

function selfTestFile(verb: Verb): string {
  return `${verb.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.spec.ts`;
}

export function selfTest(verb: Verb, suite: SelfTestSuite): void {
  for (const kind of SELF_TEST_KINDS) {
    const cases = Object.entries(suite[kind]);
    for (const [title, options] of cases) assertReasons(`${verb} ${kind}: ${title}`, options);
    const uncovered = SURFACES.filter((surface) => cases.every(([, options]) => notApplicableReason(options, surface) !== undefined));
    if (uncovered.length > 0) {
      throw new Error(`The ${verb} self-test has no ${kind} case on: ${uncovered.join(', ')}. Every user action needs both kinds on every surface.`);
    }
    for (const [title, { run, ...options }] of cases) scenario(`${verb} ${kind}: ${title}`, options, run);
  }
}

export function selfTestCoverage(): void {
  test('every user action has a self-test file that declares its positive and negative cases', () => {
    const missing = VERBS.filter((verb) => {
      const file = join(SELF_TEST_DIRECTORY, selfTestFile(verb));
      return !existsSync(file) || !readFileSync(file, 'utf8').includes(`selfTest('${verb}',`);
    });
    expect(
      missing.map((verb) => `${verb}: expected self-test/${selfTestFile(verb)} to call selfTest('${verb}', …)`),
      'user actions without a self-test',
    ).toEqual([]);
  });
}
