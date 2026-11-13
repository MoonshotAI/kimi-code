import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

const feedbackFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

function feedbackResultSchema<T extends z.ZodRawShape>(ok: z.ZodObject<T>) {
  return z.discriminatedUnion('kind', [ok, feedbackFailureSchema.options[0], feedbackFailureSchema.options[1]]);
}

export const feedbackModelAliasQuerySchema = z.object({
  modelAlias: z.string().optional(),
});

export const feedbackAvailabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  feedbackFailureSchema.options[0],
  feedbackFailureSchema.options[1],
]);

export const feedbackSubmitInputSchema = z.object({
  content: z.string(),
  sessionId: z.string(),
  version: z.string(),
  os: z.string(),
  model: z.string().nullable(),
  contact: z.string().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});

export const feedbackSubmitResultSchema = feedbackResultSchema(
  z.object({ kind: z.literal('ok'), feedbackId: z.number() }),
);

export const feedbackUploadPartSchema = z.object({
  partNumber: z.number(),
  url: z.string(),
  method: z.string(),
  size: z.number(),
});

export const feedbackUploadUrlInputSchema = z.object({
  feedbackId: z.number(),
  filename: z.string(),
  size: z.number(),
  sha256: z.string(),
});

export const feedbackUploadUrlResultSchema = feedbackResultSchema(
  z.object({
    kind: z.literal('ok'),
    uploadId: z.number(),
    parts: z.array(feedbackUploadPartSchema),
  }),
);

export const feedbackCompleteUploadInputSchema = z.object({
  uploadId: z.number(),
  parts: z.array(z.object({ partNumber: z.number(), etag: z.string() })),
});

export const feedbackCompleteResultSchema = feedbackResultSchema(z.object({ kind: z.literal('ok') }));

export type FeedbackAvailability = z.infer<typeof feedbackAvailabilitySchema>;
export type FeedbackSubmitInput = z.infer<typeof feedbackSubmitInputSchema>;
export type FeedbackSubmitResult = z.infer<typeof feedbackSubmitResultSchema>;
export type FeedbackUploadPart = z.infer<typeof feedbackUploadPartSchema>;
export type FeedbackUploadUrlInput = z.infer<typeof feedbackUploadUrlInputSchema>;
export type FeedbackUploadUrlResult = z.infer<typeof feedbackUploadUrlResultSchema>;
export type FeedbackCompleteUploadInput = z.infer<typeof feedbackCompleteUploadInputSchema>;
export type FeedbackCompleteResult = z.infer<typeof feedbackCompleteResultSchema>;

export interface IFeedbackService {
  readonly _serviceBrand: undefined;

  availability(modelAlias?: string): Promise<FeedbackAvailability>;
  submit(input: FeedbackSubmitInput, modelAlias?: string): Promise<FeedbackSubmitResult>;
  createUploadUrl(
    input: FeedbackUploadUrlInput,
    modelAlias?: string,
  ): Promise<FeedbackUploadUrlResult>;
  completeUpload(
    input: FeedbackCompleteUploadInput,
    modelAlias?: string,
  ): Promise<FeedbackCompleteResult>;
}

export const IFeedbackService: ServiceIdentifier<IFeedbackService> =
  createDecorator<IFeedbackService>('feedbackService');
