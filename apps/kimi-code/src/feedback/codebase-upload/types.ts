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

export interface FeedbackCodebaseArchive {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly fingerprint: string;
  readonly fileCount: number;
}

export interface CreateFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface FeedbackUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface CreateFeedbackUploadUrlResult {
  readonly uploadId: number;
  readonly parts: readonly FeedbackUploadPart[];
}

export interface CompletedUploadPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface CompleteFeedbackUploadUrlInput {
  readonly uploadId: number;
  readonly parts: readonly CompletedUploadPart[];
}

export interface FeedbackUploadUrlApi {
  createUploadUrl(input: CreateFeedbackUploadUrlInput): Promise<CreateFeedbackUploadUrlResult>;
  completeUpload(input: CompleteFeedbackUploadUrlInput): Promise<void>;
}
