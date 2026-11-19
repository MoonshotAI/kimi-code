import { Container, matchesKey, Key, truncateToWidth, type Focusable } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { currentTheme } from '#/tui/theme';
import {
  resolveMigrationScope,
  runMigration as realRunMigration,
  type AnyChoice,
  type MigrationPlan,
  type MigrationPromptResult,
  type MigrationReport,
  type MigrationScope,
  type Prompt1Choice,
  type Prompt2Choice,
  type RunMigrationInput,
} from '@moonshot-ai/migration-legacy';

type Phase = 'ask1' | 'ask2' | 'progress' | 'result';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const SPINNER_INTERVAL_MS = 80;

const STEP_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['config', 'Config'],
  ['mcp', 'MCP'],
  ['user-history', 'REPL history'],
  ['sessions', 'Sessions'],
];

export interface MigrationScreenOptions {
  readonly plan: MigrationPlan;
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly colors?: ColorPalette;
  readonly onComplete: (result: MigrationScreenResult) => void;
  readonly requestRender?: () => void;
  readonly runMigration?: (input: RunMigrationInput) => Promise<MigrationReport>;
  readonly skipDecisionStep?: boolean;
}

export interface MigrationScreenResult {
  readonly decision: 'now' | 'later' | 'never';
  readonly scope?: MigrationScope;
  readonly migrated?: boolean;
}

interface StepDef {
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: AnyChoice }>;
}

