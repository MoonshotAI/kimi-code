import { appendFileSync, writeFileSync } from 'node:fs';

import { SURFACES, VARIANTS, type Surface, type Variant } from './verbs';

interface Annotation {
  readonly type: string;
  readonly description?: string;
}

interface ReportedTest {
  readonly title: string;
  readonly annotations: readonly Annotation[];
  titlePath(): string[];
}

type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

type RunStatus = 'passed' | 'failed' | 'timedout' | 'interrupted';

interface ReportedError {
  readonly message?: string;
}

interface ReportedResult {
  readonly status: TestStatus;
  readonly duration: number;
  readonly errors: readonly ReportedError[];
  readonly annotations?: readonly Annotation[];
}

interface Shard {
  readonly current: number;
  readonly total: number;
}

interface ReportedProject {
  readonly name: string;
  readonly use: { readonly surface?: unknown; readonly variant?: unknown };
}

interface ReportedConfig {
  readonly shard: Shard | null;
  readonly projects: readonly ReportedProject[];
}

interface ProjectView {
  readonly surface: Surface | undefined;
  readonly title: string;
}

interface ReportedRun {
  readonly status: RunStatus;
  readonly duration: number;
}

interface Outcome {
  readonly surface: string;
  readonly file: string;
  readonly title: string;
  readonly status: TestStatus;
  readonly duration: number;
  readonly note: string;
}

interface FailedCase {
  readonly project: string;
  readonly file: string;
  readonly title: string;
  readonly status: TestStatus;
  readonly note: string;
}

interface ResultsFile {
  readonly platform: NodeJS.Platform;
  readonly shard: Shard | null;
  readonly status: RunStatus;
  readonly errors: readonly string[];
  readonly failures: readonly FailedCase[];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const LONGEST_NOTE = 200;
const NOT_APPLICABLE = /^not applicable on [^:]*: /;

const STATUS_WORDS: Readonly<Record<TestStatus, string>> = {
  passed: '✅ 通过',
  failed: '❌ 失败',
  timedOut: '❌ 超时',
  skipped: '⏭️ 不适用',
  interrupted: '⚠️ 中断',
};

const RUN_WORDS: Readonly<Record<RunStatus, string>> = {
  passed: '通过',
  failed: '没通过',
  timedout: '整体超时',
  interrupted: '被中断',
};

const SURFACE_NAMES: Readonly<Record<Surface, string>> = { tui: 'TUI', acp: 'ACP', desktop: 'Desktop', web: 'Web' };

const VARIANT_TITLES: Readonly<Record<Variant, string>> = {
  'kitty-keyboard': '终端支持 Kitty 键盘协议',
  'bare-editor': '编辑器不声明 fs 和终端',
};

const FRAME_PLACES: Readonly<Record<Surface, string>> = {
  tui: '每一步之后的终端屏幕在「Attachments」里',
  acp: 'ACP 没有界面，每一步之后编辑器收到的内容在「Attachments」里',
  desktop: '每一步之后的截图在「Screenshots」里',
  web: '每一步之后的截图在「Screenshots」里',
};

const TRACE_ATTACHMENTS: Readonly<Record<Surface, string | undefined>> = {
  tui: undefined,
  acp: undefined,
  desktop: 'desktop-trace',
  web: 'web-trace',
};

function isSurface(name: unknown): name is Surface {
  return (SURFACES as readonly unknown[]).includes(name);
}

function isVariant(name: unknown): name is Variant {
  return typeof name === 'string' && name in VARIANTS;
}

function projectView(name: string, project: ReportedProject | undefined): ProjectView {
  const surface = isSurface(project?.use.surface) ? project.use.surface : isSurface(name) ? name : undefined;
  const variant = project?.use.variant;
  const base = surface === undefined ? name : SURFACE_NAMES[surface];
  return { surface, title: isVariant(variant) ? `${base}（${VARIANT_TITLES[variant]}）` : base };
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} 秒`;
}

function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll(/\s+/g, ' ').trim();
}

function headline(error: ReportedError | undefined): string {
  const lines = (error?.message ?? '')
    .replaceAll(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [first = '', second] = lines;
  const joined = first.endsWith(':') && second !== undefined ? `${first} ${second}` : first;
  return joined.length > LONGEST_NOTE ? `${joined.slice(0, LONGEST_NOTE)}…` : joined;
}

function noteOf(test: ReportedTest, result: ReportedResult): string {
  if (result.status !== 'skipped') return headline(result.errors[0]);
  const skip = [...(result.annotations ?? []), ...test.annotations].find((annotation) => annotation.type === 'skip');
  return (skip?.description ?? '').replace(NOT_APPLICABLE, '');
}

function failed(outcome: Outcome): boolean {
  return outcome.status === 'failed' || outcome.status === 'timedOut' || outcome.status === 'interrupted';
}

function viewingHints(name: string, surface: Surface | undefined, shard: Shard | null): string[] {
  const platform = process.platform === 'win32' ? 'windows-' : '';
  const report = `e2e-${platform}${surface ?? name}-report${shard === null ? '' : `-${shard.current}`}`;
  const hints = [
    `看画面：下载本次运行的 artifact \`${report}\`，解压后双击 \`index.html\`，点进场景。${surface === undefined ? '每一步之后的画面在用例的附件里' : FRAME_PLACES[surface]}，按步骤编号排列。`,
  ];
  const trace = surface === undefined ? undefined : TRACE_ATTACHMENTS[surface];
  if (trace !== undefined) {
    hints.push(`失败的用例另有 Playwright trace，在附件 \`${trace}\` 里：下载后在仓库里运行 \`pnpm --filter @moonshot-ai/e2e exec playwright show-trace <下载的 zip>\` 打开。`);
  }
  return hints;
}

