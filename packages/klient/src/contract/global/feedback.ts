/**
 * `feedbackService` — app-scope `/feedback` submission. Schemas live next to
 * the engine types so the HTTP route and this contract do not each restate them.
 */

import { z } from 'zod';
import {
  feedbackAvailabilitySchema,
  feedbackCompleteResultSchema,
  feedbackCompleteUploadInputSchema,
  feedbackSubmitInputSchema,
  feedbackSubmitResultSchema,
  feedbackUploadUrlInputSchema,
  feedbackUploadUrlResultSchema,
} from '@moonshot-ai/agent-core-v2/app/auth/feedback';

import type { ServiceContract } from '../types.js';

const modelAlias = z.string().optional();

export const feedbackContract = {
  availability: {
    input: z.tuple([modelAlias]),
    output: feedbackAvailabilitySchema,
  },
  submit: {
    input: z.tuple([feedbackSubmitInputSchema, modelAlias]),
    output: feedbackSubmitResultSchema,
  },
  createUploadUrl: {
    input: z.tuple([feedbackUploadUrlInputSchema, modelAlias]),
    output: feedbackUploadUrlResultSchema,
  },
  completeUpload: {
    input: z.tuple([feedbackCompleteUploadInputSchema, modelAlias]),
    output: feedbackCompleteResultSchema,
  },
} satisfies ServiceContract;
