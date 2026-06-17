import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ReviewArtifact,
  ReviewIntensity,
  ReviewResult,
  ReviewScopeSummary,
  ReviewStartInput,
  ReviewTarget,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { ReviewReaderFullscreenApp } from '../components/dialogs/review-reader-fullscreen';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import {
  buildReviewArtifactSummaryData,
  buildReviewSummaryData,
  formatReviewArtifactMarkdown,
  formatReviewStats,
  isReviewIntensity,
  isReviewScopeChoice,
  REVIEW_INTENSITY_CHOICES,
  reviewScopeChoices,
  reviewScopeLabel,
  reviewBaseRefChoice,
  reviewCommitChoice,
  reviewCommitStatAlign,
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

  const invocation = parseReviewCommand(args);
  if (invocation.kind === 'read') return handleReviewRead(host, invocation.idArg);
  if (invocation.kind === 'export') return handleReviewExport(host, invocation.idArg);

  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  const focus = invocation.focus;
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

  try {
    const intensity = await promptReviewIntensity(host);
    if (intensity === undefined) return;
    await startReview(host, {
      target: preview.target,
      intensity,
      focus,
    });
  } finally {
    previewStatus.clear();
  }
}

export type ReviewCommandInvocation =
  | { readonly kind: 'read'; readonly idArg: string | undefined }
  | { readonly kind: 'export'; readonly idArg: string | undefined }
  | { readonly kind: 'start'; readonly focus: string | undefined };

/**
 * Parse `/review` arguments. `read`/`export` are only treated as subcommands
 * when followed by at most one token (an id/slug) — so a free-form focus like
 * "read the auth flow" still starts a review instead of being misrouted.
 */
export function parseReviewCommand(args: string): ReviewCommandInvocation {
  const trimmed = args.trim();
  const parts = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const [head, ...rest] = parts;
  if ((head === 'read' || head === 'export') && rest.length <= 1) {
    return { kind: head, idArg: rest[0] };
  }
  return { kind: 'start', focus: trimmed.length > 0 ? trimmed : undefined };
}

async function handleReviewRead(host: SlashCommandHost, idArg: string | undefined): Promise<void> {
  const session = host.requireSession();
  const id = await resolveReviewId(host, idArg, 'Open review');
  if (id === undefined) return;
  const artifact = await session.readReview(id);
  if (artifact === undefined) {
    host.showError(`Review ${String(id)} was not found.`);
    return;
  }
  openReviewReader(host, artifact);
}

async function handleReviewExport(host: SlashCommandHost, idArg: string | undefined): Promise<void> {
  const session = host.requireSession();
  const id = await resolveReviewId(host, idArg, 'Export review');
  if (id === undefined) return;
  const artifact = await session.readReview(id);
  if (artifact === undefined) {
    host.showError(`Review ${String(id)} was not found.`);
    return;
  }
  try {
    const file = await exportReviewArtifact(artifact);
    host.showStatus(`Exported review to ${file}.`);
  } catch (error) {
    host.showError(`Could not export review: ${formatErrorMessage(error)}`);
  }
}

/** Write a review artifact to a unique `review-<slug>.md` file and return its path. */
async function exportReviewArtifact(artifact: ReviewArtifact): Promise<string> {
  const file = uniqueExportPath(artifact.slug);
  await writeFile(file, formatReviewArtifactMarkdown(artifact), 'utf8');
  return file;
}

/** Pick a `review-<slug>.md` path in the cwd that does not already exist. */
function uniqueExportPath(slug: string): string {
  const base = `review-${slug}`;
  let candidate = join(process.cwd(), `${base}.md`);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(process.cwd(), `${base}-${String(counter)}.md`);
    counter += 1;
  }
  return candidate;
}

async function resolveReviewId(
  host: SlashCommandHost,
  idArg: string | undefined,
  title: string,
): Promise<number | undefined> {
  const reviews = await host.requireSession().listReviews();
  if (idArg !== undefined && idArg.length > 0) {
    const bySlug = reviews.find((review) => review.slug === idArg);
    if (bySlug !== undefined) return bySlug.id;
    const parsed = Number(idArg);
    if (Number.isInteger(parsed) && reviews.some((review) => review.id === parsed)) return parsed;
    host.showError(`No review named "${idArg}" in this session.`);
    return undefined;
  }
  if (reviews.length === 0) {
    host.showStatus('No saved reviews in this session yet.');
    return undefined;
  }
  const value = await promptChoice(host, {
    title,
    options: reviews.toReversed().map((review) => ({
      value: String(review.id),
      label: `${review.slug} · ${review.commentCount} ${review.commentCount === 1 ? 'review comment' : 'review comments'}`,
      description: `${reviewScopeLabel(review.scope)} · ${String(review.criticalCount)} critical · ${String(review.rejectedCount)} rejected`,
    })),
    searchable: true,
  });
  return value === undefined ? undefined : Number(value);
}

/** After the user reads/triages a review, show a "browsed" note (rejected comments struck). */
function appendReviewBrowsed(host: SlashCommandHost, artifact: ReviewArtifact): void {
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'review-summary',
    renderMode: 'plain',
    content: artifact.summary,
    reviewSummaryData: { ...buildReviewArtifactSummaryData(artifact), variant: 'browsed' },
  });
}

function reviewMutationCallbacks(host: SlashCommandHost, artifact: ReviewArtifact): {
  onReject: (commentId: string) => Promise<ReviewArtifact | undefined>;
  onRestore: (commentId: string) => Promise<ReviewArtifact | undefined>;
} {
  const session = host.requireSession();
  return {
    onReject: (commentId) => session.rejectReviewComment(artifact.id, commentId),
    onRestore: (commentId) => session.restoreReviewComment(artifact.id, commentId),
  };
}

