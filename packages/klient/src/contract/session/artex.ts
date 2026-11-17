/**
 * Session-scoped ARTEX wire contract — mirrors `IArtexSessionService` on the
 * engine. Payload shapes reuse engine interfaces at the type level; zod uses
 * loose objects so contract parity pins structural drift in `contract-parity.ts`.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const explorationId = z.number().int().positive().optional();
const loose = z.looseObject({});

export const artexSessionStartInputSchema = loose;
export const artexSessionControlInputSchema = loose;
export const artexSessionPatchFindingInputSchema = loose;
export const artexSessionAddGoalInputSchema = loose;
export const artexSessionEditGoalInputSchema = loose;
export const artexSessionDeleteGoalInputSchema = loose;
export const artexSessionSetConstraintsInputSchema = loose;
export const artexSessionAddScopeInputSchema = loose;
export const artexSessionDeleteScopeInputSchema = loose;
export const artexSessionSaveCredentialInputSchema = loose;
export const artexSessionDeleteCredentialInputSchema = loose;
export const artexSessionUntestedAssetsInputSchema = loose;
export const artexSessionIntentControlInputSchema = loose;
export const artexSessionIngestTrafficInputSchema = loose;
export const artexSessionTargetPinsInputSchema = loose;
export const artexSessionRevokePinInputSchema = loose;
export const artexSessionExportReportInputSchema = loose;
export const artexSessionActivityQuerySchema = loose;
export const artexTrafficSearchQuerySchema = loose;

export const artexTrafficBlobWireResultSchema = z.object({
  dataBase64: z.string(),
  total: z.number().int().nonnegative(),
});

export const sessionArtexContract = {
  status: { input: z.tuple([explorationId]), output: loose },
  start: { input: z.tuple([artexSessionStartInputSchema]), output: loose },
  control: { input: z.tuple([artexSessionControlInputSchema]), output: loose },
  graph: { input: z.tuple([explorationId]), output: loose },
  nodeDetail: { input: z.tuple([z.number().int(), explorationId]), output: maybe(loose) },
  activity: { input: z.tuple([artexSessionActivityQuerySchema.optional()]), output: loose },
  findings: { input: z.tuple([explorationId]), output: z.array(loose) },
  patchFinding: { input: z.tuple([artexSessionPatchFindingInputSchema]), output: loose },
  goals: { input: z.tuple([explorationId]), output: z.array(loose) },
  addGoal: { input: z.tuple([artexSessionAddGoalInputSchema]), output: loose },
  editGoal: { input: z.tuple([artexSessionEditGoalInputSchema]), output: loose },
  deleteGoal: { input: z.tuple([artexSessionDeleteGoalInputSchema]), output: loose },
  constraints: { input: z.tuple([explorationId]), output: loose },
  setConstraints: { input: z.tuple([artexSessionSetConstraintsInputSchema]), output: loose },
  scope: { input: z.tuple([explorationId]), output: loose },
  addScope: { input: z.tuple([artexSessionAddScopeInputSchema]), output: loose },
  deleteScope: { input: z.tuple([artexSessionDeleteScopeInputSchema]), output: loose },
  credentials: { input: z.tuple([explorationId]), output: z.array(loose) },
  saveCredential: { input: z.tuple([artexSessionSaveCredentialInputSchema]), output: loose },
  deleteCredential: { input: z.tuple([artexSessionDeleteCredentialInputSchema]), output: loose },
  coverage: { input: z.tuple([explorationId]), output: loose },
  untestedAssets: {
    input: z.tuple([artexSessionUntestedAssetsInputSchema.optional()]),
    output: loose,
  },
  intentControl: { input: z.tuple([artexSessionIntentControlInputSchema]), output: loose },
  trafficHosts: { input: z.tuple([]), output: z.array(loose) },
  trafficSearch: { input: z.tuple([artexTrafficSearchQuerySchema]), output: z.array(loose) },
  trafficExchange: { input: z.tuple([z.string()]), output: maybe(loose) },
  trafficBlob: {
    input: z.tuple([z.string(), z.number().int().nonnegative().optional(), z.number().int().positive().optional()]),
    output: maybe(artexTrafficBlobWireResultSchema),
  },
  ingestTraffic: { input: z.tuple([artexSessionIngestTrafficInputSchema]), output: loose },
  targetPins: { input: z.tuple([artexSessionTargetPinsInputSchema.optional()]), output: z.array(loose) },
  revokeTargetPin: { input: z.tuple([artexSessionRevokePinInputSchema]), output: loose },
  exportReport: { input: z.tuple([artexSessionExportReportInputSchema]), output: loose },
} satisfies ServiceContract;

export const agentArtexModeContract = {
  enter: { input: z.tuple([z.number().int().positive().optional()]), output: noResult },
  exit: { input: z.tuple([z.enum(['user', 'mode-mutex']).optional()]), output: noResult },
  isActive: { input: z.tuple([]), output: z.boolean() },
} satisfies ServiceContract;