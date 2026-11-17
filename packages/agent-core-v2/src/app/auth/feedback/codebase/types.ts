export interface FeedbackCodebaseFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface FeedbackCodebaseLimitExceeded {
  readonly reason: 'file-count' | 'total-size';
  readonly limit: number;
}

export interface FeedbackCodebaseScanResult {
  readonly root: string;
  readonly files: readonly FeedbackCodebaseFile[];
  readonly fingerprint: string;
  readonly usedGitIgnore: boolean;
  readonly exceedsLimit?: FeedbackCodebaseLimitExceeded;
}
