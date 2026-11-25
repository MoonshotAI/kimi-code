import { appendFileSync } from 'node:fs';

import { SURFACES, type Surface } from './verbs';

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

interface ReportedConfig {
  readonly shard: Shard | null;
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

function isSurface(name: string): name is Surface {
  return (SURFACES as readonly string[]).includes(name);
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

function viewingHints(surface: string, shard: Shard | null): string[] {
  const known = isSurface(surface);
  const platform = process.platform === 'win32' ? 'windows-' : '';
  const report = `e2e-${platform}${surface}-report${shard === null ? '' : `-${shard.current}`}`;
  const hints = [
    `看画面：下载本次运行的 artifact \`${report}\`，解压后双击 \`index.html\`，点进场景。${known ? FRAME_PLACES[surface] : '每一步之后的画面在用例的附件里'}，按步骤编号排列。`,
  ];
  const trace = known ? TRACE_ATTACHMENTS[surface] : undefined;
  if (trace !== undefined) {
    hints.push(`失败的用例另有 Playwright trace，在附件 \`${trace}\` 里：下载后在仓库里运行 \`pnpm --filter @moonshot-ai/e2e exec playwright show-trace <下载的 zip>\` 打开。`);
  }
  return hints;
}

function section(surface: string, outcomes: readonly Outcome[], shard: Shard | null): string[] {
  const scenarios = outcomes.filter((outcome) => outcome.file.startsWith('scenarios/')).toSorted((left, right) => left.file.localeCompare(right.file));
  const selfTests = outcomes.filter((outcome) => outcome.file.startsWith('self-test/'));
  const failures = outcomes.filter(failed);
  const verdict = failures.length === 0 ? '用例全部通过' : `${failures.length} 条用例没通过`;
  const lines = [
    `### ${isSurface(surface) ? SURFACE_NAMES[surface] : surface}：${verdict}`,
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
  lines.push('', ...viewingHints(surface, shard), '');
  return lines;
}

export default class RunSummary {
  private readonly outcomes = new Map<string, Outcome>();
  private readonly errors: string[] = [];
  private shard: Shard | null = null;

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: ReportedConfig): void {
    this.shard = config.shard;
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
    const target = process.env['GITHUB_STEP_SUMMARY'];
    if (target === undefined || target === '') return;
    const outcomes = [...this.outcomes.values()];
    const rank = (surface: string): number => (isSurface(surface) ? SURFACES.indexOf(surface) : SURFACES.length);
    const surfaces = [...new Set(outcomes.map((outcome) => outcome.surface))].toSorted((left, right) => rank(left) - rank(right));
    const part = this.shard === null ? '' : `第 ${this.shard.current}/${this.shard.total} 片，`;
    const lines = [`## 新 E2E：${RUN_WORDS[run.status]}（${part}用时 ${seconds(run.duration)}）`, ''];
    if (this.errors.length > 0) {
      lines.push('不属于任何用例的错误（例如加载场景文件时出错），这时下面的表可能不全：', '', ...this.errors.map((error) => `- ${cell(error)}`), '');
    }
    lines.push(...surfaces.flatMap((surface) => section(surface, outcomes.filter((outcome) => outcome.surface === surface), this.shard)));
    appendFileSync(target, `${lines.join('\n')}\n`);
  }
}