export class MigrationScreenComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: MigrationScreenOptions;
  private phase: Phase = 'ask1';
  private selectedIndex = 0;
  private readonly choices: AnyChoice[] = [];
  private progressDone = 0;
  private progressTotal = 0;
  private readonly stepStatus = new Map<string, 'pending' | 'done'>([
    ['config', 'pending'],
    ['mcp', 'pending'],
    ['user-history', 'pending'],
    ['sessions', 'pending'],
  ]);
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private report: MigrationReport | undefined;
  private migrationFailed = false;
  private migrationFailureReason: string | undefined;

  constructor(opts: MigrationScreenOptions) {
    super();
    this.opts = opts;
    if (opts.skipDecisionStep === true) {
      this.phase = 'ask2';
      this.choices.push('now');
    }
  }

  showResult(report: MigrationReport): void {
    this.report = report;
    this.phase = 'result';
    this.stopSpinner();
  }

  showFailure(error?: unknown): void {
    this.migrationFailed = true;
    this.migrationFailureReason = formatMigrationFailureReason(error);
    this.phase = 'result';
    this.stopSpinner();
  }

  enterProgress(): void {
    this.phase = 'progress';
  }

  reportStep(msg: string): void {
    const key = msg.replace(/ done$/, '');
    if (this.stepStatus.has(key)) this.stepStatus.set(key, 'done');
  }

  reportSessionProgress(done: number, total: number): void {
    this.progressDone = done;
    this.progressTotal = total;
  }

  private startSpinner(): void {
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.opts.requestRender?.();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  _testEnterProgress(): void {
    this.enterProgress();
  }
  _testUpdateStep(msg: string): void {
    this.reportStep(msg);
  }
  _testUpdateSessionProgress(done: number, total: number): void {
    this.reportSessionProgress(done, total);
  }
  _testShowResult(report: MigrationReport): void {
    this.showResult(report);
  }

  handleInput(data: string): void {
    if (this.phase === 'ask1' || this.phase === 'ask2') {
      this.handleAskInput(data);
      return;
    }
    if (this.phase === 'result') {
      if (matchesKey(data, Key.enter)) {
        this.opts.onComplete({ decision: 'now', migrated: !this.migrationFailed });
      }
      return;
    }
  }

  private currentStep(): StepDef {
    return stepFor(this.phase, this.opts.plan);
  }

  private handleAskInput(data: string): void {
    const step = this.currentStep();
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(step.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.opts.onComplete({ decision: 'later' });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = step.options[this.selectedIndex];
      if (chosen === undefined) return;
      this.advance(chosen.value);
      return;
    }
  }

  private advance(value: AnyChoice): void {
    this.choices.push(value);
    this.selectedIndex = 0;

    const result: MigrationPromptResult = resolveMigrationScope(this.choices);
    if (this.phase === 'ask1') {
      if (value === 'now') {
        this.phase = 'ask2';
        return;
      }
      this.opts.onComplete({ decision: value as 'later' | 'never' });
      return;
    }
    this.beginMigration(result);
  }

  private beginMigration(result: MigrationPromptResult): void {
    if (result.decision !== 'now' || result.scope === undefined) {
      this.opts.onComplete({ decision: 'later' });
      return;
    }
    this.enterProgress();
    this.startSpinner();
    this.opts.requestRender?.();
    const run = this.opts.runMigration ?? realRunMigration;
    void run({
      plan: this.opts.plan,
      scope: result.scope,
      source: this.opts.sourceHome,
      target: this.opts.targetHome,
      onProgress: (msg) => {
        this.reportStep(msg);
        this.opts.requestRender?.();
      },
      onSessionProgress: (done, total) => {
        this.reportSessionProgress(done, total);
        this.opts.requestRender?.();
      },
    }).then(
      (report) => {
        this.showResult(report);
        this.opts.requestRender?.();
      },
      (error) => {
        this.showFailure(error);
        this.opts.requestRender?.();
      },
    );
  }

  override render(width: number): string[] {
    if (this.phase === 'ask1' || this.phase === 'ask2') {
      return this.renderAsk(width);
    }
    if (this.phase === 'progress') return this.renderProgress(width);
    return this.renderResult(width);
  }

  private renderResult(width: number): string[] {
    const colors = this.opts.colors ?? currentTheme.palette;
    const lines: string[] = [chalk.hex(colors.primary)('─'.repeat(width))];
    if (this.migrationFailed) {
      lines.push(chalk.hex(colors.error).bold(' Migration failed'));
      if (this.migrationFailureReason !== undefined) {
        lines.push('');
        lines.push(chalk.hex(colors.text)(` Reason: ${this.migrationFailureReason}`));
      }
      lines.push('');
      lines.push(chalk.hex(colors.text)(' You can retry later by running "kimi migrate".'));
      lines.push('');
      lines.push(chalk.hex(colors.textMuted)(' ⏎ continue to kimi-code'));
      lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
      return lines.map((l) => truncateToWidth(l, width));
    }
    const r = this.report;
    lines.push(chalk.hex(colors.primary).bold(' Migration complete'));
    lines.push('');
    if (r !== undefined) {
      const sum = r.summary;
      if (sum.sessions.sessionsMigrated > 0) {
        lines.push(
          chalk.hex(colors.success)(`  ✓ ${sum.sessions.sessionsMigrated} sessions migrated`),
        );
      }
      if (sum.plans.copied > 0) {
        lines.push(chalk.hex(colors.success)(`  ✓ ${sum.plans.copied} plan files copied`));
      }
      const migratedKinds: string[] = [];
      if (sum.config.migrated) migratedKinds.push('config');
      if (sum.config.migratedHooks > 0) migratedKinds.push('hooks');
      if (sum.mcp.mergedServers.length > 0) migratedKinds.push('MCP');
      if (sum.userHistory.copied > 0) migratedKinds.push('REPL history');
      if (sum.skills.copied > 0) migratedKinds.push('skills');
      if (migratedKinds.length > 0) {
        lines.push(chalk.hex(colors.success)(`  ✓ ${migratedKinds.join(' · ')}`));
      }
      if (
        sum.sessions.sessionsMigrated === 0 &&
        sum.plans.copied === 0 &&
        migratedKinds.length === 0
      ) {
        lines.push(chalk.hex(colors.textMuted)('  Nothing needed migrating.'));
      }
      if (r.notices.detectedPlugins.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${r.notices.detectedPlugins.length} kimi-cli plugins — not yet supported for migration`,
          ),
        );
      }
      if (r.notices.plansCopiedNotice !== null) {
        lines.push(chalk.hex(colors.textMuted)(`  ⓘ ${r.notices.plansCopiedNotice}`));
      }
      if (sum.config.droppedHooks > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.config.droppedHooks} hooks dropped (incompatible)`,
          ),
        );
      }
      if (sum.config.configConflicts.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.config.configConflicts.length} config conflicts kept yours: ${sum.config.configConflicts.join(' · ')}`,
          ),
        );
      }
      if (sum.config.wroteSiblingDueToConflict) {
        lines.push(
          chalk.hex(colors.warning)(
            '  ⚠ config.toml could not be parsed — review config.migrated-from-kimi-cli.toml',
          ),
        );
        const sc = sum.config.siblingContents;
        const items: string[] = [];
        if (sc.providers.length > 0) {
          items.push(`${sc.providers.length} provider${sc.providers.length === 1 ? '' : 's'}`);
        }
        if (sc.models.length > 0) {
          items.push(`${sc.models.length} model${sc.models.length === 1 ? '' : 's'}`);
        }
        if (sc.hooks > 0) {
          items.push(`${sc.hooks} hook${sc.hooks === 1 ? '' : 's'}`);
        }
        if (items.length > 0) {
          lines.push(chalk.hex(colors.warning)(`     contains: ${items.join(', ')}`));
        }
      }
      if (sum.config.wroteTuiSibling) {
        lines.push(
          chalk.hex(colors.warning)(
            '  ⚠ tui.toml conflicted — review tui.migrated-from-kimi-cli.toml',
          ),
        );
      }
      if (sum.mcp.wroteSiblingDueToConflict) {
        lines.push(
          chalk.hex(colors.warning)(
            '  ⚠ mcp.json unreadable — review mcp.migrated-from-kimi-cli.json',
          ),
        );
      }
      if (r.notices.mcpOauthServersRequiringReauth.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${r.notices.mcpOauthServersRequiringReauth.length} MCP servers need re-authentication`,
          ),
        );
      }
      if (sum.sessions.sessionsFailed.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.sessions.sessionsFailed.length} sessions failed to migrate`,
          ),
        );
      }
      if (sum.sessions.sessionsConflicts.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.sessions.sessionsConflicts.length} sessions skipped (target already occupied)`,
          ),
        );
      }
      if (sum.sessions.sessionsSkippedEmpty > 0) {
        lines.push(
          chalk.hex(colors.textMuted)(
            `  ${sum.sessions.sessionsSkippedEmpty} empty sessions skipped`,
          ),
        );
      }
      lines.push('');
      lines.push(
        chalk.hex(colors.textMuted)(` Old data kept at ${this.opts.sourceHome} — kimi-cli still works.`),
      );
    }
    lines.push('');
    lines.push(chalk.hex(colors.textMuted)(' ⏎ continue to kimi-code'));
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderProgress(width: number): string[] {
    const colors = this.opts.colors ?? currentTheme.palette;
    const spinner = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0];
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Migrating from kimi-cli'),
      '',
    ];
    if (this.progressTotal > 0) {
      lines.push(
        chalk.hex(colors.accent)(`  ${spinner}  `) +
          chalk.hex(colors.text)(
            `Translating sessions…  ${this.progressDone} / ${this.progressTotal}`,
          ),
      );
      lines.push('');
    }
    for (const [key, label] of STEP_LABELS) {
      const status = this.stepStatus.get(key) ?? 'pending';
      const mark =
        status === 'done'
          ? chalk.hex(colors.success)('✓')
          : chalk.hex(colors.textDim)('◐');
      lines.push(`  ${mark} ${chalk.hex(colors.text)(label)}`);
    }
    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderAsk(width: number): string[] {
    const colors = this.opts.colors ?? currentTheme.palette;
    const step = this.currentStep();
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Migrate from kimi-cli'),
      '',
    ];
    if (this.phase === 'ask1') {
      lines.push(chalk.hex(colors.text)(' Found an existing kimi-cli installation:'));
      lines.push(chalk.hex(colors.textMuted)(`   ${summarizePlan(this.opts.plan)}`));
      lines.push('');
    }
    lines.push(chalk.hex(colors.text)(` ${step.title}`));
    lines.push('');
    for (let i = 0; i < step.options.length; i++) {
      const opt = step.options[i]!;
      const isSel = i === this.selectedIndex;
      const pointer = isSel ? '❯' : ' ';
      const labelStyle = isSel ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      lines.push(
        chalk.hex(isSel ? colors.primary : colors.textDim)(`  ${pointer} `) +
          labelStyle(opt.label),
      );
    }
    lines.push('');
    lines.push(
      chalk.hex(colors.textMuted)(
        ` ↑/↓ move · ⏎ select · esc ${this.opts.skipDecisionStep === true ? 'cancel' : 'later'}`,
      ),
    );
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((l) => truncateToWidth(l, width));
  }
}

