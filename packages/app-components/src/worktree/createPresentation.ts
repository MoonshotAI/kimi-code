import type {
  AppSessionWorktree,
  AppWorktreeSetup,
  AppWorktreeSetupStep,
  AppWorktreeSetupStepKind,
} from '@moonshot-ai/app-core/api';
import { sessionWorktreeCard, type SessionWorktreeCard } from '@moonshot-ai/app-core/lib';

export type CreateTranslate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

export type CreateStepTone = 'pending' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';

export interface CreateStepView {
  key: string;
  kind: AppWorktreeSetupStepKind;
  tone: CreateStepTone;
  label: string;
  command?: string;
  output?: string;
  connected: boolean;
}

export interface CreateBlockView {
  title: string;
  meta: string | null;
  note: string | null;
  steps: CreateStepView[];
  expandable: boolean;
  defaultOpen: boolean;
}

export type CreateCardActionId =
  | 'retry'
  | 'createFromLocal'
  | 'createFromRemote'
  | 'useLocal'
  | 'manage'
  | 'recreate'
  | 'viewOutput'
  | 'stop';

export interface CreateCardAction {
  id: CreateCardActionId;
  label: string;
  primary?: boolean;
}

interface CreateCardViewBase {
  title: string;
  body: string | null;
  files: string[];
  command: string | null;
  output: string | null;
  actions: CreateCardAction[];
}

export interface CreateDecisionCardView extends CreateCardViewBase {
  kind: Exclude<SessionWorktreeCard, 'missing' | 'missingBranchGone'>;
}

export type CreateInvalidCardPhase = 'missing' | 'branchGone' | 'recreating' | 'failed' | 'stopped';

export interface CreateInvalidCardView extends CreateCardViewBase {
  phase: CreateInvalidCardPhase;
}

export type CreateCardView = CreateDecisionCardView | CreateInvalidCardView;

const FETCH_TIMEOUT_SECONDS = 30;

function isRecreateRun(setup: AppWorktreeSetup): boolean {
  return setup.purpose === 'recreate';
}

const FAILURE_TITLE_KEYS: Partial<Record<NonNullable<AppWorktreeSetup['failure']>['kind'], string>> = {
  fetch_failed: 'fetchFailed',
  fetch_timeout: 'fetchTimeout',
  conflict: 'conflict',
};

function blockTitleKey(setup: AppWorktreeSetup): string {
  switch (setup.status) {
    case 'running':
      return 'creating';
    case 'ready':
      return 'created';
    case 'stopped':
      return 'stopped';
    case 'local':
      return 'local';
    case 'failed':
      return (setup.failure === undefined ? undefined : FAILURE_TITLE_KEYS[setup.failure.kind]) ?? 'createFailed';
  }
}

export function createStepLabel(step: AppWorktreeSetupStep, t: CreateTranslate): string {
  const state = step.state === 'failed' && step.timedOut === true ? 'timedOut' : step.state;
  const hasRef = step.ref !== undefined && step.ref.length > 0;
  if (step.kind === 'fetch') {
    return hasRef
      ? t(`worktreeCreate.step.fetch.${state}`, { ref: step.ref })
      : t(`worktreeCreate.step.fetchPlain.${state}`);
  }
  if (step.kind === 'create') {
    return hasRef
      ? t(`worktreeCreate.step.create.${state}`, { ref: step.ref })
      : t(`worktreeCreate.step.createPlain.${state}`);
  }
  return t(`worktreeCreate.step.${step.kind}.${state}`);
}

function staticBlockView(setup: AppWorktreeSetup, t: CreateTranslate): CreateBlockView {
  return {
    title: t(setup.status === 'local' ? 'worktreeCreate.block.local' : 'worktreeCreate.block.created'),
    meta: null,
    note: null,
    steps: [],
    expandable: false,
    defaultOpen: false,
  };
}

