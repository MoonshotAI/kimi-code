/**
 * `sessionActivity` — session-level activity and status. Mirrors
 * `agent-core-v2/session/sessionActivity/sessionActivity.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const sessionStatusSchema = z.enum([
  'running',
  'idle',
  'awaiting_approval',
  'awaiting_question',
]);

export const sessionActivityContract = {
  status: { input: z.tuple([]), output: sessionStatusSchema },
  isIdle: { input: z.tuple([]), output: z.boolean() },
} satisfies ServiceContract;
