import { join } from 'node:path';

import type { Kaos } from '@moonshot-ai/kaos';

import { anchorHunkHeader, fileDiffForPath, parseUnifiedDiff } from './diff';
import type {
  ReviewCommentSeverity,
  ReviewCommentState,
  ReviewDismissalReason,
  ReviewDiffStats,
  ReviewFinalComment,
  ReviewIntensity,
  ReviewResult,
  ReviewTarget,
} from './types';

export type ReviewDiffSide = 'old' | 'new';

/** Where a comment lives in the diff — a (side, line) pair, never a working-tree line. */
export interface ReviewCommentAnchor {
  readonly path: string;
  readonly side: ReviewDiffSide;
  readonly line: number;
  readonly hunkHeader?: string;
}

export interface ReviewArtifactDismissal {
  readonly reason: ReviewDismissalReason;
  readonly note?: string;
}

export interface ReviewArtifactComment {
  readonly id: string;
  readonly severity: ReviewCommentSeverity;
  readonly title: string;
  readonly body: string;
  readonly evidence?: string;
  readonly suggestedFix?: string;
  readonly anchor: ReviewCommentAnchor;
  readonly state: ReviewCommentState;
  readonly dismissal: ReviewArtifactDismissal | null;
}

/** The on-disk artifact: <sessionDir>/reviews/<timestamp>.json */
export interface ReviewArtifact {
  /** Short ordinal, session-scoped (the id the user types). */
  readonly id: number;
  readonly createdAt: string;
  readonly target: ReviewTarget;
  readonly intensity: ReviewIntensity;
  readonly stats: ReviewDiffStats;
  readonly summary: string;
  readonly comments: readonly ReviewArtifactComment[];
  /** Raw unified diff captured at review time; the browser renders from this. */
  readonly diff: string;
}

export type ReviewArtifactDraft = Omit<ReviewArtifact, 'id'>;

/** Compact, immutable-ish metadata for `/review read` autocomplete and listing. */
export interface ReviewArtifactSummary {
  readonly id: number;
  readonly createdAt: string;
  readonly scope: ReviewTarget['scope'];
  readonly intensity: ReviewIntensity;
  readonly commentCount: number;
  readonly criticalCount: number;
  readonly rejectedCount: number;
}

interface ReviewArtifactIndexEntry extends ReviewArtifactSummary {
  readonly file: string;
}

interface ReviewArtifactIndex {
  readonly version: 1;
  readonly nextId: number;
  readonly entries: readonly ReviewArtifactIndexEntry[];
}

const EMPTY_INDEX: ReviewArtifactIndex = { version: 1, nextId: 1, entries: [] };

/**
 * Build the persisted artifact (minus its id) from a finished review result.
 * Comment anchors are derived in diff space from the captured unified diff.
 */
export function buildReviewArtifact(input: {
  readonly result: ReviewResult;
  readonly createdAt: string;
  readonly diff: string;
}): ReviewArtifactDraft {
  const files = parseUnifiedDiff(input.diff);
  return {
    createdAt: input.createdAt,
    target: input.result.target,
    intensity: input.result.intensity,
    stats: input.result.stats,
    summary: input.result.summary,
    diff: input.diff,
    comments: input.result.comments.map((comment) =>
      toArtifactComment(comment, anchorHunkHeader(fileDiffForPath(files, comment.path), 'new', comment.line)),
    ),
  };
}

function toArtifactComment(
  comment: ReviewFinalComment,
  hunkHeader: string | undefined,
): ReviewArtifactComment {
  return {
    id: comment.id,
    severity: comment.severity,
    title: comment.title,
    body: comment.body,
    evidence: comment.evidence,
    suggestedFix: comment.suggestedFix,
    anchor: { path: comment.path, side: 'new', line: comment.line, hunkHeader },
    state: 'candidate',
    dismissal: null,
  };
}

function summarize(artifact: ReviewArtifact, file: string): ReviewArtifactIndexEntry {
  return {
    id: artifact.id,
    file,
    createdAt: artifact.createdAt,
    scope: artifact.target.scope,
    intensity: artifact.intensity,
    commentCount: artifact.comments.length,
    criticalCount: artifact.comments.filter((c) => c.severity === 'critical').length,
    rejectedCount: artifact.comments.filter((c) => c.state === 'dismissed').length,
  };
}