export function createBlockView(
  worktree: AppSessionWorktree,
  t: CreateTranslate,
  original?: AppSessionWorktree | null,
): CreateBlockView {
  const setup = worktree.setup;
  if (isRecreateRun(setup)) {
    if (setup.status === 'local' || original === null || original === undefined || isRecreateRun(original.setup)) {
      return staticBlockView(setup, t);
    }
    return createBlockView(original, t);
  }
  const running = setup.status === 'running';
  const steps = setup.steps.map((step, index): CreateStepView => {
    const next = setup.steps[index + 1];
    return {
      key: `${index}:${step.kind}`,
      kind: step.kind,
      tone: step.state,
      label: createStepLabel(step, t),
      ...(step.command === undefined || step.command.length === 0 ? {} : { command: step.command }),
      ...(step.output === undefined || step.output.trim().length === 0 ? {} : { output: step.output.trimEnd() }),
      connected: next !== undefined && next.state !== 'pending',
    };
  });
  const commands = setup.commandsRan + (setup.steps.some((step) => step.state === 'running') ? 1 : 0);
  return {
    title: t(`worktreeCreate.block.${blockTitleKey(setup)}`),
    meta: commands === 0 ? null : t('worktreeCreate.block.commandsRan', { n: commands }, commands),
    note: worktree.includedLocalChanges === true ? t('worktreeCreate.block.includedLocalChanges') : null,
    steps,
    expandable: steps.length > 0,
    defaultOpen: running || setup.status === 'failed',
  };
}

function action(id: CreateCardActionId, label: string): CreateCardAction {
  return { id, label };
}

function withPrimary(actions: CreateCardAction[]): CreateCardAction[] {
  return actions.map((item, index) => (index === actions.length - 1 ? { ...item, primary: true } : item));
}

function failedStepOf(setup: AppWorktreeSetup): AppWorktreeSetupStep | undefined {
  return setup.steps.find((step) => step.state === 'failed') ?? setup.steps.find((step) => step.state === 'stopped');
}

function remoteRefOf(worktree: AppSessionWorktree): string | undefined {
  const setup = worktree.setup;
  return (
    setup.failure?.remoteRef ??
    setup.steps.find((step) => step.kind === 'fetch')?.ref ??
    (worktree.base?.remote === true ? worktree.base.ref : undefined)
  );
}

export function createDecisionCardView(
  worktree: AppSessionWorktree | null | undefined,
  t: CreateTranslate,
): CreateDecisionCardView | null {
  if (worktree === null || worktree === undefined) return null;
  if (createInvalidCardView(worktree, t) !== null) return null;
  const kind = sessionWorktreeCard(worktree);
  if (kind === null || kind === 'missing' || kind === 'missingBranchGone') return null;
  const setup = worktree.setup;
  const branch = setup.request.sourceBranch;
  const retry = action('retry', t('worktreeCreate.action.retry'));
  const useLocal = action('useLocal', t('worktreeCreate.action.useLocal'));
  const createFromLocal = action('createFromLocal', t('worktreeCreate.action.createFromLocal', { branch }));
  const base = { kind, files: [] as string[], command: null, output: null };
  switch (kind) {
    case 'fetchFailed':
      return {
        ...base,
        title: t('worktreeCreate.card.fetchFailedTitle'),
        body: t('worktreeCreate.card.fetchFailedBody'),
        actions: withPrimary([createFromLocal, retry]),
      };
    case 'fetchTimeout':
      return {
        ...base,
        title: t('worktreeCreate.card.fetchTimeoutTitle'),
        body: t('worktreeCreate.card.fetchTimeoutBody', {
          seconds: setup.failure?.timeoutSeconds ?? FETCH_TIMEOUT_SECONDS,
        }),
        actions: withPrimary([createFromLocal, retry]),
      };
    case 'conflict': {
      const ref = remoteRefOf(worktree);
      return {
        ...base,
        title: t('worktreeCreate.card.conflictTitle'),
        body:
          ref === undefined
            ? t('worktreeCreate.card.conflictBodyPlain')
            : t('worktreeCreate.card.conflictBody', { ref }),
        files: setup.failure?.conflictFiles ?? [],
        actions: withPrimary([
          action('createFromRemote', t('worktreeCreate.action.createFromRemote')),
          createFromLocal,
        ]),
      };
    }
    case 'diskFull':
      return {
        ...base,
        title: t('worktreeCreate.card.createFailedTitle'),
        body: t('worktreeCreate.card.diskFullBody'),
        actions: withPrimary([action('manage', t('worktreeCreate.action.manage')), useLocal, retry]),
      };
    case 'createFailed':
      return {
        ...base,
        title: t('worktreeCreate.card.createFailedTitle'),
        body: t('worktreeCreate.card.createFailedBody'),
        actions: withPrimary([useLocal, retry]),
      };
    case 'stopped':
      return {
        ...base,
        title: t('worktreeCreate.card.stoppedTitle'),
        body: t('worktreeCreate.card.stoppedBody'),
        actions: withPrimary(setup.stoppedStep === 'fetch' ? [createFromLocal, retry] : [useLocal, retry]),
      };
  }
}

