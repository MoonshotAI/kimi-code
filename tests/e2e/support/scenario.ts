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
import { DISK_TITLES, STEP_TITLES } from './steps';
import {
  absenceReason,
  SURFACES,
  VERB_NAMES,
  verbOn,
  verbSpec,
  wantedOutput,
  type Actions,
  type ApprovalExpectation,
  type Diagnostic,
  type Frame,
  type ProductOn,
  type Surface,
  type SurfaceDriver,
  type SurfaceLaunch,
  type SurfacesOf,
  type ToolExpectation,
  type Verb,
} from './verbs';

export { expect };

export interface SurfaceOptions {
  surface: Surface | undefined;
}

export interface ScenarioOptions {
  readonly workspace?: Readonly<Record<string, string>>;
  readonly homeFiles?: Readonly<Record<string, string>>;
  readonly except?: Readonly<Partial<Record<Surface, string>>>;
  readonly onlyOn?: readonly Surface[];
  readonly reason?: string;
}

export interface Workspace {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  expectFile(path: string, content: string): Promise<void>;
  expectMissing(path: string): Promise<void>;
}

export interface ScenarioContext<S extends Surface> {
  readonly product: ProductOn<S>;
  readonly model: FakeModel;
  readonly workspace: Workspace;
}

export type ScenarioBody<S extends Surface> = (context: ScenarioContext<S>) => Promise<void>;

interface RunningContext {
  readonly product: Actions;
  readonly model: FakeModel;
  readonly workspace: Workspace;
}

type RunningBody = (context: RunningContext) => Promise<void>;

export type RunsOn<O extends ScenarioOptions> = O extends { readonly onlyOn: readonly (infer S)[] }
  ? Extract<S, Surface>
  : O extends { readonly except: infer E }
    ? Exclude<Surface, keyof E>
    : Surface;

export interface SelfTestCase<S extends Surface> extends ScenarioOptions {
  readonly run: ScenarioBody<S>;
}

export type SelfTestCases<S extends Surface> = Readonly<Record<string, SelfTestCase<S>>>;

export interface SelfTestSuite<S extends Surface> {
  readonly positive: SelfTestCases<S>;
  readonly negative: SelfTestCases<S>;
}

type FramePolicy = 'every-step' | 'on-failure';

const SELF_TEST_KINDS = ['positive', 'negative'] as const;
const SELF_TEST_DIRECTORY = fileURLToPath(new URL('../self-test/', import.meta.url));

