import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';

export const systemRemovedIdsPayloadSchema = z.object({
  removed_ids: z.array(z.string().min(1)),
});

export type SystemRemovedIdsPayload = z.infer<typeof systemRemovedIdsPayloadSchema>;

const systemMessageBase = {
  type: z.literal('system'),
  ...timelineMessageBase,
  system_id: z.string().min(1),
  at: isoDateTimeSchema.optional(),
};

export const systemMessageSchema = z.discriminatedUnion('subtype', [
  z.object({
    ...systemMessageBase,
    subtype: z.literal('compaction'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('undo'),
    payload: systemRemovedIdsPayloadSchema,
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('clear'),
    payload: systemRemovedIdsPayloadSchema,
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('goal'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('plan.enter'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('plan.exit'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('plan.revision'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('swarm.enter'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('swarm.exit'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('skill'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('notice'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('hook'),
    payload: z.unknown().optional(),
  }),
  z.object({
    ...systemMessageBase,
    subtype: z.literal('interruption'),
    payload: z.unknown().optional(),
  }),
]);

export type SystemMessage = z.infer<typeof systemMessageSchema>;