function section(name: string, view: ProjectView, outcomes: readonly Outcome[], shard: Shard | null): string[] {
  const scenarios = outcomes.filter((outcome) => outcome.file.startsWith('scenarios/')).toSorted((left, right) => left.file.localeCompare(right.file));
  const selfTests = outcomes.filter((outcome) => outcome.file.startsWith('self-test/'));
  const failures = outcomes.filter(failed);
  const verdict = failures.length === 0 ? '用例全部通过' : `${failures.length} 条用例没通过`;
  const lines = [
    `### ${view.title}：${verdict}`,
    '',
    '| 场景 | 结果 | 耗时 | 说明 |',
    '|---|---|---|---|',
    ...scenarios.map((outcome) => `| ${cell(outcome.title)} | ${STATUS_WORDS[outcome.status]} | ${seconds(outcome.duration)} | ${cell(outcome.note)} |`),
    '',
    `驱动自测：共 ${selfTests.length} 条，通过 ${selfTests.filter((outcome) => outcome.status === 'passed').length} 条，没通过 ${selfTests.filter(failed).length} 条，不适用 ${selfTests.filter((outcome) => outcome.status === 'skipped').length} 条。`,
  ];
  const brokenSelfTests = selfTests.filter(failed);
  if (brokenSelfTests.length > 0) {
    lines.push('', '没通过的自测：', ...brokenSelfTests.map((outcome) => `- \`${outcome.title}\`：${cell(outcome.note)}`));
  }
  lines.push('', ...viewingHints(name, view.surface, shard), '');
  return lines;
}

export default class RunSummary {
  private readonly outcomes = new Map<string, Outcome>();
  private readonly errors: string[] = [];
  private shard: Shard | null = null;
  private projects: readonly ReportedProject[] = [];

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: ReportedConfig): void {
    this.shard = config.shard === null || config.shard.total === 1 ? null : config.shard;
    this.projects = config.projects;
  }

  onError(error: ReportedError): void {
    this.errors.push(headline(error));
  }

  onTestEnd(test: ReportedTest, result: ReportedResult): void {
    const [, surface = '', path = ''] = test.titlePath();
    const file = path.replaceAll('\\', '/');
    const outcome = { surface, file, title: test.title, status: result.status, duration: result.duration, note: noteOf(test, result) };
    this.outcomes.set(test.titlePath().join('\u0000'), outcome);
  }

  onEnd(run: ReportedRun): void {
    const outcomes = [...this.outcomes.values()];
    const views = new Map(this.projects.map((project) => [project.name, projectView(project.name, project)]));
    const view = (name: string): ProjectView => views.get(name) ?? projectView(name, undefined);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && summary !== '') appendFileSync(summary, this.summary(run, outcomes, view));
    const results = process.env['E2E_RESULTS_FILE'];
    if (results !== undefined && results !== '') writeFileSync(results, this.results(run, outcomes, view));
  }

  private results(run: ReportedRun, outcomes: readonly Outcome[], view: (name: string) => ProjectView): string {
    const file: ResultsFile = {
      platform: process.platform,
      shard: this.shard,
      status: run.status,
      errors: this.errors,
      failures: outcomes
        .filter(failed)
        .map((outcome) => ({ project: view(outcome.surface).title, file: outcome.file, title: outcome.title, status: outcome.status, note: outcome.note })),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  private summary(run: ReportedRun, outcomes: readonly Outcome[], view: (name: string) => ProjectView): string {
    const order = this.projects.map((project) => project.name);
    const rank = (name: string): number => (order.includes(name) ? order.indexOf(name) : order.length);
    const surfaces = [...new Set(outcomes.map((outcome) => outcome.surface))].toSorted((left, right) => rank(left) - rank(right));
    const part = this.shard === null ? '' : `第 ${this.shard.current}/${this.shard.total} 片，`;
    const lines = [`## 新 E2E：${RUN_WORDS[run.status]}（${part}用时 ${seconds(run.duration)}）`, ''];
    if (this.errors.length > 0) {
      lines.push('不属于任何用例的错误（例如加载场景文件时出错），这时下面的表可能不全：', '', ...this.errors.map((error) => `- ${cell(error)}`), '');
    }
    lines.push(...surfaces.flatMap((name) => section(name, view(name), outcomes.filter((outcome) => outcome.surface === name), this.shard)));
    return `${lines.join('\n')}\n`;
  }
}