/** Persists review artifacts as JSON under a session's reviews directory. */
export class ReviewArtifactStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(private readonly kaos: Kaos, sessionDir: string) {
    this.dir = join(sessionDir, 'reviews');
    this.indexPath = join(this.dir, 'index.json');
  }

  async save(draft: ReviewArtifactDraft): Promise<ReviewArtifact> {
    const index = await this.readIndex();
    const id = index.nextId;
    const artifact: ReviewArtifact = { ...draft, id };
    const file = this.uniqueFileName(index, draft.createdAt);
    await this.kaos.mkdir(this.dir, { parents: true, existOk: true });
    await this.kaos.writeText(join(this.dir, file), `${JSON.stringify(artifact, null, 2)}\n`);
    await this.writeIndex({
      version: 1,
      nextId: id + 1,
      entries: [...index.entries, summarize(artifact, file)],
    });
    return artifact;
  }

  async list(): Promise<readonly ReviewArtifactSummary[]> {
    const index = await this.readIndex();
    return [...index.entries]
      .sort((a, b) => a.id - b.id)
      .map(({ file: _file, ...summary }) => summary);
  }

  async read(id: number): Promise<ReviewArtifact | undefined> {
    const index = await this.readIndex();
    const entry = index.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return undefined;
    return this.readArtifactFile(entry.file);
  }

  /** Mark a comment rejected by the user. Idempotent; returns the updated artifact. */
  async rejectComment(
    id: number,
    commentId: string,
    note?: string,
  ): Promise<ReviewArtifact | undefined> {
    return this.mutateComment(id, commentId, (comment) => ({
      ...comment,
      state: 'dismissed',
      dismissal: { reason: 'rejected_by_user', ...(note === undefined ? {} : { note }) },
    }));
  }

  /** Restore a previously rejected comment to active. Returns the updated artifact. */
  async restoreComment(id: number, commentId: string): Promise<ReviewArtifact | undefined> {
    return this.mutateComment(id, commentId, (comment) => ({
      ...comment,
      state: 'candidate',
      dismissal: null,
    }));
  }

  private async mutateComment(
    id: number,
    commentId: string,
    update: (comment: ReviewArtifactComment) => ReviewArtifactComment,
  ): Promise<ReviewArtifact | undefined> {
    const index = await this.readIndex();
    const entry = index.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return undefined;
    const artifact = await this.readArtifactFile(entry.file);
    if (artifact === undefined) return undefined;
    if (!artifact.comments.some((comment) => comment.id === commentId)) return artifact;

    const updated: ReviewArtifact = {
      ...artifact,
      comments: artifact.comments.map((comment) =>
        comment.id === commentId ? update(comment) : comment,
      ),
    };
    await this.kaos.writeText(join(this.dir, entry.file), `${JSON.stringify(updated, null, 2)}\n`);
    await this.writeIndex({
      ...index,
      entries: index.entries.map((candidate) =>
        candidate.id === id ? summarize(updated, entry.file) : candidate,
      ),
    });
    return updated;
  }

  private async readArtifactFile(file: string): Promise<ReviewArtifact | undefined> {
    try {
      return JSON.parse(await this.kaos.readText(join(this.dir, file))) as ReviewArtifact;
    } catch {
      return undefined;
    }
  }

  private async readIndex(): Promise<ReviewArtifactIndex> {
    try {
      const parsed = JSON.parse(await this.kaos.readText(this.indexPath)) as ReviewArtifactIndex;
      if (typeof parsed.nextId !== 'number' || !Array.isArray(parsed.entries)) return EMPTY_INDEX;
      return parsed;
    } catch {
      return EMPTY_INDEX;
    }
  }

  private async writeIndex(index: ReviewArtifactIndex): Promise<void> {
    await this.kaos.mkdir(this.dir, { parents: true, existOk: true });
    await this.kaos.writeText(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  private uniqueFileName(index: ReviewArtifactIndex, createdAt: string): string {
    const slug = timestampSlug(createdAt);
    const taken = new Set(index.entries.map((entry) => entry.file));
    let candidate = `${slug}.json`;
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = `${slug}-${String(counter)}.json`;
      counter += 1;
    }
    return candidate;
  }
}

/** Convert an ISO timestamp to a sortable, filename-safe slug (YYYYMMDD-HHMMSS). */
export function timestampSlug(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'review';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}
