import type {
  ReviewIntensity,
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
  THOROUGH_REVIEW_PERSPECTIVE_LABELS,
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
  host.showStatus(`Reviewing ${formatReviewStats(preview.stats)}.`);

  const intensity = await promptReviewIntensity(host);
  if (intensity === undefined) return;
  if (intensity === 'deep') {
    host.showNotice(`${intensityLabel(intensity)} review coming soon`, 'Use Standard review for now.');
    return;
  }
  if (intensity === 'thorough') {
    host.showNotice(
      'Thorough review',
      `Focused reviewers: ${THOROUGH_REVIEW_PERSPECTIVE_LABELS.join('; ')}.`,
    );
  }

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
  }).then((value) => {
    if (value === undefined) return undefined;
    return isReviewScopeChoice(value) ? value : undefined;
  });
}

function promptReviewIntensity(host: SlashCommandHost): Promise<ReviewIntensity | undefined> {
  return promptChoice(host, {
    title: 'Review intensity',
    options: REVIEW_INTENSITY_CHOICES,
  }).then((value) => {
    if (value === undefined) return undefined;
    return isReviewIntensity(value) ? value : undefined;
  });
}

async function startReview(
  host: SlashCommandHost,
  input: ReviewStartInput,
): Promise<void> {
  const spinner = host.showProgressSpinner('Reviewing changes…');
  try {
    const result = await host.requireSession().startReview(input);
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
    if (message.toLowerCase().includes('aborted')) {
      spinner.stop({ ok: false, label: 'Review cancelled.' });
      return;
    }
    spinner.stop({ ok: false, label: `Review failed: ${message}` });
    host.showError(`Review failed: ${message}`);
  }
}

function promptChoice(
  host: SlashCommandHost,
  input: {
    readonly title: string;
    readonly options: readonly ReviewChoice[];
    readonly searchable?: boolean;
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: input.title,
        options: input.options.map(toChoiceOption),
        searchable: input.searchable,
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

function toChoiceOption(choice: ReviewChoice): ChoiceOption {
  return {
    value: choice.value,
    label: choice.label,
    description: choice.description,
  };
}

function intensityLabel(intensity: ReviewIntensity): string {
  switch (intensity) {
    case 'standard':
      return 'Standard';
    case 'thorough':
      return 'Thorough';
    case 'deep':
      return 'Deep';
  }
}