function startSurface(surface: Surface, launch: SurfaceLaunch): Promise<SurfaceDriver<Surface>> {
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

async function seedFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
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

function promptCheck(verb: 'send' | 'queue' | 'steer'): (text: string) => void {
  return (text) => {
    if (!/^[ -~]+$/.test(text) || text !== text.trim()) {
      throw new Error(`${verb}() takes one line of printable ASCII without surrounding spaces, got ${JSON.stringify(text)}`);
    }
    if (text.endsWith('\\')) {
      throw new Error(`${verb}() cannot end with a backslash: the product reads a backslash before Enter as a line break and never submits. Got ${JSON.stringify(text)}`);
    }
    if (/^[/!@]/.test(text)) {
      throw new Error(
        `${verb}() cannot take a prompt that starts with "/", "!" or "@": the product reads those as a slash command, shell mode or a file mention. Got ${JSON.stringify(text)}`,
      );
    }
  };
}

function assertToolExpectation(expectation: ToolExpectation): void {
  const asked: { readonly name: string; readonly status: string; readonly output?: unknown } = expectation;
  if (asked.name !== 'Bash' && (asked.status === 'running' || asked.output !== undefined)) {
    throw new Error(`expectTool() can expect a running tool, or the output of a tool, only for Bash, not for ${asked.name}.`);
  }
  if (asked.status === 'rejected' && asked.output !== undefined) {
    throw new Error('expectTool() cannot expect output of a rejected command: it never ran.');
  }
  if (asked.status === 'running' && asked.output === undefined) {
    throw new Error(
      'expectTool() can expect a running command only together with output it has printed: until a command prints, the surfaces do not agree on whether it is running or still waiting for approval.',
    );
  }
  const output = wantedOutput(expectation);
  if (output === undefined) return;
  if (!/^[ -~]+$/.test(output) || output !== output.trim()) {
    throw new Error(`expectTool() takes the output as one line of printable ASCII without surrounding spaces, got ${JSON.stringify(output)}`);
  }
  if (expectation.target.includes(output)) {
    throw new Error(
      `expectTool() cannot tell the output ${JSON.stringify(output)} from the command ${JSON.stringify(expectation.target)}: it is part of the command, and the interface shows the command next to its output. Make the command print text that it does not contain.`,
    );
  }
}

function lineCheck(verb: 'expectError' | 'expectAbsent' | 'rejectWithFeedback' | 'answer' | 'answerOther'): (text: string) => void {
  return (text) => {
    if (!/^[ -~]+$/.test(text) || text !== text.trim()) {
      throw new Error(`${verb}() takes one line of printable ASCII without surrounding spaces, got ${JSON.stringify(text)}`);
    }
  };
}

function assertApprovalExpectation({ name, target }: ApprovalExpectation): void {
  if (!/^[ -~]+$/.test(target) || target !== target.trim()) {
    throw new Error(`expectApproval() takes the target as one line of printable ASCII without surrounding spaces, got ${JSON.stringify(target)}`);
  }
  if (name !== 'Bash' && workspaceKey(target) !== target) {
    throw new Error(`expectApproval() takes the file as a normalized path relative to the workspace, like "notes/a.txt", got ${JSON.stringify(target)}`);
  }
}

const PRECHECKS: { readonly [V in Verb]?: (...args: Parameters<Actions[V]>) => void } = {
  send: promptCheck('send'),
  queue: promptCheck('queue'),
  steer: promptCheck('steer'),
  expectTool: assertToolExpectation,
  rejectWithFeedback: lineCheck('rejectWithFeedback'),
  answer: lineCheck('answer'),
  answerOther: lineCheck('answerOther'),
  expectApproval: assertApprovalExpectation,
  expectError: lineCheck('expectError'),
  expectAbsent: lineCheck('expectAbsent'),
};

const READS_THE_LATEST_TURN: ReadonlySet<Verb> = new Set(['expectReply', 'expectTool', 'expectError', 'expectAbsent']);

function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ScenarioSession {
  private readonly surface: Surface;
  private readonly declared = new Map<string, string | undefined>();
  private home: TestHome | undefined;
  private model: FakeModel | undefined;
  private driver: SurfaceDriver<Surface> | undefined;
  private baseline: DirectorySnapshot | undefined;
  private interfaceChecks = 0;
  private frames: FramePolicy = 'on-failure';
  private testInfo: TestInfo | undefined;
  private steps = 0;
  private failedStep: string | undefined;
  private launches = 1;
  private lastPrompt: string | undefined;
  private turnSinceLaunch = true;
  private readonly earlierDiagnostics: Diagnostic[] = [];

  constructor(surface: Surface) {
    this.surface = surface;
  }

  async start(options: ScenarioOptions, frames: FramePolicy, testInfo: TestInfo): Promise<RunningContext> {
    this.frames = frames;
    this.testInfo = testInfo;
    const home = await createTestHome(`e2e-${this.surface}`);
    this.home = home;
    assertOutsideGitWorkTree(home.workspace);
    await Promise.all([
      seedFiles(home.workspace, options.workspace ?? {}),
      seedFiles(home.home, options.homeFiles ?? {}),
    ]);
    const model = await startFakeModel();
    this.model = model;
    await writeKimiConfig(home.dataDir, fakeModelConfig(model));
    await base.step('启动产品，等到可以输入', async () => {
      this.driver = await startSurface(this.surface, { home, model });
      this.baseline = await snapshotDirectory(home.workspace);
      if (frames === 'every-step') await this.show('00 启动完成');
    });
    return { product: this.userActions(), model, workspace: this.workspace(home.workspace) };
  }

  async finish(testInfo: TestInfo): Promise<void> {
    const { home, model } = this;
    if (home === undefined) return;
    let clean = false;
    try {
      const passed = testInfo.status === testInfo.expectedStatus;
      if (!passed) await this.show(this.failedStep === undefined ? `${this.nextStep()} 失败时的画面` : `${this.failedStep}：失败时的画面`);
      const problems = passed ? await this.closingProblems() : [];
      if (!passed || problems.length > 0) await this.attachDiagnostics(testInfo);
      if (problems.length > 0) throw new Error(`The scenario body passed, but the closing checks failed:\n\n${problems.join('\n\n')}`);
      clean = passed;
    } finally {
      await this.driver?.kill();
      await model?.close();
      if (clean) await home.remove();
      else testInfo.annotations.push({ type: 'test home', description: home.root });
    }
  }

  private userActions(): Actions {
    return Object.fromEntries(VERB_NAMES.map((verb) => [verb, (...args: readonly unknown[]) => this.perform(verb, args)])) as unknown as Actions;
  }

  private async perform(verb: Verb, args: readonly unknown[]): Promise<void> {
    const number = this.nextStep();
    const title = (STEP_TITLES[verb] as (...values: readonly unknown[]) => string)(...args);
    this.failedStep = undefined;
    await base.step(title, async () => {
      try {
        (PRECHECKS[verb] as ((...values: readonly unknown[]) => void) | undefined)?.(...args);
        await this.dispatch(verb, args);
      } catch (error) {
        this.failedStep = `${number} ${title}`;
        throw error;
      }
      if (verbSpec(verb).checksInterface) this.interfaceChecks += 1;
      if (this.frames === 'every-step') await this.show(`${number} ${title}之后`);
    });
  }

  private async dispatch(verb: Verb, args: readonly unknown[]): Promise<void> {
    if (verb === 'restart') {
      await this.restart();
      return;
    }
    if (READS_THE_LATEST_TURN.has(verb) && !this.turnSinceLaunch) {
      throw new Error(`${verb}() reads the latest turn, and no turn has started since restart(); check the restored conversation with expectTranscript().`);
    }
    if (!verbOn(verb, this.surface)) {
      throw new Error(
        `${verb}() does not exist on ${this.surface}: ${absenceReason(verb, this.surface)} Leave ${this.surface} out of the scenario with except or onlyOn.`,
      );
    }
    const driver = this.driver;
    if (driver === undefined) throw new Error(`${verb}() was called while the product is not running.`);
    const method: unknown = Reflect.get(driver, verb);
    if (typeof method !== 'function') throw new Error(`The ${this.surface} driver does not implement ${verb}().`);
    await Reflect.apply(method, driver, args);
    if (verb === 'continue') this.turnSinceLaunch = true;
    if (verb === 'send' || verb === 'queue' || verb === 'steer') {
      this.lastPrompt = String(args[0]);
      this.turnSinceLaunch = true;
    }
  }

  private async restart(): Promise<void> {
    const { home, model, driver } = this;
    if (home === undefined || model === undefined || driver === undefined) throw new Error('restart() was called while the product is not running.');
    if (!(await driver.idle())) {
      throw new Error('restart() needs an idle product: a user lets the turn end, or stops it, and answers any approval before closing the app.');
    }
    const state = driver.reopenState();
    const problems = await this.shutdownProblems(driver);
    for (const diagnostic of await driver.diagnostics()) this.earlierDiagnostics.push({ ...diagnostic, name: `launch-${this.launches}-${diagnostic.name}` });
    await driver.kill();
    this.driver = undefined;
    if (problems.length > 0) throw new Error(`The product did not shut down cleanly before restart():\n\n${problems.join('\n\n')}`);
    this.launches += 1;
    this.driver = await startSurface(this.surface, { home, model, reopen: { launch: this.launches, lastPrompt: this.lastPrompt, state } });
    this.turnSinceLaunch = false;
  }

  private async shutdownProblems(driver: SurfaceDriver<Surface>): Promise<string[]> {
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
    return problems;
  }

  private nextStep(): string {
    this.steps += 1;
    return String(this.steps).padStart(2, '0');
  }

  private async show(name: string): Promise<void> {
    const { driver, testInfo } = this;
    if (driver === undefined || testInfo === undefined) return;
    let frame: Frame;
    try {
      frame = await driver.frame();
    } catch (error) {
      frame = { kind: 'text', text: `取不到这一刻的画面：${problemOf(error)}` };
    }
    if (frame.kind === 'image') await testInfo.attach(`${name}.png`, { body: frame.png, contentType: 'image/png' });
    else await testInfo.attach(`${name}.txt`, { body: frame.text, contentType: 'text/plain' });
  }

  private workspace(root: string): Workspace {
    return {
      read: (path) => readFile(join(root, workspaceKey(path)), 'utf8'),
      write: (path, content) =>
        base.step(DISK_TITLES.write(path, content), async () => {
          const key = workspaceKey(path);
          await seedFiles(root, { [key]: content });
          this.declared.set(key, contentDigest(content));
        }),
      expectFile: (path, content) =>
        base.step(DISK_TITLES.file(path, content), async () => {
          const key = workspaceKey(path);
          this.declared.set(key, contentDigest(content));
          expect(await readIfPresent(join(root, key)), `workspace file ${key}`).toBe(content);
        }),
      expectMissing: (path) =>
        base.step(DISK_TITLES.missing(path), async () => {
          const key = workspaceKey(path);
          this.declared.set(key, undefined);
          expect(await readIfPresent(join(root, key)), `workspace file ${key} should not exist`).toBeUndefined();
        }),
    };
  }

  private async closingProblems(): Promise<string[]> {
    const { home, model, driver, baseline } = this;
    if (home === undefined || model === undefined || driver === undefined || baseline === undefined) return [];
    const problems = await this.shutdownProblems(driver);
    if (this.interfaceChecks === 0) {
      problems.push('The scenario never checked the interface. Add at least one product.expectTool(), product.expectReply() or another product.expect…() check.');
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
    for (const diagnostic of this.earlierDiagnostics) {
      if ('path' in diagnostic) await testInfo.attach(diagnostic.name, { path: diagnostic.path });
      else await testInfo.attach(diagnostic.name, { body: diagnostic.body, contentType: 'text/plain' });
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

function register(title: string, options: ScenarioOptions, body: RunningBody, frames: FramePolicy): void {
  assertReasons(title, options);
  test(title, async ({ surface, session }, testInfo) => {
    const reason = surface === undefined ? undefined : notApplicableReason(options, surface);
    testInfo.skip(reason !== undefined, `not applicable on ${String(surface)}: ${String(reason)}`);
    await body(await session.start(options, frames, testInfo));
  });
}

export function scenario<const O extends ScenarioOptions>(title: string, options: O, body: ScenarioBody<RunsOn<O>>): void {
  register(title, options, body as unknown as RunningBody, 'every-step');
}

function selfTestFile(verb: Verb): string {
  return `${verb.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.spec.ts`;
}

function withinVerb(verb: Verb, title: string, options: ScenarioOptions): ScenarioOptions {
  const spec = verbSpec(verb);
  const absent = SURFACES.filter((surface) => !spec.on.includes(surface));
  if (absent.length === 0) return options;
  if (options.onlyOn !== undefined) {
    const outside = options.onlyOn.filter((surface) => !spec.on.includes(surface));
    if (outside.length > 0) throw new Error(`Self-test "${title}" runs on ${outside.join(', ')}, where ${verb}() does not exist.`);
    return options;
  }
  const reasons = absent.map((surface) => [surface, `${verb}() does not exist here: ${absenceReason(verb, surface)}`]);
  return { ...options, except: { ...Object.fromEntries(reasons), ...options.except } };
}

export function selfTestCase<const O extends ScenarioOptions>(options: O, run: ScenarioBody<RunsOn<O>>): SelfTestCase<Surface> {
  return { ...options, run: run as unknown as ScenarioBody<Surface> };
}

export function selfTest<V extends Verb>(verb: V, suite: SelfTestSuite<SurfacesOf<V>>): void {
  const surfaces = SURFACES.filter((surface) => verbOn(verb, surface));
  for (const kind of SELF_TEST_KINDS) {
    const cases = Object.entries(suite[kind]).map(([title, { run, ...options }]) => {
      const name = `${verb} ${kind}: ${title}`;
      return { name, run, options: withinVerb(verb, name, options) };
    });
    for (const { name, options } of cases) assertReasons(name, options);
    const uncovered = surfaces.filter((surface) => cases.every(({ options }) => notApplicableReason(options, surface) !== undefined));
    if (uncovered.length > 0) {
      throw new Error(`The ${verb} self-test has no ${kind} case on: ${uncovered.join(', ')}. Every user action needs both kinds on every surface where it exists.`);
    }
    for (const { name, run, options } of cases) register(name, options, run as unknown as RunningBody, 'on-failure');
  }
}

export function selfTestCoverage(): void {
  test('every user action has a self-test file that declares its positive and negative cases', () => {
    const missing = VERB_NAMES.filter((verb) => {
      const file = join(SELF_TEST_DIRECTORY, selfTestFile(verb));
      return !existsSync(file) || !readFileSync(file, 'utf8').includes(`selfTest('${verb}',`);
    });
    expect(
      missing.map((verb) => `${verb}: expected self-test/${selfTestFile(verb)} to call selfTest('${verb}', …)`),
      'user actions without a self-test',
    ).toEqual([]);
  });
}
