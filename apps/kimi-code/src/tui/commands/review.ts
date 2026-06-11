import type {
  ReviewIntensity,
  ReviewPlanPreview,
  ReviewStartInput,
  ReviewTarget,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import {
  formatReviewResultMarkdown,
  formatReviewStats,
  isReviewIntensity,
  isReviewScopeChoice,
  REVIEW_INTENSITY_CHOICES,
  REVIEW_SCOPE_CHOICES,
  reviewBaseRefChoice,
  reviewCommitChoice,
  type ReviewChoice,
  type ReviewScopeChoice,
} from '../utils/review-options';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

export async function handleReviewCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  const focus = args.trim() || undefined;
  const scope = await promptReviewScope(host);
  if (scope === undefined) return;

  const target = await resolveReviewTargetFromScope(host, scope);
  if (target === undefined) return;

  const preview = await session.previewReviewTarget(target);
  if (preview.stats.fileCount === 0) {
    host.showStatus('No changes to review.');
    return;
  }
  const previewStatus = host.showTransientStatus(`Reviewing ${formatReviewStats(preview.stats)}.`);

  const intensity = await promptReviewIntensity(host);
  if (intensity === undefined) {
    previewStatus.clear();
    return;
  }
  const plan = intensity === 'standard'
    ? undefined
    : await session.previewReviewPlan({
      target: preview.target,
      intensity,
      focus,
    });
  if (plan !== undefined) {
    const confirmed = await promptReviewPerspectiveConfirmation(host, plan);
    if (!confirmed) {
      previewStatus.clear();
      return;
    }
  }
  previewStatus.clear();

  await startReview(host, {
    target: preview.target,
    intensity,
    focus,
  });
}

async function resolveReviewTargetFromScope(
  host: SlashCommandHost,
  scope: ReviewScopeChoice,
): Promise<ReviewTarget | undefined> {
  const session = host.requireSession();
  switch (scope) {
    case 'working_tree':
      return { scope: 'working_tree' };

    case 'current_branch': {
      const refs = await session.listReviewBaseRefs();
      if (refs.length === 0) {
        host.showError('No branches, tags, or commits available to use as a review base.');
        return undefined;
      }
      const baseRef = await promptChoice(host, {
        title: 'Review against',
        options: refs.map(reviewBaseRefChoice),
        searchable: true,
      });
      return baseRef === undefined ? undefined : { scope: 'current_branch', baseRef };
    }

    case 'ahead_of_upstream':
      return { scope: 'current_branch', baseRef: '@{upstream}' };

    case 'single_commit': {
      const commits = await session.listReviewCommits();
      if (commits.length === 0) {
        host.showError('No commits available to review.');
        return undefined;
      }
      const commit = await promptChoice(host, {
        title: 'Select a commit',
        options: commits.map(reviewCommitChoice),
        searchable: true,
      });
      return commit === undefined ? undefined : { scope: 'single_commit', commit };
    }
  }
}

function promptReviewScope(host: SlashCommandHost): Promise<ReviewScopeChoice | undefined> {
  return promptChoice(host, {
    title: 'What to review',
    options: REVIEW_SCOPE_CHOICES,
    optionSpacing: 'relaxed',
  }).then((value) => {
    if (value === undefined) return undefined;
    return isReviewScopeChoice(value) ? value : undefined;
  });
}

function promptReviewIntensity(host: SlashCommandHost): Promise<ReviewIntensity | undefined> {
  return promptChoice(host, {
    title: 'Review intensity',
    options: REVIEW_INTENSITY_CHOICES,
    optionSpacing: 'relaxed',
  }).then((value) => {
    if (value === undefined) return undefined;
    return isReviewIntensity(value) ? value : undefined;
  });
}

function promptReviewPerspectiveConfirmation(
  host: SlashCommandHost,
  plan: ReviewPlanPreview,
): Promise<boolean> {
  return promptChoice(host, {
    title: 'Review perspectives',
    notice: plan.perspectives.join(' · '),
    options: [
      {
        value: 'start',
        label: 'Start review',
        description: reviewPlanSummary(plan),
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'Return to chat without starting review.',
      },
    ],
    optionSpacing: 'relaxed',
  }).then((value) => value === 'start');
}

async function startReview(
  host: SlashCommandHost,
  input: ReviewStartInput,
): Promise<void> {
  const spinner = host.showProgressSpinner('Reviewing changes…');
  host.state.reviewActive = true;
  try {
    const result = await host.requireSession().startReview(input);
    host.state.reviewActive = false;
    const complete = result.status === 'complete';
    spinner.stop({
      ok: complete,
      label: complete ? 'Review completed.' : 'Review blocked.',
    });
    host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      renderMode: 'markdown',
      content: formatReviewResultMarkdown(result),
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    const reviewEventHandled = host.state.reviewActive === false;
    host.state.reviewActive = false;
    if (message.toLowerCase().includes('aborted')) {
      spinner.stop({ ok: false, label: 'Review cancelled.' });
      return;
    }
    if (reviewEventHandled) {
      spinner.stop({ ok: false, label: 'Review stopped.' });
      return;
    }
    spinner.stop({ ok: false, label: `Review stopped: ${message}` });
    host.showError(`Review stopped: ${message}`);
  }
}

function promptChoice(
  host: SlashCommandHost,
  input: {
    readonly title: string;
    readonly notice?: string;
    readonly options: readonly ReviewChoice[];
    readonly searchable?: boolean;
    readonly optionSpacing?: 'compact' | 'relaxed';
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: input.title,
        notice: input.notice,
        options: input.options.map(toChoiceOption),
        searchable: input.searchable,
        optionSpacing: input.optionSpacing,
        onSelect: (value) => {
          host.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(undefined);
        },
      }),
    );
  });
}

function reviewPlanSummary(plan: ReviewPlanPreview): string {
  const reviewers = `${String(plan.reviewerCount)} ${plan.reviewerCount === 1 ? 'reviewer agent' : 'reviewer agents'}`;
  const parts = [reviewers, `Perspectives: ${plan.perspectives.join('; ')}`];
  if (plan.fileGroups !== undefined && plan.fileGroups.length > 0) {
    parts.push(`${String(plan.fileGroups.length)} file ${plan.fileGroups.length === 1 ? 'group' : 'groups'}`);
  }
  if (plan.reconciliationGroups !== undefined && plan.reconciliationGroups.length > 0) {
    parts.push(`${String(plan.reconciliationGroups.length)} reconciliation ${plan.reconciliationGroups.length === 1 ? 'group' : 'groups'}`);
  }
  return parts.join(' · ');
}

function toChoiceOption(choice: ReviewChoice): ChoiceOption {
  return {
    value: choice.value,
    label: choice.label,
    description: choice.description,
  };
}