/** Open the full-screen reader via container swap (saves/restores the UI children). */
function openReviewReader(
  host: SlashCommandHost,
  artifact: ReviewArtifact,
  index = 0,
): void {
  const ui = host.state.ui;
  const saved = [...ui.children];
  const app = new ReviewReaderFullscreenApp({
    artifact,
    initialIndex: index,
    terminal: host.state.terminal,
    ...reviewMutationCallbacks(host, artifact),
    onExport: (current) => exportReviewArtifact(current),
    onClose: (updated) => {
      ui.clear();
      for (const child of saved) ui.addChild(child);
      ui.setFocus(host.state.editor);
      ui.requestRender(true);
      appendReviewBrowsed(host, updated);
    },
    requestRender: () => {
      ui.requestRender();
    },
  });
  ui.clear();
  ui.addChild(app);
  ui.setFocus(app);
  ui.requestRender(true);
}

async function offerReviewFollowUp(host: SlashCommandHost, result: ReviewResult): Promise<void> {
  if (result.reviewId === undefined || result.comments.length === 0) return;
  const reviewId = result.reviewId;
  const handle = result.reviewSlug ?? String(reviewId);
  const statusWord = result.status === 'complete' ? 'complete' : 'blocked';
  const choice = await promptChoice(host, {
    title: `Review ${statusWord}: ${handle}`,
    options: [
      {
        value: 'browse',
        label: 'Browse comments',
        description: `Read each comment next to its code, one at a time. Reopen any time with /review read ${handle}.`,
      },
      {
        value: 'chat',
        label: 'Back to chat',
        description: 'Go back to the conversation to talk about the comments or ask the agent to fix them.',
      },
    ],
    optionSpacing: 'relaxed',
  });
  // Record which follow-up the user took (Esc counts as "back to chat") so we
  // can see how often reviews get browsed vs. discussed in chat.
  host.track('review_followup_choice', { choice: choice === 'browse' ? 'browse' : 'chat' });
  if (choice === 'browse') {
    const artifact = await host.requireSession().readReview(reviewId);
    if (artifact === undefined) {
      host.showError(`Review ${String(reviewId)} could not be opened.`);
      return;
    }
    openReviewReader(host, artifact, 0);
  }
}

async function resolveReviewTargetFromScope(
  host: SlashCommandHost,
  scope: ReviewScopeSelection,
): Promise<ReviewTarget | undefined> {
  const session = host.requireSession();
  switch (scope.value) {
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
      return { scope: 'current_branch', baseRef: scope.upstreamRef ?? '@{upstream}' };

    case 'single_commit': {
      const commits = await session.listReviewCommits();
      if (commits.length === 0) {
        host.showError('No commits available to review.');
        return undefined;
      }
      const statAlign = reviewCommitStatAlign(commits);
      const commit = await promptChoice(host, {
        title: 'Select a commit',
        options: commits.map((entry) => reviewCommitChoice(entry, statAlign)),
        searchable: true,
        scroll: true,
        endHint: 'Showing the 50 most recent commits — refine your search by hash, branch, tag, author, or message.',
      });
      return commit === undefined ? undefined : { scope: 'single_commit', commit };
    }
  }
}

interface ReviewScopeSelection {
  readonly value: ReviewScopeChoice;
  readonly upstreamRef?: string;
}

async function promptReviewScope(host: SlashCommandHost): Promise<ReviewScopeSelection | undefined> {
  const summary = await loadReviewScopeSummary(host);
  return promptChoice(host, {
    title: 'What to review',
    options: reviewScopeChoices(summary),
    optionSpacing: 'relaxed',
  }).then((value) => {
    if (value === undefined) return undefined;
    if (!isReviewScopeChoice(value)) return undefined;
    return {
      value,
      upstreamRef: value === 'ahead_of_upstream' ? summary?.upstream?.upstreamRef : undefined,
    };
  });
}

async function loadReviewScopeSummary(host: SlashCommandHost): Promise<ReviewScopeSummary | undefined> {
  try {
    return await host.requireSession().getReviewScopeSummary();
  } catch {
    return undefined;
  }
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

async function startReview(
  host: SlashCommandHost,
  input: ReviewStartInput,
): Promise<void> {
  // No separate spinner: the ● Reviewing... chrome already indicates progress
  // while a review is active, so a second "Review completed." indicator is noise.
  host.setReviewActive(true);
  host.state.reviewResultPending = true;
  let result: ReviewResult | undefined;
  try {
    result = await host.requireSession().runPilotedReview(input);
    host.setReviewActive(false);
    if (result !== undefined) {
      host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'review-summary',
        renderMode: 'plain',
        content: result.summary,
        reviewSummaryData: buildReviewSummaryData(result),
      });
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    const reviewEventHandled = !host.state.reviewActive;
    host.setReviewActive(false);
    if (message.toLowerCase().includes('aborted')) {
      host.showStatus('Review cancelled.');
    } else if (!reviewEventHandled) {
      host.showError(`Review stopped: ${message}`);
    }
  } finally {
    host.state.reviewResultPending = false;
  }

  // The follow-up runs outside the try/catch so its errors are never
  // misreported as review failures.
  if (result !== undefined) await offerReviewFollowUp(host, result);
}

function promptChoice(
  host: SlashCommandHost,
  input: {
    readonly title: string;
    readonly notice?: string;
    readonly options: readonly ReviewChoice[];
    readonly searchable?: boolean;
    readonly optionSpacing?: 'compact' | 'relaxed';
    readonly scroll?: boolean;
    readonly endHint?: string;
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
        scroll: input.scroll,
        endHint: input.endHint,
        requestRender: () => {
          host.state.ui.requestRender();
        },
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
    searchText: choice.searchText,
    render: choice.render,
  };
}
