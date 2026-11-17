import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

const artexFrameFields = {
  session_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
};

export const artexExplorationUpdatedMessageSchema = z
  .object({
    type: z.literal('artex.exploration.updated'),
    exploration_id: z.number().int().positive().optional(),
    payload: z.unknown(),
  })
  .extend(artexFrameFields);
export type ArtexExplorationUpdatedMessage = z.infer<typeof artexExplorationUpdatedMessageSchema>;

export const artexFindingReportedMessageSchema = z
  .object({
    type: z.literal('artex.finding.reported'),
    exploration_id: z.number().int().positive(),
    payload: z.unknown(),
  })
  .extend(artexFrameFields);
export type ArtexFindingReportedMessage = z.infer<typeof artexFindingReportedMessageSchema>;

export const artexActivityAppendedMessageSchema = z
  .object({
    type: z.literal('artex.activity.appended'),
    exploration_id: z.number().int().positive(),
    payload: z.unknown(),
  })
  .extend(artexFrameFields);
export type ArtexActivityAppendedMessage = z.infer<typeof artexActivityAppendedMessageSchema>;

export const artexTrafficCapturedMessageSchema = z
  .object({
    type: z.literal('artex.traffic.captured'),
    payload: z.unknown(),
  })
  .extend(artexFrameFields);
export type ArtexTrafficCapturedMessage = z.infer<typeof artexTrafficCapturedMessageSchema>;

export type ArtexWsMessage =
  | ArtexExplorationUpdatedMessage
  | ArtexFindingReportedMessage
  | ArtexActivityAppendedMessage
  | ArtexTrafficCapturedMessage;