export function createInvalidCardView(
  worktree: AppSessionWorktree | null | undefined,
  t: CreateTranslate,
): CreateInvalidCardView | null {
  if (worktree === null || worktree === undefined) return null;
  const setup = worktree.setup;
  const branch = worktree.branch;
  const useLocal = action('useLocal', t('worktreeCreate.action.useLocal'));
  const empty = { body: null, files: [] as string[], command: null, output: null };
  if (isRecreateRun(setup)) {
    if (setup.status === 'running') {
      const current = setup.steps.find((step) => step.state === 'running');
      const creating = setup.steps.some((step) => step.kind === 'create' && step.state !== 'pending');
      return {
        ...empty,
        phase: 'recreating',
        title: !creating
          ? t('worktreeCreate.invalid.cleaningTitle')
          : branch === undefined
            ? t('worktreeCreate.invalid.recreatingTitlePlain')
            : t('worktreeCreate.invalid.recreatingTitle', { branch }),
        command: current?.command ?? null,
        actions: [action('stop', t('worktreeCreate.action.stop'))],
      };
    }
    if (setup.status === 'failed' && worktree.path === undefined) {
      const failed = failedStepOf(setup);
      const output = [failed?.command, failed?.output?.trimEnd()].filter((part) => part !== undefined && part.length > 0);
      const diskFull = setup.failure?.kind === 'disk_full';
      return {
        phase: 'failed',
        title: t('worktreeCreate.invalid.failedTitle'),
        body: t(diskFull ? 'worktreeCreate.invalid.diskFullBody' : 'worktreeCreate.invalid.failedBody'),
        files: [],
        command: null,
        output: output.length === 0 ? null : output.join('\n'),
        actions: withPrimary([
          ...(output.length === 0 ? [] : [action('viewOutput', t('worktreeCreate.action.viewOutput'))]),
          ...(diskFull ? [action('manage', t('worktreeCreate.action.manage'))] : []),
          useLocal,
          action('retry', t('worktreeCreate.action.retry')),
        ]),
      };
    }
    if (setup.status === 'stopped' && worktree.path === undefined) {
      return {
        ...empty,
        phase: 'stopped',
        title: t('worktreeCreate.invalid.stoppedTitle'),
        body: t('worktreeCreate.invalid.stoppedBody'),
        actions: withPrimary([useLocal, action('retry', t('worktreeCreate.action.retry'))]),
      };
    }
  }
  const kind = sessionWorktreeCard(worktree);
  if (kind === 'missingBranchGone') {
    return {
      ...empty,
      phase: 'branchGone',
      title: t('worktreeCreate.invalid.missingTitle'),
      body:
        branch === undefined
          ? t('worktreeCreate.invalid.missingBodyPlain')
          : t('worktreeCreate.invalid.branchGoneBody', { branch }),
      actions: withPrimary([useLocal]),
    };
  }
  if (kind === 'missing') {
    return {
      ...empty,
      phase: 'missing',
      title: t('worktreeCreate.invalid.missingTitle'),
      body:
        branch === undefined
          ? t('worktreeCreate.invalid.missingBodyPlain')
          : t('worktreeCreate.invalid.missingBody', { branch }),
      actions: withPrimary([useLocal, action('recreate', t('worktreeCreate.action.recreate'))]),
    };
  }
  return null;
}
