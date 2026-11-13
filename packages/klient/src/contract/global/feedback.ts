/**
 * `feedbackService` — app-scope `/feedback` submission. Mirrors
 * `agent-core-v2/app/auth/feedback.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

const availabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const submitInputSchema = z.object({
  content: z.string(),
  sessionId: z.string(),
  version: z.string(),
  os: z.string(),
  model: z.string().nullable(),
  contact: z.string().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});

const submitResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), feedbackId: z.number() }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const uploadUrlInputSchema = z.object({
  feedbackId: z.number(),
  filename: z.string(),
  size: z.number(),
  sha256: z.string(),
});

const uploadUrlResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    uploadId: z.number(),
    parts: z.array(
      z.object({
        partNumber: z.number(),
        url: z.string(),
        method: z.string(),
        size: z.number(),
      }),
    ),
  }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const completeInputSchema = z.object({
  uploadId: z.number(),
  parts: z.array(z.object({ partNumber: z.number(), etag: z.string() })),
});

const completeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok') }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

export const feedbackContract = {
  availability: {
    input: z.tuple([z.string().optional()]),
    output: availabilitySchema,
  },
  submit: {
    input: z.tuple([submitInputSchema, z.string().optional()]),
    output: submitResultSchema,
  },
  createUploadUrl: {
    input: z.tuple([uploadUrlInputSchema, z.string().optional()]),
    output: uploadUrlResultSchema,
  },
  completeUpload: {
    input: z.tuple([completeInputSchema, z.string().optional()]),
    output: completeResultSchema,
  },
} satisfies ServiceContract;