function formatMigrationFailureReason(error: unknown): string | undefined {
  let reason: string | undefined;
  if (error instanceof Error) {
    reason = error.message !== '' ? error.message : error.name;
  } else if (typeof error === 'string') {
    reason = error;
  } else if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { readonly message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage !== '') {
      reason = maybeMessage;
    }
  }
  if (reason === undefined) {
    switch (typeof error) {
      case 'number':
      case 'boolean':
      case 'bigint':
        reason = `${error}`;
        break;
      case 'symbol':
        reason =
          error.description !== undefined ? `Symbol(${error.description})` : 'Symbol rejection';
        break;
      case 'function':
        reason = error.name !== '' ? `Function ${error.name}` : 'Function rejection';
        break;
      case 'object':
        if (error !== null) reason = 'Object rejection';
        break;
      case 'undefined':
        break;
      case 'string':
        break;
    }
  }
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function summarizePlan(plan: MigrationPlan): string {
  const parts: string[] = [];
  if (plan.totalSessions > 0) parts.push(`${plan.totalSessions} sessions`);
  if (plan.hasConfig) parts.push('config');
  if (plan.hasMcp) parts.push('mcp.json');
  if (plan.hasUserHistory) parts.push('REPL history');
  if (plan.hasSkills) parts.push('skills');
  const scanFailures = plan.sessionScanFailures?.length ?? 0;
  if (scanFailures > 0) parts.push(`${scanFailures} unreadable`);
  return parts.join(' · ');
}

function stepFor(phase: Phase, plan: MigrationPlan): StepDef {
  if (phase === 'ask1') {
    return {
      title: 'Migrate this data to kimi-code?',
      options: [
        { label: 'Migrate now', value: 'now' satisfies Prompt1Choice },
        { label: 'Ask me later', value: 'later' satisfies Prompt1Choice },
        { label: 'Never ask again', value: 'never' satisfies Prompt1Choice },
      ],
    };
  }
  const sessionsLabel =
    plan.totalSessions > 0
      ? `Config + ${plan.totalSessions} sessions`
      : 'Config + all sessions';
  return {
    title: 'Migrate chat sessions too? (they are bulky and slower)',
    options: [
      { label: 'Config only', value: 'config-only' satisfies Prompt2Choice },
      { label: sessionsLabel, value: 'all-sessions' satisfies Prompt2Choice },
    ],
  };
}
